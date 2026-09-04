# Plan — theme customizer, and photos linked to slides

Written 2026-09-04, at the point where the app stopped being a project and
started being a tool the lab uses every day. That changes what "done" means: the
question is no longer "does it work?" but "can it fail in a way somebody only
notices in three months?"

Two features, decided at the bench:

1. **A theme customizer** — pick your own colours rather than one of the 26.
2. **Photos linked to slides** — the images taken at the microscope, attached to
   the glass they came from.

Two decisions were settled before planning, and both narrow the work
considerably:

- **Photos are COPIED into a store the app owns**, not referenced where they sit.
- **Workstation only, for now.** Viewers see that photos exist; they do not get
  the files.

---

## Where the project actually is

- **Zero open issues.** Every issue gate in the harness is a hard check — no
  `knownOpen` flags left.
- 121 harness checks · 77 unit · 123 e2e across 34 spec files · three stress
  harnesses.
- `db.ts` is 5,477 lines; `LogsView.tsx` and `Board.tsx` are ~1,400 each.
- Two structural things remain open and unfixed, both documented: **no
  transaction boundary in `db.ts`** (every read-then-write across an `await` is a
  window), and **mutations report success against rows that do not exist**.

Neither blocks this work. They are listed because "stable and in daily use" is
exactly when they start to matter, and neither is in this plan.

---

## Part 1 — The theme customizer

### What exists

26 themes, each a `:root[data-theme="…"]` block in `index.css` overriding the
same **eleven** variables:

| group | variables |
|---|---|
| chrome | `--color-surface`, `--color-panel`, `--color-line` |
| text | `--color-ink`, `--color-ink-soft`, `--color-ink-faint` |
| accents | `--color-brand`, `--color-brand-strong`, `--color-lane-a`, `--color-lane-b`, `--color-warn` |

The choice lives in `localStorage` under `histometer-theme` — per person, per
machine, never synced. That is the correct home and it is why this feature needs
**no schema change and no migration**: a custom palette is one more thing in the
same box, and it reaches nobody else's screen.

### The work

1. **`THEME_OPTIONS` gains a `custom` entry.** Selecting it applies the saved
   palette by writing the eleven variables onto `:root` as inline styles, which
   override the stylesheet without touching it.
2. **A customizer panel in Settings**, under Appearance: eleven colour inputs
   grouped as above, applied live so you are choosing against the real board
   rather than a swatch.
3. **Seed from an existing theme.** "Start from: Night Shift" copies that
   theme's eleven values in as the starting point. Nobody should begin from
   black, and a lab that wants "our blue instead of that blue" should change one
   value, not eleven.
4. **Persist** as JSON in `localStorage` beside the existing key.
5. **Reset** back to any built-in.

### The part nobody asked for, and why it is in the plan

**A contrast check.** The existing themes are visibly tuned for readability —
`index.css` carries a long note about why removed-row tints are `color-mix`ed
against the theme's own panel instead of a fixed pink, because fixed colours
became "pale-grey text on a bright pink slab" in the dark themes. Hand-picking
eleven colours reproduces that hazard immediately, and the failure is quiet: the
app still works, it is just unreadable at the bench under different lighting.

The customizer computes the WCAG contrast ratio for the pairs that actually carry
information — ink on panel, ink on surface, ink-soft on panel, and surface on
brand-strong — and **warns without blocking**. A lab that wants a low-contrast
theme for a dark room can have one; it just should not get one by accident.

### Optional, cheap, probably worth it

Export and import a palette as a short string, so a theme somebody likes can be
sent to the next machine. Under an hour. Left out of the estimate.

### Testing

Unit tests for the contrast maths and the palette round-trip; an e2e test that
sets a custom palette, reloads, and asserts the variables survive. Both
revert-verified.

**No schema change → no lockstep deploy.** This can ship on its own.

---

## Part 2 — Photos linked to slides

### The constraint that decides the design

`docs/shared_data_sync.md` §1: **the synced payload is the raw SQLite file.** The
workstation uploads `histometer.db` byte-for-byte and each viewer overwrites its
own with those bytes. Backups are the same thing, and so is undo — every mutation
snapshots the entire database image.

That rules out the obvious approach immediately. **Photos cannot live inside the
database.** Undo images the whole DB on every single mutation, so a few hundred
microscope images would mean every click copying gigabytes, and every sync
uploading them again. This is not a tuning problem; it is the wrong shape.

So: **files on disk, and the database holds only the record of them.**

### What does not exist yet

Three prerequisites, all small, all confirmed missing:

- **The app cannot open a file picker.** `src-tauri/capabilities/default.json`
  permits `dialog:allow-save` and not `dialog:allow-open`.
- **There is no filesystem plugin.** File IO goes through the app's own Rust
  commands (`read_file`, `save_file` in `lib.rs`, and the `backup.rs` family).
  The photo store follows that pattern rather than adding `tauri-plugin-fs`.
- **Nothing displays an image.** `csp` is `null` and the asset protocol is not
  configured, so display reads bytes through a Rust command into a blob URL —
  which works with what is already there.

