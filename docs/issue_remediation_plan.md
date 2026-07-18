# Histometer — Issue Remediation Plan

Covers the 11 open issues in `karimghabra/histotracker` (as of 2026-07-17).
Each entry is anchored to the real code, states the root cause, the proposed
fix, blast radius, effort, and how it's tested. A runnable regression harness
(`scripts/workflow-test.mjs`) already reproduces the data-layer bugs; see
**Testing strategy** at the end.

Effort key: **S** ≈ <½ day · **M** ≈ ½–1 day · **L** ≈ 1–3 days (data-model or
board-layout changes with downstream ripple).

---

## Suggested sequencing

The issues cluster. Do them in dependency order so shared surfaces (the
processing lane, the extras→staining path) are only reworked once.

1. **Phase 1 — Quick wins (low risk, high visibility):** #2, #3, #1, #6
2. **Phase 2 — Sectioning & processing integrity:** #7, #5 (+ board layout)
3. **Phase 3 — Extras / staining correctness:** #9, #10 (shared code path)
4. **Phase 4 — Batch operations:** #8
5. **Phase 5 — Larger features:** #4 (planned runs), #11 (multi-stain slides)

Phases 3 and 5 change data semantics — land the harness gates for them first.

---

## Phase 1 — Quick wins

### #2 — Default fixative should be Z-Fix · **S** · ✅ fixed (pending QA)
- **Root cause:** `NewSampleDialog.tsx:19` initialises `fixative` to
  `FIXATIVE_OPTIONS[0]`, and `stages.ts:57` orders that list `["PFA", "Z-Fix",
  "Other"]`, so PFA is the default. Schema default is also `'PFA'`
  (`0001_init.sql:20`).
- **Fix:** Make Z-Fix the default. Cleanest: reorder `FIXATIVE_OPTIONS` to
  `["Z-Fix", "PFA", "Other"]` (the `<select>` and the dialog default both follow
  the array). Optionally add a migration flipping the column default for records
  created directly, though all inserts go through `addSample`, which passes an
  explicit value — so the array change alone is sufficient.
- **Risk:** None. **Test:** harness `issue #2` (flip `DEFAULT_FIXATIVE` →
  `"Z-Fix"` there once the dialog default changes, then clear `knownOpen`).

### #3 — "Move to Processor" checklist is unnecessary · **S** · ✅ fixed (pending QA)
- **Root cause:** `BatchStartDialog.tsx:6-10` defines a 3-item required
  `START_CHECKLIST` ("…labels verified", "Processor program verified",
  "Processor load confirmed") and gates **Start Batch** on all being ticked
  (`:143`). The technician is at the processor, not the app, so this ceremony
  adds friction with no operational value.
- **Fix:** Remove the required checklist gate. Keep the operator + start-time
  fields. Decide with the user whether to (a) drop the checklist entirely, or
  (b) keep it as an *optional* informational note. `startProcessingBatch`
  (`db.ts:538-554`) writes these labels into `checklist_items`; if the checklist
  is dropped, pass `checklistLabels: []` (the loop simply no-ops) — no schema
  change needed.
- **Risk:** Low; `checklist_runs`/`checklist_items` rows for the batch just
  become empty. **Test:** manual + existing pipeline invariant still passes.

### #1 — Add multiple samples with the same description · **M** · ✅ fixed (pending QA)
- **Root cause:** Not a DB constraint — `idx_samples_project_code` is unique on
  `(project_id, sample_code)`, and codes are auto-issued
  (`db.ts:186-199`), so identical *descriptions* are already allowed. The
  limitation is purely UI: `NewSampleDialog` creates exactly one sample per
  submit.
- **Fix:** Add a **Quantity** field to `NewSampleDialog`. On save, loop
  `createSample` N times (sequential, so `nextSampleNumber` increments
  correctly). Show the resulting code range (e.g. "EE-0022 – EE-0026"). Wrap the
  N creates in a single undo command (extend `useActions.createSample` or add a
  `createSamples` that records one combined undo) so one Ctrl-Z removes the whole
  batch.
- **Risk:** Low. Watch the undo grouping and the "next code" preview.
- **Test:** harness `issue #1` already proves the data layer stores N identical
  descriptions with distinct codes; add a UI test for the quantity field.

