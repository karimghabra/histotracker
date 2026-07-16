# Shared Data Sync — maintainer reference

Living reference for the viewer/workstation sync feature. Read this before any
big update to the main app so you know what is safe to change and what the sync
layer depends on. For the original design rationale and the decisions settled
with the user, see [`shared_data_sync_spec.md`](./shared_data_sync_spec.md);
this document is the "how it actually works + how not to break it" companion.

---

## 1. The one contract that matters

**The synced payload is the raw SQLite database file.** The workstation uploads
its `histometer.db` byte-for-byte; each viewer overwrites its own `histometer.db`
with those bytes. Nothing in between re-serializes the data.

That means the compatibility boundary is **the database schema**, not the app
code. The rule for updates:

- **All running instances must agree on the schema.** A viewer opens a DB file
  the workstation wrote, so if their schemas diverge you get column mismatches.
- **No migration change → fully compatible.** You can rewrite the UI, logic, and
  features freely; you can even run mixed app versions across machines.
- **Migration change → still fine, but roll it out to every machine together**
  (workstation + all viewers) and let the workstation publish once after
  migrating, so viewers pull the upgraded DB. Ship the same build everywhere.

Viewers are *forward*-tolerant (an old viewer opening a newer-schema snapshot
still reads — extra columns are ignored, and viewers never write). They are
**not** backward-tolerant: new UI that queries a column an older snapshot lacks
will break. The only real failure mode is schema drift *between* live instances,
which "deploy everywhere together" eliminates.

### Safe to change (sync is unaffected)
- All UI, components, board layout, styling, hooks
- Business/workflow logic, validation, new features, bug fixes
- The status-workbook columns (`SAMPLE_COLUMNS` / `SLIDE_COLUMNS`) — cosmetic;
  only affects the published `.xlsx`

### Do NOT break (the small sync surface)
- The `stain_requests` table (migration `0014`) and its three helpers
- `getDbFilePath()` and `resetDb()` in `src/lib/db.ts` — the viewer DB swap
  depends on them
- The on-repo JSON shapes: `manifest.json`, `workstation.json`, and the request
  files under `requests/` (see §4)
- `sync-config.json` / `install_id` — these live *outside* the DB, so app
  changes don't touch them, but don't repurpose them either

---

## 2. Roles

| Role | What it does | Writes to repo? | Writes to local DB? |
|------|--------------|-----------------|---------------------|
| **Workstation** | Authoritative bench app. Publishes the snapshot, drains the request inbox. Exactly one per lab (enforced — see §5). | Yes | Yes |
| **Viewer** | Read-only mirror. Pulls snapshots, submits append-only stain requests. | Only request files | No (blocked at the data layer) |

Role is chosen at setup (`SetupScreen.tsx`), defaults to **Viewer**, and is
stored in the local `sync-config.json`.

---

## 3. Transport & auth

- **Transport:** GitHub REST API (Contents API + Releases API) called from Rust
  via `reqwest` (rustls TLS). No git binary, no SSH keys, no local clone.
- **Auth:** one shared **fine-grained personal access token** with
  `Contents: read and write` on the data repo, entered per install and stored in
  the local `sync-config.json`. It is **never** written to `histometer.db` or any
  commit, and the backend never returns it to the frontend (only a redacted
  `SyncConfigPublic`).
- **Trade-off (accepted):** the token is extractable from any machine's config
  file, so every viewer effectively has repo write. This is fine for a trusted
  private lab repo with no PHI. If that changes, revisit "Option B" in the chat
  history (viewers read-only + requests via a channel that doesn't need repo
  write, e.g. GitHub Issues).

---

## 4. Data-repo layout

The data repo (e.g. `karimghabra/Histoarchives`, **private**) stays tiny — the
heavy files are release assets, never committed:

```
manifest.json              # pointer: { version, updated_at, db_asset, workbook_asset }
workstation.json           # single-writer claim: { install_id, operator_name, claimed_at }
requests/<uuid>.json       # transient viewer requests; deleted after the workstation ingests them
```

Release `snapshot-latest` (created automatically on first publish) carries:

```
histometer.db              # the full SQLite snapshot (drives the in-app viewer)
histometer-status.xlsx     # 2-sheet human-readable workbook (Sample Status / Slide Status)
```

`version` is an ISO-8601 UTC timestamp, which sorts chronologically as a plain
string — "newer" is a `>` comparison (`isNewer()` in `githubSync.ts`).

---

## 5. Single-writer enforcement (no accidental second workstation)

Two authoritative workstations would clobber each other's snapshots, so exactly
one is enforced:

1. Each install has a stable `install_id`, generated once in the backend and
   stored in `sync-config.json`.
2. The first machine to choose **Workstation** writes `workstation.json` claiming
   the slot with its `install_id`.
3. Any later install that picks Workstation reads the claim and is **refused**
   (`WorkstationTakenError`) — it can only be a Viewer.
4. `publishSnapshot()` re-checks the claim every cycle, so a demoted machine
   **stops publishing** instead of clobbering.
5. A deliberate **"Replace the current workstation"** checkbox (warned, only
   shown for the Workstation role) overrides the claim when you intentionally
   move the bench machine.

Setup also **defaults to Viewer** so a non-technical user can't drift into the
authoritative role without explicitly choosing it.

---

## 6. Sync cycles

Driven by `useSync.ts` — on mount, every **2 minutes**, and on the manual "Sync
now" button. Overlapping runs are guarded.

