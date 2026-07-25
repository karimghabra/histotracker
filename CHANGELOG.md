# Changelog

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