### #6 — Allow processor timings to be edited · **M** · ✅ fixed (pending QA)
- **Root cause:** A batch's `started_at`/`ready_at` are fixed at start
  (`db.ts:511-522`). The block's `processing_started_at` is editable via the
  sample timeline (`stages.ts:43-52` includes `processing_started`), but editing
  it does **not** recompute the batch `ready_at` or the auto-advance
  (`autoAdvanceProcessingRuns`, `db.ts:1448`), so a mistyped start time can't be
  corrected coherently.
- **Fix:** Add a start-time editor to `ProcessingBatchDetailsDrawer`. On save:
  update `processing_batches.started_at`, recompute `ready_at`
  (`processingDurationHours`), and set every member's `processing_started_at` to
  match. Re-run `autoAdvanceProcessingRuns` so a corrected time immediately
  reflects "processed" if already elapsed. Record an undo snapshot of the batch
  members.
- **Risk:** Medium — keep batch, member timestamps, and auto-advance consistent.
- **Test:** new harness case (edit `started_at`, assert `ready_at` recomputes and
  members follow).

---

## Phase 2 — Sectioning & processing integrity

### #7 — Sections cuttable before embedding · **S–M** · ✅ fixed (pending QA)
- **Root cause:** `createSectionRequests` (`db.ts:903`) never checks the block's
  stage, and `SampleDetailsDrawer` exposes the sectioning dialog for any sample
  (`:137`). `SectioningPlanDialog`'s **Send to Sectioning**
  (`SectioningPlanDialog.tsx:164`) therefore works on un-embedded blocks.
- **Fix (defense in depth):**
  1. UI: disable **Send to Sectioning** unless `sample.current_stage ===
     "embedded"` (keep **Save Plan** always available so planning ahead is fine).
  2. Data: guard `createSectionRequests` to reject a sample whose
     `current_stage` is before `embedded` (throw a clear error). This backstops
     drag/other entry points.
- **Risk:** Low. **Test:** harness `issue #7` (calls the real unguarded path on a
  `received` block and asserts zero sections created — fails today).

### #5 — Short/Long runs cannot coincide + board layout · **L** · ◑ overlap guard shipped; board relayout deferred
- **Root cause (correctness):** `startProcessingBatch` (`db.ts:471`) has no
  "processor empty" check — any number of overlapping batches can run.
- **Root cause (layout):** `stages.ts:68-83` lays out Processing and Processor
  Pickup as separate queues; the request asks to condense them (one processor =
  one run) and move Embedded Inventory up, yielding 4 top / 4 bottom windows.
