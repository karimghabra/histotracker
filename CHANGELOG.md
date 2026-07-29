# Changelog

## 0.7.0 - 2026-07-28

Slide removal, archiving, and a genuinely read-only viewer.

> **Schema change — deploy together.** This release adds two columns to
> `samples` (`slides_issued`, `archived_at`). Both are additive, so existing
> databases, backups and viewer snapshots keep loading, and older images
> converge automatically on open. But the synced payload *is* the SQLite file
> (`docs/shared_data_sync.md` §1), so **every workstation and viewer should be
> updated to this build together.**
>
> This was tested rather than assumed: `scripts/make-legacy-db.mjs` builds a real
> pre-0023 database (migrations 0001–0022, populated with bench-shaped data) and
> `pnpm test:legacy` upgrades it by **both** routes — the plugin-sql migration and
> the runtime `ensureRuntimeSchema()` convergence used when an image is swapped in
> by undo or a sync pull — asserting no rows are lost either way. The same image is
> then opened in the actual running app by `tests/e2e/legacy-db-upgrade.spec.ts`,
> which checks it boots with a clean console, keeps every sample and slide code,
> auto-repairs the merged staining rack, and supports archiving and slide removal.

- **Slides can be removed at any point, and their letters are never reused
  (#73, #83).** Extras can now be deleted from the Extras inventory (select →
  **Remove**), alongside the existing removal from a stack. Letters used to come
  from a live count of the sample's slides, so deleting slide C handed "C" to the
  next cut — which, because slide codes are unique, actually **failed with a
  database error** rather than merely renumbering. Letters now come from a
  high-water mark: delete C and the next slide is E, as intended.