- **Workstation:** `drainRequests()` → `publishSnapshot()`
  - `drainRequests` imports each `requests/*.json` into `stain_requests`
    (idempotent on `uuid`) and deletes the file from the repo.
  - `publishSnapshot` verifies the claim, uploads `histometer.db` +
    `histometer-status.xlsx` as overwriting release assets, then writes the
    manifest with a fresh version.
- **Viewer:** `pullSnapshotIfNewer()`
  - Reads the manifest; if `manifest.version` is newer than
    `last_synced_version`, downloads the DB asset and swaps it in (see §7).

React Query is invalidated only when new data actually arrives.

---

## 7. Viewer DB-swap sequence

`pullSnapshotIfNewer()` performs, in order:

1. `getDbFilePath()` — resolve the live SQLite path via
   `PRAGMA database_list` (never hardcode the plugin's storage dir).
2. `resetDb()` — close the pooled connection and drop the memoized promise so
   the file isn't locked.
3. `save_file(dbPath, downloadedBytes)` — overwrite the SQLite file (Rust command).
4. `setLastSyncedVersion(version)` — the next `getDb()` reopens the new file.

**Known limitation:** there is a small window between `resetDb()` and the
overwrite where a background query could reopen the old file. It matches the
spec's sequence and is low-risk for a trusted single-writer setup. If it ever
bites, pause React Query during the swap. The viewer write guard
(`setViewerReadOnly`, §8) is the backstop that keeps this safe.

---

## 8. Security / read-only model

- Token: local only, redacted from the frontend, never in the DB or commits.
- Viewer writes are blocked at the **data layer**: `setViewerReadOnly(true)`
  makes every `db.execute` reject (`src/lib/db.ts`), behind the UI-level gating
  (read-only board, hidden mutation chrome). Reads (`db.select`) still work.
- Safety comes from the repo being **private**, not from field filtering —
  free-text notes/descriptions are synced in full by design (no PHI expected).

---

## 9. File map

**Backend (`src-tauri/`)**
- `src/sync.rs` — all `sync_*` config commands + `github_*` REST commands,
  `install_id` generation, `SyncConfigPublic`.
- `src/lib.rs` — `read_file` / `save_file` commands, migration registration,
  invoke-handler registration.
- `migrations/0014_stain_requests.sql` — the durable request record.
- `Cargo.toml` — `reqwest` (feature `rustls`, **not** `rustls-tls`) + `base64`.

**Frontend (`src/`)**
- `lib/syncConfig.ts` — typed `invoke` wrappers for the config commands + types.
- `lib/githubSync.ts` — `github_*` wrappers; `publishSnapshot`,
  `pullSnapshotIfNewer`, `submitRequest`, `drainRequests`; manifest + claim
  helpers; `isNewer`.
- `lib/export.ts` — `buildStatusWorkbookBytes()` + exported column sets.
- `lib/db.ts` — `stain_requests` queries, `getDbFilePath()`, `resetDb()`,
  `setViewerReadOnly()` write guard.
- `lib/types.ts` — `StainRequest`.
- `hooks/useSync.ts` — the periodic + manual sync loop.
- `hooks/useData.ts` — `useStainRequests`, `useStainRequestMutations`.
- `components/SetupScreen.tsx` — onboarding gate + workstation claim.
- `components/RequestStainDialog.tsx` — viewer request form.
- `components/RequestsInbox.tsx` — workstation inbox / viewer "my requests".
- `App.tsx` — config gate, role-aware chrome, sync-status pill.

---

## 10. Operational runbook

**First-time setup**
1. Create a **separate, private** data repo (e.g. `Histoarchives`).
2. Create a fine-grained PAT: resource owner = your account, repository access =
   only that repo, permission `Contents: Read and write`.
3. Launch the app on the bench machine → choose **Workstation** → enter repo +
   token + name → Connect. First sync auto-creates the `snapshot-latest` release.
4. On each laptop → choose **Viewer** → same repo + token → Connect.

**Rotating the token** — revoke the old one on GitHub, generate a new one (same
scope), re-enter it in each app's setup screen (Token field). Nothing else changes.

**Moving the workstation** — on the new machine, choose Workstation and tick
"Replace the current workstation". The old machine stops publishing on its next
cycle.

**Request lifecycle** — viewer submits → file in `requests/` → workstation drains
it into `stain_requests` (status `requested`) → workstation resolves
(`acknowledged` → `done`/`rejected`) → status rides back down in the next snapshot
so the requester sees it.

---

## 11. Build & verify

```
cd src-tauri && cargo check
pnpm install && pnpm build      # tsc + vite
```

**Linux build deps** (Tauri needs GTK/WebKit system libraries):

```
libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev librsvg2-dev libjavascriptcoregtk-4.1-dev
```

**End-to-end (needs a real token + two running instances):** run one Workstation
and one Viewer against a throwaway private repo. Workstation publishes DB + xlsx
+ manifest; viewer pulls read-only and submits a request; workstation drains it
into the inbox and resolves; status shows back on the viewer. Confirm the token
never lands in `histometer.db` or any commit.

---

## 12. Known limitations / future work

- Viewer DB-swap race window (§7).
- The workstation uploads the full DB every cycle (fine for a small DB; add
  change-detection if it grows).
- Requests require viewer repo-write (Option A). Switch to a read-only-viewer
  model only if the token trade-off becomes unacceptable.