- **Fix (correctness):** Before inserting a batch, reject it if any batch has
  `status = 'processing'` **and** its `ready_at` is after the new `started_at`
  (overlap). Planning a run that begins *after* the current run's `ready_at` is
  allowed (ties into #4). Add the check in `startProcessingBatch`; surface the
  reason in `BatchStartDialog`.
- **Fix (layout):** Rework `BOARD_QUEUES`/`BOARD_LANES` and the `Board.tsx` grid
  (`:421-428`): condense processing + needs-pickup into a single window that
  highlights just the tile for pickup, and relocate Embedded Inventory to the top
  lane. This is the delicate part — the grid `gridTemplateColumns` and
  `min-width` math (`Board.tsx:422-428`) and `SECTION_QUEUE_KEYS`/
  `BLOCK_QUEUE_KEYS` sets must stay consistent.
- **Risk:** High for the layout (drag targets, selection, responsive sizing).
  Do the correctness guard first (shippable alone), layout as a separate PR.
- **Test:** harness `issue #5` (second overlapping batch rejected — fails today);
  layout verified manually + Playwright drag test.

---

## Phase 3 — Extras / staining correctness (shared code path)

### #9 — Extra slides getting stained don't merge cleanly · **L** · ✅ fixed (pending QA)
- **Root cause:** `assignExtraSlideToAssay` (`db.ts:1095-1146`) always **mints a
  brand-new `section_request`** for the slide instead of joining the sample's
  existing open assay section. The staining lane groups by `sample_id`
  (`Board.tsx:87-95, 437-439`), so the extra's separate section is invisible
  there but collides at imaging, where `groupDownstreamSections` merges all of a
  sample's sections into one card — the reported "overwrite at the imaging
  stage."
- **Fix:** When assigning a slide (extra *or* fresh) to an assay, look for an
  existing open assay section for the same sample at a compatible stage
  (`stain_requested`/`stained`) and **re-parent the slide onto it** rather than
  creating a new one; only create a section when none exists. Reconcile
  `depth_index`/`depth_duplicate_ordinal` on the join. Alternatively (larger),
  make one section per sample authoritative for downstream assay work.
- **Risk:** High — touches slide/section identity and every downstream lane.
  Land harness gates first.
- **Test:** harness `issue #9` (asserts exactly one open assay section for the
  sample after staining an extra — currently 2).

### #10 — Undo/redo depopulates the extra-slide inventory · **M–L** · ✅ fixed (pending QA)
- **Root cause (data):** The extra-slide assignment path has **no undo
  command** — `useExtraSlideMutations.assign` (`useData.ts:98-111`) invalidates
  queries but never calls `record(...)`, unlike every mutation in `useActions`.
  Additionally `assignExtraSlideToAssay` re-parents the slide and can leave its
  original section **empty/orphaned** (harness `issue #10`), and section-level
  undo (`restoreSectionRequest`, `db.ts:1421`) restores only
  `section_requests` columns, never the `slides` rows — so undoing around extras
  desynchronises what `listExtraSlides` (`db.ts:1079-1093`,
  `purpose='extra' AND assignment_saved=1 AND current_stage='extra'`) returns.
- **Fix:**
  1. Give extra-slide assignment a proper undo command (snapshot the slide and
     any created section; on undo, restore the slide's `section_request_id`,
     `purpose`, `assignment_saved`, `current_stage` and delete the minted
     section).
  2. Don't leave orphaned empty sections behind (ties to #9's re-parenting fix).
  3. Ensure section undo also restores/deletes the affected `slides` rows.
- **Risk:** Medium–high; interacts with #9. **Test:** harness `issue #10`
  (no orphaned empty section) plus a UI/Playwright undo test (see strategy).

---

## Phase 4 — Batch operations

### #8 — Batch processes need improvement · **L**
- **Reported gaps:** can't batch-section; "Mark Sectioned" only pushes one sample
  into fresh slides; can't batch mark-sectioned; can't batch start-assay; batch
  assay must ensure all tiles have saved slide assignments.
- **Current state:** Sample moves already accept arrays (`moveSamples`,
  `useActions.ts:147`) and section moves too (`moveSections` via `Board.handleEnd`
  `:381-392`), and multi-select exists (`Board.tsx:258-340`). The gaps are:
  - **Batch sectioning plan:** `SectioningPlanDialog` is single-sample
    (`SampleDetailsDrawer.tsx:280`). Add a multi-sample mode that applies one
    plan to every selected embedded block (loop `sendSectionsToCutting`, one undo
    command).
  - **Batch mark-sectioned:** ensure the "sectioned" transition runs for all
    selected sections, not just one (audit the single-sample button path in
    `SectionDetailsDrawer`).
  - **Batch start-assay:** before moving a group to staining, verify every
    section has all slides saved (`assignment_saved = 1`) — mirror the guard in
    `updateSectionStage('stain_requested')` (`db.ts:1277-1285`) across the batch
    and report which tiles are unsaved.
- **Fix:** Extend the dialogs/handlers to operate on the current multi-selection;
  add pre-flight validation (shared protocol for batch-section; saved assignments
  for batch-assay) with a clear "these N tiles aren't ready" message.
- **Risk:** Medium–high (many entry points). Split into batch-section,
  batch-mark-sectioned, batch-assay sub-PRs.
- **Test:** harness cases per sub-flow + Playwright for the selection UX.

---

## Phase 5 — Larger features

### #4 — Planned processing runs + formatting · **L**
- **Root cause:** No "planned" concept. `startProcessingBatch` immediately sets
  `status = 'processing'` and stamps `processing_started_at` (`db.ts:511-536`).