- **Samples can be archived and restored (#74).** In the Logs view, expand a
  sample and choose **Archive** — it asks first, and explains that nothing is
  deleted. Archived samples drop off the board and out of the log by default;
  tick **Show archived** to see them (they carry an *Archived* badge) and
  restore any of them. No numbering changes, and the action is undoable.
- **Viewer mode is properly read-only (#72).** Viewers could previously click
  controls whose writes the data layer then rejected, leaving spinners that
  never resolved. Depth tagging, stain requests, cutting, slide assignment and
  removal, archiving, timeline edits and the sample-panel action bar are now
  simply not offered on a viewer, which still sees cutting plans, timelines and
  existing tags as before.
- **A viewer's own stain requests show up immediately (#71).** A submitted
  request was previously invisible on the requesting machine until the
  workstation drained it, republished, and the viewer pulled the new snapshot —
  up to two sync intervals — and disappeared without trace if any step failed.
  The viewer now remembers its own submissions locally (outside the database
  image, which is replaced wholesale on every pull), so **My requests**
  populates straight away; the local copy is dropped once the real record
  arrives, so nothing is ever listed twice.
- **Drying is no longer a tracked step (#80).** The stain and IHC protocols are
  now *Stained → Coverslipped*, and finishing those two moves the rack to Ready
  for Imaging. Racks that were already part-way through the old three-step
  protocol when this build lands keep their third step so they can be finished
  as expected; only new racks get the shorter protocol.
- **Snapshots record who published them (#77).** `manifest.json` now carries the
  signed-in user (falling back to the workstation's operator name), and the
  viewer's sync status reports "changes by …" after a pull.
- **Idle auto log-out (#76).** After 30 minutes without interaction the signed-in
  user is signed out and prompted to sign back in, so work on a shared bench
  machine isn't attributed to whoever used it last. Mouse *movement* alone does
  not count as activity. You can dismiss the prompt and continue unsigned —
  changes are then recorded as unsigned, as before.

## 0.6.1 - 2026-07-28

Third issue batch — staining-rack separation, plus editing and filtering fixes.
**No schema change:** this release adds no columns or tables, so existing
databases, backups and viewer snapshots keep loading and older builds stay
readable. One automatic data repair runs on first open (see #81).

- **Samples moved into staining no longer merge with an already-stained stack
  (#81).** A rack whose *Stained* box was ticked but which had not yet been
  coverslipped still looked like an open “loading” rack, so newly-moved samples
  were absorbed into it and could not be separated again. The rack is now closed
  to newcomers as soon as any substage is recorded, so a half-finished rack and a
  fresh one coexist. **Existing databases are repaired automatically on first
  open:** slides that were wrongly merged into an already-stained rack are moved
  back out into their own loading rack (one-time, idempotent, no schema change).
- **Stains can no longer be requested from an exhausted block (#70)** when there
  is no extra slide left to fulfil the request — that flag could never be
  cleared. A request an already-cut extra *can* satisfy is still allowed, since
  that slide physically exists regardless of the block being spent. Exhausted
  blocks are now labelled “— exhausted” in the Request-a-stain dialog and the
  request is refused there with the reason, instead of being accepted and then
  quietly going nowhere; the bench drawer shows the reason too.
- **Sample descriptions are editable (#79).** Click the pencil next to
  Description in the sample drawer. The edit is undoable like any other change.
- **Logs list a sample's slides alphabetically (#75)** — A, B, C… — in the table,
  the drill-down, and the CSV/Excel exports. Slide 27 (AA) sorts after Z rather
  than next to A.
- **Ready for Imaging can be filtered by project and by stain (#82).**
- **The active project is now obvious in the sidebar (#84).** The selected
  project gets a strong brand fill, a solid outline, a left accent bar, bold
  text and an **ACTIVE** badge, and the unselected ones are dimmed — so samples
  are much less likely to be created under the wrong project. Checked in the
  light, dark and matcha themes.
- **New “Matcha Tea” theme (#78).**

## 0.6.0 - 2026-07-27

Second issue batch — project moves, easier stain requests, exhaustion visibility,
and depth tagging.

- **Move a sample to a different project (#60).** The sample drawer has a Project
  dropdown; changing it re-numbers the sample under the new project and updates
  its slide labels to match.
- **Request a stain from the Logs view (#64).** Expand a sample and click
  “Request stain for …”. The request dialog opens with the sample already
  selected — and its Sample field is now a dropdown, so no more typing the code.
- **Block exhaustion is shown in the Logs (#65)** — an “Exhausted” badge on the
  sample’s stage — and in exports (#67, a new “Exhausted” column on the Samples
  and Logs exports).
- **Depth tagging (#69).** Select multiple slides in the Logs view and tag them
  as a depth grouping (e.g. “100µm deep”) with a note; the tag shows on each
  slide and is included in exports. **Schema change** (adds `depth_label` /
  `depth_note` to the slides table) — additive, so older data and backups keep
  loading; deploy this build to every workstation and viewer together.

## 0.5.1 - 2026-07-27

- **Tiles can be de-selected (#61).** Click a selected tile again (or un-tick its
  checkbox) to de-select it — and de-selecting now closes the detail panel
  instead of re-opening it.

## 0.5.0 - 2026-07-27

Issue sweep — stain requests, deparaffinization, and several UI fixes.

- **Stain requests now behave correctly (#41/#62/#66).** An embedded block's
  "needs stain" flag and the Send-for-Cutting prefill are driven by a proper
  *outstanding-requests* list: you can request the **same agent twice** (it
  queues two slides), and **re-requesting an agent that was already cut** flags
  the block again and prefills the dialog. Cutting a slide clears exactly the
  request it fulfils. **Existing databases are auto-translated on first open** (a
  one-time reconcile trims already-produced agents), and the change adds no new
  columns — it stays compatible with older builds and backups.
- **Deparaffinization removed (#59).** It was dropped as a tracked protocol step;
  the protocol is back to Stained/IHC → Coverslipped → Dried, and it no longer
  appears in timelines or exports. The database column is retained so older
  data/backups still load.
- **Needs-sectioning tiles show a compact tally (#63)** — e.g. "H&E · 3× Extra"
  instead of repeating "Extra" once per slide.
- **The app now shows its version (#68)** — at the bottom of the sidebar.
- **Undo/redo of the move into Ready for Imaging leaves no ghost tile (#31).**

## 0.4.9 - 2026-07-27

- **Automatic database backups.** The workstation now saves a full backup of the
  database every 3 hours during the working day (defaults to 07:00–19:00, Mon–Fri,
  keeping the newest 48 — all configurable), plus one on launch if a backup is
  overdue. Backups are robust: each is a consistent, checkpointed image, written
  atomically (temp file → flush → rename) and verified, so a crash can never leave
  a half-written backup.
- **Revert to a backup.** A new **Backups** button (next to Manage) opens a panel
  listing every backup with its time and size. “Back up now” takes one on demand;
  “Revert” restores the whole database to that point — and first takes a safety
  backup of the current state, so a revert is itself reversible.
- **Reverting an older backup is safe across updates.** Restoring a backup taken
  by an earlier build runs it through the schema-convergence guard, so any columns
  a newer version added are filled in automatically — no “missing column” errors.
- **Updates stay compatible with existing databases.** Documented and enforced the
  contract: migrations are additive only, and every column the app reads at runtime
  is converged on open. See `docs/shared_data_sync.md` §1a.

## 0.4.8 - 2026-07-26

- **Fixed: clicking the "Deparaffinized" protocol step did nothing** on databases
  that predate 0.4.7 (issue #58). The 0.4.7 schema change adds a column to the
  slides table, but the app swaps the SQLite file out from under itself at
  runtime — undo/redo restore a whole-file image and the sync viewer swaps in a
  downloaded snapshot — and re-opening the file does not re-run migrations. So an
  older image could go live under the new build, the step's write hit a missing
  column and threw, and the checkbox silently stayed unchecked. The app now
  additively converges that column on every database (re)open, and a failed
  protocol step surfaces the error instead of looking like a dead checkbox.

## 0.4.7 - 2026-07-26

- **Deparaffinization is now tracked.** It was a stage that appeared in the
  timelines and exports but was never actually recorded (always blank). It's now
  the first step of the stain/IHC protocol checklist, so it gets a real timestamp
  and shows in order (Deparaffinized → Stained → Coverslipped → Dried) on the
  slide/section/stack timelines and in the exports. **Schema change** (adds
  `stage_deparaffinized_at` to the slides table) — deploy this build to every
  workstation and viewer together (additive, so it's sync-safe).
- **Removed dead/redundant export columns.** The "Refrax" column was always an
  exact duplicate of "Coverslipped" (one step set both) and is dropped. The
  Samples sheet no longer lists slide-level stage columns (Stained, Imaged,
  Analyzed, …) that are never stamped on a block — those live in the Slides and
  Cut Orders sheets.

## 0.4.6 - 2026-07-26

Bug fixes from 0.4.5 testing (issues #55–#57):

- **Section drawer now lists every planned assay slide (#55).** A Needs-Sectioning
  card groups all of a sample's cut groups, but the drawer only showed the first
  group's single slide. It now shows the slides of all the grouped cut groups.
- **Undo after the staining→imaging scatter steps back one stage (#56).** The
  stain-protocol steps weren't recorded as undo snapshots, so undoing after the
  scatter jumped all the way back to Needs Sectioning. Each protocol step (and
  the scatter it triggers) is now undoable — one Undo returns slides to Staining.
- **A viewer stain request now actually drives the workflow (#57).** When the
  workstation drains a request it auto-actions it like a bench request: a block
  with an available extra pulls that extra straight into Staining and the request
  is auto-acknowledged; a block with no extra is flagged ⚑ needs stain with the
  cut prefilled. No manual technician step required for the movement.

## 0.4.5 - 2026-07-25

- **Viewer sync now reflects every workflow stage.** After a viewer pulled a
  snapshot, the app only refreshed a subset of views, so **stain racks, imaging
  stacks, and analyzed rows never appeared on a viewer** even though the data had
  synced. A pull swaps the whole database, so it now refreshes everything.
  Verified with a two-instance harness that walks a block through the entire
  pipeline (pre-processing → analyzed) and checks the viewer at each step.
- **A viewer's stain request is now a formal request.** Instead of only landing
  in the inbox, the workstation drains the request and raises the same request
  its own bench UI does — the block is flagged **⚑ needs stain** (or an existing
  extra is pulled into staining) and that flag streams back to the viewer. The
  viewer's request dialog now picks an agent from the catalog (so the request
  carries its stain/IHC type); an unknown block/agent still falls back to
  inbox-only.

## 0.4.4 - 2026-07-25

Logs rework (GitHub issues #44–#54):

- **Stage column now shows real progress.** Instead of the block's stage (which
  never advances past "Embedded"), each row shows the sample's pipeline phase
  (Pre-processing → Embedded → Sectioned → Staining → Imaging → Analyzed) with an
  `N/M analyzed` progress bar. (#44)
- **Stage filter** — a multi-select of those phases replaces the old
  Active/Analyzed toggle. (#45)
- **Sorting** — new "Updated" (last-activity) column, and the Stage sort now
  follows pipeline order instead of alphabetical. (#46)
- **Assay-type filter** (stain vs IHC) and a slide-count tooltip that breaks down
  assay vs extra slides. (#47)
- **Search** now also matches slide codes, notes, and project name. (#48)
- **Notes indicator** (📝) on rows that carry sample/slide notes. (#49)
- **Date-added range** filter. (#50)
- **Show only matching slides** toggle when a stain filter is active. (#51)
- **Summary bar** (samples / slides / analyzed counts for the current view). (#52)
- **Priority star** shown in the log. (#53)
- **Export to Excel (XLSX)** alongside CSV. (#54)

## 0.4.3 - 2026-07-25

- **Logs "Active" filter fixed.** Active/Analyzed now partition on slide state: a
  sample is *Analyzed* once every one of its assay slides is analyzed (extras are
  ignored, since they never get an analyzed stamp) and *Active* otherwise — so a
  half-finished sample correctly reads as Active.
- **Export the Logs as CSV.** A new "Export CSV" button downloads exactly what's
  on screen (current filter + sort), one row per slide with its sample context
  and timeline stamps (Cut / Stained / Coverslipped / Imaged / Analyzed) plus
  slide and sample notes; slide-less samples still get a row.

## 0.4.2 - 2026-07-25

- **Stack timeline no longer loses the pre-imaging stamps.** When a stain rack
  advances to Ready for Imaging it scatters into a per-sample imaging stack, and
  the new aggregate stack row was only stamped with the imaging stage — so the
  drawer's Stack timeline showed Stained / Coverslipped / Dried as blank even
  though they had happened. The timeline now derives each step from the stack's
  slides (which keep their own stamps through the scatter), falling back to the
  stack row only for stack-only markers like IHC Complete.
- **Logs "Analyzed" filter now works.** It filtered on the block's stage, but a
  block never reaches the analyzed stage — only its slides do. The filter now
  matches samples that have any analyzed slide (and "Active" is the complement).

## 0.4.1 - 2026-07-25

The 0.4.0 tag never produced an installer — its CI build failed at
`pnpm install --frozen-lockfile` because four dev dependencies added for the
Playwright harness (`@playwright/test`, `playwright`, `sql.js`, `@types/sql.js`)
were only written to `package-lock.json`, not `pnpm-lock.yaml`. 0.4.1 syncs the
pnpm lockfile so the release actually builds, and folds in everything intended
for 0.4.0:

- **Image-based undo/redo**: undo now reverts to a previous whole-file SQLite
  image (WAL-checkpointed), and the UI is a pure reflection of the DB. History
  survives reloads (persisted to IndexedDB) and undo never signs you out.
- **Manage dialog**: a tabbed dialog to manage users, projects, and the
  stain/IHC catalog (add / rename / deactivate / delete, where delete is blocked
  when the item is still referenced so prior slide assignments are never lost).
- **Logs page**: a spreadsheet of every sample with filters (project / stain /
  status), sorting, stain search, and per-sample slide drill-down.
- **Separate sample & slide timelines** in the Logs, rendered as even,
  tab-separated columns; the slide timeline is condensed to
  Cut / Stained / Coverslipped / Imaged. Slides are now stamped with a local
  `stage_cut_at` at cut time so "Cut" no longer displays in UTC.
- **Notes** on each sample and each slide, editable from the Logs and undoable.
- **Sectioning rework**: fulfilled plans are archived and cleared on cut (a fresh
  Send-for-Cutting always starts a wholly new plan), and a multi-block cut uses a
  per-block navigator so each block is cut by its own plan.

## 0.3.6 - 2026-07-25

- **Fixed undo/redo corrupting the database** (critical regression in 0.3.5).
  0.3.5's undo copied the raw SQLite *file*, but the app runs in WAL mode, so the
  file snapshot was missing the latest writes (they were still in the `-wal`
  sidecar) — restoring it corrupted the database. Undo/redo now snapshot the
  **logical contents** of every workflow table through the normal connection
  (WAL-safe) and restore them in foreign-key order. No file I/O, no Tauri
  commands, no reopen: undo swaps the DB back, the UI refetches, done. Backed by
  a round-trip regression test (snapshot → destructive churn incl. a cascade
  delete → restore → exact match, with foreign keys enforced).

## 0.3.5 - 2026-07-25

- **Undo/redo reworked to whole-database snapshots** (issue #31, and the class
  behind #29): every action now snapshots the entire SQLite database before its
  write, and undo/redo restore that snapshot wholesale — the UI just refetches.
  This removes the fragile per-row restore logic that could leave ghost tiles
  (e.g. a lingering "needs imaging" tile) or fail to redo. The DB is the single
  source of truth; undo/redo simply move it back or forward.
- **Run planning is now discoverable** (issues #4, #24): the planned-run feature
  worked but was buried behind "Move to Processor" plus an easy-to-miss tab. The
  entry point now reads **"Start / Plan Run"**, so scheduling a future run (with
  its PLANNED FOR tag and confirm-start step) is actually reachable.
- **"Mark Sectioned" counts slides, not stain types** (issue #40): the button
  now shows the number of slides being cut.
- **Requested stains re-flag the block per stain** (issue #41): asking for a new
  stain when no extra is free flags the embedded block for a fresh cut even after
  earlier stains are already in staining, and the Send for Cutting dialog
  prefills the outstanding requested stains.
- **Added a real UI test layer** (vitest + React Testing Library): the actual
  React components are now rendered and asserted in tests (`pnpm test:ui`),
  alongside the existing data-layer harness — so render/interaction regressions
  can no longer pass a type-check unnoticed.

## 0.3.4 - 2026-07-24

- **Sectioning reworked around a "Send for Cutting" step** (issues #35, #36): the
  old editable "sectioning plan" is replaced by a Send for Cutting dialog that
  asks only how many slides to cut and which carry a stain. Pre-selected stains
  prefill it for a one-click send, and the misleading persistent "N slides
  planned" tag is gone from the embedded tile.
- **Pre-assigned slides skip slide assignment** (issues #34, #38): a cut whose
  slides are already assigned goes straight from Needs Sectioning to Staining
  (stains) and Extras (extras) — there is no separate assignment stop. The former
  "Assign Slides" column is now the Extras inventory.
- **Needs Sectioning groups by sample** (issue #33): each sample shows a single
  card aggregating its not-yet-sectioned cut groups, and multi-select /
  select-all work there (issue #37).
- **Requesting a stain now moves the slide into Staining** (issue #39): pulling a
  stain from an available extra sends that slide straight into the staining rack
  instead of leaving it in limbo; it leaves the Extras inventory and appears in
  the Staining lane immediately.
- **Concurrent processor runs, no prompt** (issue #23): starting a second run
  while one is active just works — the "processor busy / Start anyway" override
  prompt is removed entirely.
- **Editable planned-run sample list** (issue #32): a planned run's samples can
  be added or removed from its drawer until it is confirmed.
- Fixed undo/redo of a move into Ready for Imaging leaving a ghost "needs
  imaging" tile behind; the scattered per-sample stacks are now cleaned up on
  undo and recreated on redo (issue #31).
- Verified and locked in the planned processing-run lifecycle end to end with
  new regression gates (issues #4, #24).

## 0.3.3 - 2026-07-24

- **Schema change — every workstation and viewer must update to 0.3.3 together.**
  Migrations 0018/0019 remove section depth and reshape slide stacks (destructive
  for depth data).
- **Removed section depth entirely** (issue #5): the workflow no longer tracks
  cut depth. Slide codes are now per-sample letters (EE-0001-A, -B, …).
- **Cross-sample staining racks**: during staining, slides of the same agent
  group into one cross-sample "rack" that moves through the reagents together
  and never merges with a later rack; leaving staining, slides scatter back into
  their own sample's imaging stack. Staining tiles now show the agent and how
  many samples are in the rack — the groundwork for per-protocol timers.
- **Stains chosen at sample creation** (issue #1): the New Sample screen has a
  checkbox list of the agent catalog. A "needs stain" flag sits on the block
  until each chosen stain enters staining.
- **Auto-planned blocks** (issues #3, #4): a newly embedded block auto-fills its
  sectioning plan — one preassigned slide per chosen stain plus enough extras to
  reach at least four slides with two extras — with assignments pre-saved, so a
  flagged block is a one-click Send to Sectioning → Start Assays. Dialogs still
  open (prefilled, with a "preselected" note) for review.
- **Request a stain** (issue #2): requesting a stain for a sample (from the
  catalog) pulls it from an available extra slide first, or flags the block for
  a fresh cut if none is free.

## 0.3.2 - 2026-07-24

- **Schema change — every workstation and viewer must update to 0.3.2 together.**
  Migration 0017 adds a planned processing-run lifecycle (additive, sync-safe).
- Added planned processing runs: a run can be scheduled for a future start and
  its tile now reads "PLANNED FOR HH:MM · <weekday>" instead of counting up a
  misleading timer. At the planned time the technician confirms the actual start,
  which stamps the real start, computes the ready time, and begins the countdown
  (#4, #24).
- Starting a processor run while another is already active is no longer blocked:
  the batch-start dialog warns and lets the technician start a second run
  simultaneously if they choose (#23).
- Made the processing-batch start time editable from an always-visible "Edit
  start time" button in the batch drawer instead of a hover-only pencil (#30).
- Undoing "start assay workflow" now also removes the slide stack the transition
  created, so tiles no longer linger in the assay stage after the fresh slides
  return (#29).
- Locked in, with a regression test, that a separately-stained extra reaching
  Ready for Imaging merges onto the companion stack so every slide gets its own
  imaging checkbox — the durable-stack rework already made this correct (#14).

## 0.3.1 - 2026-07-18

- Corrected downstream stack identity to sample + physical cut depth + current
  stage. Fresh staining work can no longer pull a companion stack backward
  from imaging, and different cut depths can never share a stack.
- Added forward-arrival merging: companion stacks merge only when the newer
  stack reaches the same stage as an existing sample-depth stack.
- Added migration repair for mixed-depth or mixed-stage stacks created by
  0.3.0, preserving the most advanced group's stack identity.
- Kept multi-stack protocol checklists while filtering stain and IHC batch
  updates to selected stacks that actually contain the matching assay type.

## 0.3.0 - 2026-07-18

- Added durable slide stacks as the owner of downstream staining, imaging, and
  analysis state. Slides retain their cut-group provenance and copied depth.
- Replaced render-time downstream section grouping with stack cards, stack
  selection, a stack drawer, stack-scoped protocols, and stack-level actions.
- Added combined, undoable deletion for selected stacks and selected slides.
- Made section and imaging undo restore slide snapshots, and made batch section
  completion, assay start, and delete act on the complete validated selection
  (#26, #27, #28).
- Rejected backward and skipped drag transitions (#25).
- Reworked the processor pickup indicator into a theme-aware edges-only warning
  treatment (#19).
- Added sample/stack audit context plus explicit undo and redo events as the
  reporting foundation for the future Log and Manifest pages.

## 0.2.6 - 2026-07-18

- Board relayout: the Processor Pickup column is gone; the single Processor
  window now holds both the running run and the run awaiting pickup (flagged by
  its amber tile glow), and Embedded Inventory moved up to the top row — four
  windows on top, four on the bottom (#5, #18).
- The imaging checklist now shows a checkbox for every stain/IHC slide across a
  sample's grouped Ready-for-Imaging sections, so a separately-stained extra is
  no longer missing its checkbox (#14).
- A sectioning plan can now be sent to several selected embedded blocks at once
  as a single action (#8).

## 0.2.5 - 2026-07-18

- Fresh slides saved as "Extra" during assignment no longer appear in the Extra
  inventory until their cut group leaves the Fresh tab (#12).
- The assignment button now reads "Start Assays / Move to Extras" (or "Move to
  Extras" for an all-extras stack), matching what the action actually does (#13).
- Clicking an extras stack in the inventory now highlights it and clears any
  other selection (#15).
- Moving several sections at once now undoes as a single action instead of one
  slide at a time (#16).
- Selecting a processing batch now highlights that batch and clears other
  highlighted tiles (#17).
- A processing batch awaiting pickup now has a clear amber glow (#19).

## 0.2.4 - 2026-07-18

- Fixed a regression from 0.2.3 where the processor could refuse to start any
  batch at all. The one-run-at-a-time guard now judges "busy" from actual
  sample state (samples in the processor) rather than the batch status column,
  which could go stale/orphaned and wedge the processor (#5).
- The processor start-time editor is now available while a batch is awaiting
  pickup too, not only while actively processing, so a misinput can still be
  corrected after the run finishes (#6).

## 0.2.3 - 2026-07-18

- The processor now runs one batch at a time: starting a run that would overlap
  a batch still processing is rejected (a run planned to begin after the current
  one finishes is still allowed) (#5).
- Processing batch start times can be corrected from the batch drawer; the
  expected-ready time and each sample's start stamp recompute automatically,
  and the change is undoable (#6).
- Staining an extra slide now joins the block's existing open stain/IHC section
  instead of spawning a separate one, so companion slides stay together through
  imaging (#9).
- Assigning an extra slide no longer leaves an orphaned, empty section behind,
  and the assignment is now undoable — fixing extras disappearing from the
  inventory on undo (#10).

## 0.2.2 - 2026-07-17

- Default the New Sample fixative to Z-Fix, the most frequently used agent (#2).
- Removed the mandatory processor-load checklist from the batch-start dialog,
  which the technician can't act on while at the processor (#3).
- Added a Quantity field to New Sample so multiple samples with identical
  details can be created at once, each with its own ID, as a single undo (#1).
- Blocked sending a block to sectioning until it reaches Embedded Inventory,
  both in the sectioning dialog and at the data layer (#7).

## 0.2.1 - 2026-07-17

- Fixed a sync failure on the workstation ("TypeError: c.arrayBuffer is not a function") caused by calling the wrong write-excel-file API when building the status workbook. The same fix corrects the manual Excel workbook export.

## 0.2.0 - 2026-07-17

- Added shared data sync: a workstation publishes a database snapshot + status workbook to a private GitHub repo, and viewer installs pull it read-only.
- Added viewer "Request stain" flow with a workstation requests inbox; fulfilling a matching stain auto-acknowledges the request.
- Added single-writer safeguard so only one install can be the authoritative workstation (setup defaults to Viewer).
- Added first-run setup screen and per-install sync configuration (access token stored locally, never in the database or repo).
- Added cloud-built Windows installer via GitHub Actions.

## 0.1.1 - 2026-07-15

- Fixed decalcification workflow ordering so decalc happens after fixation and before ethanol.
- Fixed preprocessing checklist behavior for samples that need decalcification.
- Added grouped extra-slide inventory tiles with filtering, sorting, and right-drawer stain/IHC assignment.
- Added resizable right-side drawers and adjustable board row heights for smaller laptop screens.
- Added per-slide imaging checklists once sections are ready for imaging.
- Added batch completion support for staining, imaging, and analysis workflows.
- Updated downstream staining/IHC tiles so reassigned extra slides stay grouped by sample.
- Improved embedded inventory tile text so saved sectioning plans are visible before sectioning is completed.