### Schema

One new migration, `0025_slide_photos.sql`, additive:

```sql
CREATE TABLE IF NOT EXISTS slide_photos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slide_id      INTEGER NOT NULL,
    stored_name   TEXT NOT NULL,              -- content hash + extension
    original_name TEXT NOT NULL,              -- what it was called when linked
    byte_size     INTEGER NOT NULL,
    caption       TEXT NOT NULL DEFAULT '',
    linked_at     TEXT NOT NULL,
    linked_by     INTEGER,                    -- users(id), NULL if unsigned
    removed_at    TEXT,                       -- #83: unlinking is a flag
    removed_reason TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (slide_id) REFERENCES slides(id) ON DELETE CASCADE
);
```

**A schema change means a lockstep deploy** — §1 again. The workstation and every
viewer must run the same build, and the workstation publishes once after
migrating. This is the first migration in a while and it needs saying out loud
before the day it happens.

#### The trap worth naming

`ensureRuntimeSchema()` converges **columns** on every database open — that is
what keeps an older backup or a synced image openable under a newer build. It has
no equivalent for **tables**. A new table added by migration simply will not exist
in an image written before it, and the first query against it fails.

There is already a precedent for the fix (`schema_meta` is created with a
`CREATE TABLE IF NOT EXISTS` inside `ensureRuntimeSchema`), and `slide_photos`
must follow it. Without that line, reverting to a backup taken last week breaks
the Logs.

### Storage

- **A `photos/` directory beside the database**, in the app data dir, alongside
  `backups/`.
- **Named by content hash.** Linking the same image twice stores one file, and
  two slides can reference one file without either owning it.
- **Nothing is ever deleted** (#83). Unlinking flags the row with a reason and
  leaves the file. A photo of the wrong slide is still a photo somebody took.

### Rust

Four commands, mirroring `backup.rs` in shape:

| command | does |
|---|---|
| `photo_import(source_path)` | hash, copy into the store atomically (temp + rename, as `backup_write` does), return name and size |
| `photo_read(stored_name)` | bytes, for the blob URL |
| `photo_exists(stored_name)` | so a missing file is a visible state, not a broken image |
| `photo_dir_path()` | for the Settings panel to show where they live |

Plus `dialog:allow-open` in the capability file.

### UI

- **Linking** happens where imaging happens: the slide row in the stack drawer
  once a rack reaches Ready for Imaging, and from the slide's panel in the Logs.
  Multi-select in the picker, since "multiple photos" is the request.
- **Viewing**: thumbnails in the slide panel, click for full size.
- **Captions**, because "which of these four is the one with the lesion" is the
  question somebody will have in a year.
- **A missing file reads as missing** — not as a broken image icon. If the store
  has been moved or a file removed outside the app, the row says so.

### What this deliberately does NOT do

Stated plainly, because both are things somebody could reasonably assume:

- **Viewers do not get the files.** They see the count and an honest "on the
  workstation" note. Making photos sync means a second transport beside the
  database and is a larger piece of work; it is not in this plan.
- **Backups do not include photos.** Today a backup is a raw database image, and
  it will stay that way. A restore is still safe — photo files are not rolled
  back, so the rows still point at real files — but **a disk failure would lose
  the images while the backups survive.** The Backups dialog must say so rather
  than implying cover it does not have.

Both are follow-on work if wanted. Neither should be discovered.

### Open question for later, not now

Large images. If microscope output is tens of megabytes, loading a full file into
a blob URL for a thumbnail will feel slow. Generating a downscaled copy at import
needs an image library in Rust (`image`), which is a real dependency. The plan is
to ship without it, watch it with actual files, and add it if it is needed rather
than because it might be.

### Testing

- **Harness gate** for the schema and every new query, mirrored into the port per
  `CLAUDE.md`, plus an invariant that unlinking flags rather than deletes.
- **Unit** tests for hashing and store-path resolution.
- **e2e**: link two photos, see them, caption one, unlink with a reason and find
  it still recorded, and the missing-file state.
- **Legacy-upgrade test** must be re-run: the new table is exactly the case §1a
  is about.
- Everything revert-verified, as usual.

---

## Sequencing

| | version | why in this order |
|---|---|---|
| 1 | **0.17.0** — theme customizer | No schema change, no lockstep deploy, no risk to data. Ships on its own and gets something in front of the lab while the larger piece is built. |
| 2 | **0.18.0** — slide photos | Schema change ⇒ every machine upgrades together. Wants its own release so the deploy is a deliberate act rather than a side effect. |

Both at the current pace: real changes, tested and revert-verified, each shipped
when it is green rather than batched.

## Verification, unchanged

`pnpm build` · `pnpm test` · `pnpm test:ui` · `cargo check` · the full Playwright
suite from a **cold server** with `--retries=0`, and `legacy-db-upgrade-test`
for 0.18.0 specifically. The reused-dev-server trap has produced false findings
four times in this repo; a cold run is the only one that counts before a push.