- **Fix:** Add a planned lifecycle:
  1. Schema: `planned_start_at` on `processing_batches` and a `'planned'` status
     (migration).
  2. Flow: "Plan batch" creates a `planned` batch; the tile shows **"PLANNED FOR
     HH:MM TOMORROW / <weekday>"** (`ProcessingBatchRow`). At the planned time,
     prompt the technician to **confirm actual start**; on confirm, transition to
     `processing`, stamp real `started_at`/`processing_started_at`, compute
     `ready_at`, and show the countdown (existing behaviour).
  3. Ties to #5: a planned run that starts after the current run's `ready_at` is
     permitted.
- **Risk:** High (new lifecycle state across Board, drawer, auto-advance).
- **Test:** harness lifecycle cases (planned → confirmed → processing → ready).

### #11 — Multiple stains on a single slide · **L**
- **Root cause:** A slide carries exactly one assay: `slides.assay_type` +
  `slides.assay_name` (single value, `0005_slide_assays.sql`), with a fixed IgG
  control (`slice_count = 2`). `updateSlideAssignment` (`db.ts:1154`) and the
  assay workflow steps (`syncAssayWorkflowStep`, `db.ts:828`) all assume one
  assay per slide.
- **Fix (data model):** Introduce a `slide_assays` join table (slide_id, assay_
  type, assay_name, ordinal, per-assay stage timestamps) and migrate the single
  columns into it. Update: the assignment UI (multi-select assays per slide),
  `listOpenSectionRequests` summaries (`db.ts:973-1027`), the status-workbook
  export (`export.ts` `SLIDE_COLUMNS`/`buildStatusWorkbookBytes`), and the
  imaging/analysis rollups. Keep a compatibility read-path during migration.
- **Risk:** Highest — schema + every slide-facing query + the synced snapshot
  format (viewers must run a matching build; see `docs/shared_data_sync.md`
  §1 compatibility contract).
- **Test:** new harness suite for multi-assay slides end-to-end before touching
  the UI.

---

## Testing strategy

### 1. Data-layer harness — `scripts/workflow-test.mjs` (built, runnable now)
```
node scripts/workflow-test.mjs            # summary
node scripts/workflow-test.mjs --verbose  # also list each PASS
```
- Loads the **real** migrations (`src-tauri/migrations/*.sql`) into an in-memory
  SQLite via Node's built-in `node:sqlite` — the schema can never drift from
  production. The SQL helpers are a faithful port of `src/lib/db.ts`.
- **Invariants** (8): sample-code issuance, the full received→analyzed pipeline,
  single-protocol batches, the preprocessing gate, delete cascade, unique slide
  codes. A failure here is a regression and exits non-zero.
- **Issue reproductions**: #2, #5, #7, #9, #10 fail today by design (each is
  marked `knownOpen`). When a fix lands, clear that issue's `knownOpen` flag and
  the test becomes a hard gate; the runner flags a `knownOpen` test that starts
  passing so nobody forgets to lock it in.
- **As you fix, add** cases for #1 (quantity), #3 (no required checklist), #4
  (planned lifecycle), #6 (edit start time recomputes), #8 (batch flows), #11
  (multi-assay).

### 2. UI harness — Playwright (recommended, not yet built)
Some symptoms live above the data layer and need a driven UI:
- **#10** the exact undo-stack trigger that clears inventory rows,
- **#8** multi-select → batch actions,
- **#5** drag targets after the board relayout,
- **#4** the "confirm actual start" prompt.

Chromium + Playwright are preinstalled in this environment
(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). Scaffold `pnpm tauri dev` against
a seeded temp DB, or drive the built app. Keep these smoke-level (happy path +
the one regression per issue) to stay maintainable.

### 3. Build gates (unchanged)
`cd src-tauri && cargo check` and `pnpm install && pnpm build` must pass before
any release, alongside a green `workflow-test.mjs`.

---

## Compatibility note (shared-data-sync)

Per `docs/shared_data_sync.md` §1, the synced payload **is** the raw SQLite file,
so the schema is the wire format. #4 and #11 add columns/tables — when they ship,
**every** workstation and viewer must run the matching build, and the version
must bump. Additive migrations are safe; destructive ones are not. Non-schema UI
changes (#1, #2, #3, #7 UI, #8) are always compatible.
