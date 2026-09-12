# Histometer — Issue Remediation Plan

> ## ⚠️ AUDIT CORRECTION — 2026-08-01
>
> An adversarial re-audit of everything marked "✅ fixed" below (two independent
> passes per issue, the second tasked with breaking the first) found that **most
> of these fixes do not actually work**. Of 16 audited: **3 genuinely resolved**
> (#70, #78, #83), **3 partial** (#75, #82, #84), **10 not resolved**.
>
> Treat every "✅ fixed" claim in the sections below as UNVERIFIED unless it
> appears in the resolved list above. The failures shared one shape — a narrow
> patch at one call site while the underlying invariant stayed unenforced:
>
> - **#73** `deleteSlide()` freezes the slide-letter high-water mark, but
>   `deleteSlidesForStack()` and `deleteSectionRequest()` do not. On a database
>   upgraded from 0.6.x, deleting a stain rack reuses a burnt letter →
>   `UNIQUE constraint failed` → a phantom cut group whose card can never be
>   opened → and no undo, though the dialog promises one.
> - **#81** there are **two** "Stained" checkboxes. The rack one was fixed; the
>   section one (`SectionDetailsDrawer` → `syncAssayWorkflowStep`) writes to
>   `slides`/`section_requests` and never touches `slide_stacks`, so the rack
>   stays open and still absorbs the next sample — the reporter's bug verbatim.
> - **#79** the drawer keeps draft state across a sample switch, so editing
>   EE-1's description then clicking EE-2 and saving writes it onto **EE-2**.
>   The fix for wrong descriptions now creates them.
> - **#72** read-only gating is per-component opt-in, and a miss fails silently.
> - **#74** `archived_at` is honoured by `listOpenSamples` only, so an archived
>   block's cut group, extras and rack stay on the board.
> - **#80** only the new-checklist labels were shortened; the editable Dried
>   timeline row, both export columns, and legacy 3-item checklist runs remain.
>
> **Why the test suite did not catch this**, which matters more than any single
> bug:
> 1. `CLAUDE.md` requires mirroring `db.ts` changes into
>    `scripts/workflow-test.mjs`. `deleteSlidesForStack`, `deleteSectionRequest`,
>    `ensureSlidesForSectionRequest` and `syncAssayWorkflowStep` were never
>    mirrored — which is exactly why #73 and #81 shipped green.
> 2. Playwright does **not** run in CI (`.github/workflows/test.yml` runs only
>    the harness), so every Playwright-only fix has zero enforced coverage.
> 3. Two tests were vacuous: the #72 depth-tag case seeds zero slides so the
>    control it "proves" absent could never render, and the #82 filter case puts
>    both samples in one project so the filtered count equals the unfiltered one.
>
> A fix is not done until a test has been observed to FAIL without it.


## 0.16.0 — bench feedback on 0.15, and #134

### #131 — an empty stage was showing every project

Reported after using 0.15: "if no samples or slides from the selected project are
in a particular stage, that stage simply shows all projects. instead, it should
show nothing."

Each column's `<select>` offered only the projects that column currently held,
and a guard reset the filter to "all" the moment the selection fell off that
list. So selecting a project and looking at a stage with none of its work handed
you everyone else's — the opposite of filtering.

**The guard was right about the hazard and wrong about the trigger.** A
controlled `<select>` whose value is not among its options does not go blank:
react-dom re-selects the first option and fires no change event, so the control
and the state disagree silently (#85). Keeping an option for the CURRENT value
closes that directly, and an empty column is then free to render empty. The reset
now fires only for a project that no longer EXISTS — deleted or deactivated —
which is the case the guard was written for.

Two older specs asserted the behaviour being removed and were rewritten rather
than deleted, because what they were really protecting still holds: `#85` and
`#89` now assert that an empty column NAMES the project it is empty of, and that
clearing the filter by hand brings the other work back. A column that is empty
while its control reads "All Projects" remains the thing neither may do.

**I had already met this and missed it.** During 0.15.0's own testing a column
read "all" where I expected a project; I wrote around it in the test instead of
recognising the defect. The lesson is the same one 0.15.1 taught: an assertion
you have to weaken to make pass is evidence, not an obstacle.

### #129 — a sort, not a filter

0.15.0 shipped both. A block that owes a cut is a priority, not a category, and
hiding the drawer's other contents to find the urgent ones costs the context of
what else is in there. The filter is gone and its absence is asserted.

### #131 — the sidebar control

"It almost looks like 'ALL' is a project of its own." It was: the first version
copied the project row exactly, badge and count pill included. It is a control
that clears a filter, and now looks like one — icon, single line, plain count, a
rule separating it from the list it acts on.

### #134 — Short ⇄ Long before the processor

`setSamplesProcessingType(ids, type)` switches blocks in bulk, skipping any that
are past pre-processing rather than refusing the whole call. Every switch writes
a timeline event naming both ends: the duration a block was processed for is part
of its record.

**One guard the issue does not ask for.** A block committed to a PLANNED batch is
still in pre-processing, so the stage rule alone lets it through — and a planned
batch carries its own `processing_type`, checked when the batch is formed and
never again. `confirmProcessingBatchStart` stamps the ready time from the BATCH,
so switching a member would process it for a duration it no longer has, silently.
Refused, naming the block.

---

## 0.15.0 — #129, #131, #132, #133

### #132 before #131, deliberately

The two are one change seen from opposite sides. The sidebar selection meant two
unrelated things at once — which project you are looking at, and where new
samples get filed — and it could only be made to mean one of them cleanly after
the other had somewhere else to live. So #132 (the dialog asks) lands first, and
#131 (the selection filters) lands on top of it.

**#132.** `NewSampleDialog` takes `projects` + `initialProjectId` instead of a
single `project`, and asks. Nothing is preselected when there is a real choice:
a prefilled picker is one Enter away from being no question at all, and the harm
it prevents — a batch of twenty filed under the wrong project, noticed weeks
later — is the same harm #84 was about. A single-project lab is not asked.

**#131.** The sidebar gains an **All projects** row and the selection sets every
column's project filter. It *sets* rather than replaces, so the per-column
controls still work and still say what the board is doing.

`null` used to mean two things in `App.tsx` — "nothing restored yet" and "no
project" — which was harmless while every session had to land on some project.
Now that null is choosable it is stored explicitly (`ALL_PROJECTS`), with a
separate `projectRestored` flag for the other meaning. Without that separation,
choosing All Projects snapped back to the first project on the next render.

### The bug this introduced, and why the first test missed it

The six column filters are **not one kind of thing**. Four match `project_id`;
Extras and Ready for Imaging match `project_code`. The first version set all six
from the id, so the two code-matched columns were handed a number that no code
can equal and rendered **empty for every selection**.

The #131 spec did not catch it — it only looked at Pre-processing, a project_id
column. `sync.spec.ts` caught it. The spec now checks one column of each kind,
through cards on screen rather than through the control, because a column with
nothing in it legitimately resets its own filter to "all" (#85's stale-filter
guard) and therefore proves nothing either way.

### #129 — one predicate, not two

The `needs cut` flag has been on the card since #110; nothing could sort or
filter on it. `sampleNeedsCut()` now lives in `db.ts` — next to
`parsePreselectedStains`, which it needs, and which `stages.ts` cannot import
without a cycle — and the card, the sort and the filter all call it. Two copies
would be two answers, and a filter that hides a flagged card is worse than no
filter.

### #133 — scoped to what the issue names

Removal and stain reassignment, both hung off the tick list that was already
there for tagging. They act on the **live** slides in the selection, matching how
tagging already behaves (#69): eleven ticked slides with one broken should do the
ten, not refuse all eleven.

"Anything that can be done in the dashboard should be completable in the logs" is
a direction, not a change. The rest of it should be argued one action at a time.

### Cost to the existing suite

A dozen specs assumed the sidebar decided where a sample was filed, and that the
board showed every project. Both assumptions were the thing being removed, so
they are updated rather than worked around, and the New Sample flow now goes
through `openNewSample()` in `tests/helpers/app.ts` — one helper, for the same
reason `helpers/rack.ts` exists.

One locator needed scoping for an unrelated reason: `getByText(/needs cut/i)` now
matches the two new #129 controls as well as the flag they act on.

## 0.14.4 — the two issues that shipped with no test, and a finding that did not survive

`#121`–`#128` all shipped in 0.14.0–0.14.3, and six of them carry gates. **Two
did not: #121 and #122.** Both are pure screen changes — a control deleted and a
block of markup moved — and both were verified by reading the JSX, which is the
same standard the audit banner above already recorded as insufficient. They are
covered now, in `tests/e2e/issues-121-122.spec.ts`, and both were watched failing
with their change undone before being trusted.

The #121 test needs a note. It asserts an ABSENCE, which passes just as happily
when the panel never rendered, so the slide panel is proved open first and only
then is the missing control asserted. It also checks that
`relabelSlideToSample` is still exported: #121 removed the affordance and
deliberately kept the capability, so a "fix" that deleted the function would
otherwise satisfy the test while doing the wrong thing.

### A suspected defect in #125, investigated and RETRACTED

While writing the above I reported that a stain requested against a `sectioned`
cut group asks for a recut it does not need — the group has been cut, it can hold
free extras, and `requestStainForSample` still flags the block. It is not a
defect, and the way it fell apart is the useful part.

**The stage order is the answer.** `SECTION_STAGES` runs `needs_sectioning` (0),
`sectioned` (1), `assignment_required` (2), `stain_requested` (3). `sectioned`
comes *before* assignment, so a slide labelled "extra" at that stage has been cut
but not yet dispositioned — nobody has said which slide is a stain and which is
spare. The three excluded stages are exactly the ones before `stain_requested`,
which makes the filter one rule, not three special cases: **an extra is not
inventory until its group's disposition is settled.**

Two experiments, both run:

1. Rewriting the filter to ask `stage_cut_at IS NOT NULL` — "has this glass been
   cut?" — makes the suspected case pass and **breaks issue #12**, which exists
   precisely to keep provisional extras out of the inventory.
2. Removing the three stages one at a time says which carry weight. Without
   `needs_sectioning`, three checks fail. Without `assignment_required`, #12
   fails. Without **`sectioned`, nothing fails at all** — it is unreachable from
   either direction: a legacy group never holds slides at
   `current_stage = 'extra'` (assignment set them to `'cut'`), and a modern group
   never reaches that stage.

**How the false finding was manufactured**, since the next one will be built the
same way: the probe advanced a MODERN pre-assigned cut group into a LEGACY
pre-assignment stage. No build has ever written that combination. The state
looked like a defect because it was incoherent, not because the app was wrong.
The first version of the probe was worse still — it planted the stage with a raw
`UPDATE`, producing a group that claimed to be cut while its slides carried no
cut date.

**No migration is needed, and none should be written.** The behaviour is correct
for every state any build can produce, so there is nothing to translate.

A guard for the unreachable case was written and then deleted: it could not be
made to fail, the same as `rack-numbers-are-unique` in 0.14.3. What replaces it
is an invariant that names the disposition rule and reads the stage order out of
`src/lib/stages.ts` rather than retyping it — revert-verified by dropping
`needs_sectioning` from the filter and watching it fail.

### A correction to the audit banner above

Point 2 — "Playwright does not run in CI" — is no longer true.
`.github/workflows/test.yml` runs `pnpm exec playwright test` on every push, so
the new spec is enforced rather than merely present. Left in place above because
it was true when written, and the banner is a record.

---

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

### #5 — Short/Long runs cannot coincide + board layout · **L** · ✅ overlap guard + board relayout shipped
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

---

## Follow-up issues (#12–#19)

A second wave of issues filed after the first pass. Status as of 0.2.5:

- **#12 — Fresh extras surface in inventory too early · ✅ fixed.**
  `listExtraSlides` now also requires the section to have left the Fresh/
  assignment stage (`current_stage NOT IN needs_sectioning/sectioned/
  assignment_required`). Harness gate: `issue #12`.
- **#13 — "Start Assays" button label · ✅ fixed.** `SectionDetailsDrawer`
  labels the move "Start Assays / Move to Extras" (or "Move to Extras" when the
  stack is all extras) based on the slide mix.
- **#14 — Extra slide doesn't merge cleanly in Ready for Imaging · ✅ fixed.**
  When a sample already has a section at `ready_for_imaging` and a separately
  stained extra arrives, the grouped card shows the extra but the imaging
  checklist (derived from one section's slides) doesn't add a checkbox. Needs
  the imaging view to aggregate slides across a sample's grouped
  ready-for-imaging sections. Related to #9; UI-layer, best done with a driven
  UI test.
- **#15 — Extras stack selection highlight · ✅ fixed.** `ExtraSlideInventory`
  takes `selectedSampleId`; `Board` clears other selection on click.
- **#16 — Batch move undo · ✅ fixed.** New `moveSections` records one combined
  undo; `App` uses it for `onMoveSections`.
- **#17 — Batch selection highlight · ✅ fixed.** `ProcessingBatchRow` takes
  `selected`; `Board` coordinates single-selection across blocks/sections/
  batches/extras.
- **#18 — Remove Processor Pickup window, move Embedded Inventory to top-right ·
  ✅ fixed.** Board relayout — same high-risk surface as #5's deferred layout.
  Do the two together with a UI/Playwright check.
- **#19 — Amber glow for a batch awaiting pickup · ✅ fixed.**
  `ProcessingBatchRow` awaiting-pickup style strengthened to a clear glow.

UI-only fixes (#13, #15, #17, #19) and the undo fix (#16) are validated by
type-check + code review; the data-layer fix (#12) has a harness gate.

> **Status correction (2026-07-28):** this section used to say #14 and #18 were
> still open, alongside #4, #8, #11 and #5's deferred board layout. All of those
> are now **closed** on GitHub — the text was stale. Verified with
> `gh issue view`; the only outstanding issues were #70–#84, covered below.

---

## #136–#137 — what the log could not tell you — 0.18.0, unreleased

Both fixed. One schema change: `samples.embedding_notes`, added at runtime with
no numbered migration.

### #137 — Embedding Notes

**Reported:** "Embedding Notes. During sample creation add a box for embedding
notes."

**Root cause:** there was no such field. How a specimen is to be embedded —
which face down, which end proximal, whether it is bisected — is decided at
intake and read at the embedding station, one station *before* the microtome.
The only places to write it were Sectioning / Cut Notes, which is read one
station too late, and General Notes, where it is buried.

**Fix:** `samples.embedding_notes TEXT NOT NULL DEFAULT ''`, added by
`ensureRuntimeSchema()` alone. It has no numbered migration: a migration would
leave the build in use unable to open the database, and would re-run on top of
the converged column after a backup revert, so the database would not open at the
next launch (https://github.com/karimghabra/histotracker/pull/138).
The second hazard is gone in 0.18.0, which migrates a backup or a pulled snapshot before swapping it in (`swapInImageFromElsewhere`, `docs/shared_data_sync.md` §1a); the first still stands.
A box in
`NewSampleDialog` (one note for a batch, or one per sample); read-back in the
board drawer, `SAMPLE_COLUMNS` and the Logs CSV/XLSX. In the expanded Logs row
it is no longer read-back but an editor: all four of a sample's notes are
correctable there, through `SAMPLE_NOTES` (`src/lib/sampleNotes.ts`) and the
single-column `setSampleNote`, which is the same shape #79 settled on for the
description.
Undo restores whole database images, so undoing an edit restores the note with
everything else. (On master before the 0.18.0 reconciliation it was also listed
in `RESTORE_COLUMNS`, which the release line had already deleted as unused;
see `docs/release_line_reconciliation.md`.)

**Coverage:** `npm run test:legacy` asserts the column DIRECTLY on the populated
pre-0023 fixture, by every route an update arrives — launch, a swapped-in image,
and PATH C, which models the real migrator (its record kept in the file) through
upgrade, revert to the build in use's backup, and relaunch, and checks that the
build in use can still open the upgraded file. PATH C fails with the old 0025
migration in place. That harness now applies *every* migration the fixture
predates rather than naming 0023 alone, which is how it quietly stopped
covering "the update". `NewSampleDialog.test.tsx` and
`tests/e2e/bulk-embedding-notes.spec.ts` cover the batch modes;
`tests/e2e/notes-correction.spec.ts` covers correcting the note afterwards, from
the Logs.

### #136 — assigned stains did not reach the log

**Reported:** "When Stains are assigned they do not show up on the log until
they have been sectioned. Can they show up earlier in the process so that the
log has the same info as the main screen. Example: the current fixing TE8-12
samples have SafO assigned but I cannot tell that from the log."

**Root cause:** the Logs derived a block's agents from its physical `slides`
alone. The main screen never did — `SampleCard` flags the block from
`pending_stains` and `SampleDetailsDrawer` lists a "Requested" row per
outstanding agent. So a block in fixative with SafO assigned had nothing for the
Logs to read.

**Fix:** `src/lib/logStains.ts` — `outstandingStains()` and `logAgents()`.
`LogsView` builds its Stains / IHC cell, stain filter, assay-type filter, search
haystack and stain sort from it, and `export.ts`'s `logRowCells()` emits one row
per outstanding request (blank Slide ID, Slide Stage `requested (not cut)`). The
cell collapses to one "(all assigned)" marker only when the block has no glass
at all; a block that has been cut marks each outstanding agent individually,
because an agent that was cut and then re-requested is outstanding again.
A removed or exhausted block lists nothing outstanding — it can no longer be
cut, so nothing is owed (reasoning at `outstandingStains()`); an archived block
keeps its requests.

**The part that is easy to get wrong:** the ask was *consistency between the log
and the main screen*, and the exported log is still the log. Fixing only the
on-screen table leaves the CSV a technician takes to the bench disagreeing with
the screen it came from — silently, in both the zero-slide case and the harder
one where a block already has glass for one agent and owes a second. Both halves
go through the one helper for exactly that reason.

**Coverage:** `src/lib/logStains.test.ts`; `src/lib/logsCsv.test.ts` and
`src/lib/logsXlsx.test.ts` (both export shapes, red before the fix);
`src/components/LogsView.test.tsx` for the "(all assigned)" gate, the
assay-type filter and a removed block; `tests/e2e/issues-136-137.spec.ts`, which
asserts the same facts on screen and in the CSV exported from that same view,
including a block removed before it was cut; harness gates `issue(136, …)` ×3 and `issue(137, …)` over a port of `logAgents()`.

---

## 0.13.1 — what a second stress harness found

Full write-up: `docs/stress_test_v2.md`. No schema change.

The point of v2 was not more coverage but a different *method*, because writing
v1 exposed two things about v1 itself:

- it had reported a stain date as **preserved when it had been overwritten**, as
  both values landed in the same minute (`nowTimestamp()` stores minutes), so
  every same-run timestamp comparison in it was structurally blind; and
- its fifteen invariants had **never fired once**, leaving no way to tell a
  correct app from a blind probe.

So v2 plants 2019 sentinels rather than comparing same-minute values, re-derives
every finding a second way before recording it, walks a **seeded random path**
over legal actions checking all 19 invariants after every step, and includes a
self-check that plants a violation of each invariant and insists the catalogue
notices. That self-check earned its keep immediately by catching an untested
probe of my own.

**Five defects, none reachable by v1's method:**

1. **`requestStainForSample` pulled an extra from a group still in the queue.**
   Its extras query filtered on the slide but not the group's stage;
   `listExtraSlides` has carried that filter since #12. The two disagreed about
   which extras exist, so a saved-but-unsent cutting plan could put uncut glass
   into a staining rack, where a tick recorded it as stained. Found by the fuzzer
   as `stained-implies-cut` at step 87, then reproduced deterministically.
2. **`reassignSlide` accepted an uncut slide**, putting a line in a plan onto a
   stainer. Now refused, pointing at the plan (#116).
3. **`removeSlide` left the emptied rack open.** The UI compensated in
   `useActions`, i.e. at the call site — the exact fragility this file warns
   about in `nextSlideLetter`. Moved into the removal.
4. **A double click surfaced `UNIQUE constraint failed: slides.slide_code`.**
   Letter allocation is a read-then-write across `await`, so two overlapping
   calls take the same letter. Pre-checking does not help — both callers pass the
   check before either inserts — so the insert is retried against the index,
   which is the only real arbiter.
5. **Images could be recorded for a removed slide** from a stale panel, and a
   repeated removal wrote a second removal event for one piece of glass.

**Two harness gates were relying on defect 1** — one said so in its own comment.
Their fixtures now cut the group first, which is what a bench does anyway.

*Coverage:* 14 seeds × 300–400 steps ≈ 5 000 randomized actions, clean after the
fixes; 4 new gates (89 total); v1's 21 stress tests, 101 e2e, 74 unit and the
legacy upgrade all still pass.

---

## 0.13.0 — the record must match the work that was done

Not from a report: from a deep stress test of 0.12.0
(`docs/stress_test_0_12_0.md`). Nothing crashed. Everything below is a place
where the database said something that did not happen, or a correction the bench
needs and the model could not express.

**Schema change — migration 0024.** Two additive columns on `slides`. Per
`shared_data_sync.md` §1 this needs every instance on the same build.

### Four ways the record drifted from the work

1. **A rack tick rewrote slide stain dates.** `syncAssayStackWorkflowStep` issued
   a bare `SET stage_stained_at = ?` across every member. Since #115 lets a slide
   move between racks, a slide stained days earlier could be restamped with
   today — demonstrated by planting `2020-01-02` and watching it become today.
   Ticking now `COALESCE`s. **Unticking** was worse: it nulled the column for the
   whole rack, including dates the rack never wrote; it now clears only the slides
   carrying that rack's own stamp. Fixed in BOTH checkbox paths — the rack drawer
   and the cut-group drawer — because fixing one and not the other is exactly the
   shape #81 was reported in twice.
2. **Completing imaging stamped slides nobody photographed.** The per-sample
   stack keeps accepting late arrivals; `idx_slide_stacks_sample_stage` makes one
   open stack per (sample, stage) a UNIQUE constraint, so there is nowhere else
   for them to go. Advancing the stack stamped every member. It is now refused,
   naming the glass, at the data layer and on a disabled button.
   *Worth knowing:* four existing e2e tests broke on this fix, because they
   pressed Complete Imaging without ticking anything — they had been depending on
   the back-fill.
3. **A rack could not say what it held.** One panel showed `Protocol v1 · 0/2
   complete`, a stack timeline reading `Stained`, and a database holding one
   stained and one unstained slide. Each slide now shows its own stained date, and
   the panel says when the rack is a mixture.
4. **A second rack for one agent looked like a duplicate.** It is the #81 guard
   working — a rack that has begun its protocol cannot take newcomers — so the
   later rack is now labelled *new rack* with the reason on hover.

### Five corrections the bench needs

- **Requested vs applied (migration 0024).** `assay_name` held both the order and
  the result, so correcting a slide erased the order and the block stopped
  looking like it still owed a PAS. `requested_assay_type` / `requested_assay_name`
  are written once — at plan, at cut, or when an extra is pulled for an agent —
  and never touched by a correction. The Logs marks a divergence *asked for PAS*.
- **Refile a slide onto the right block.** Nothing could change
  `slides.section_request_id`, so a mislabelled slide could only be removed and
  re-cut. `relabelSlideToSample` moves it: the glass keeps every stamp, takes a
  fresh code from the correct block's sequence, the vacated letter stays burned
  (#73), and both blocks get a timeline event with the reason.
  *The policy call:* a slide is filed under the block it came from, not the block
  it was written up as, and the correction is part of the record rather than a
  quiet edit.
- **One more off the ribbon.** `addSlideToSection` adds a slide to a group that
  has already been cut, with the next burned letter and a cut stamp — instead of
  a new cutting plan, which records a second trip to the microtome.
- **Re-staining.** The column keeps the FIRST date, which is when that glass was
  stained; a second run is recorded as a `slide_restained` timeline event. Not a
  staining-run model — enough that the second run is not lost.
- **Reassignments are narrated.** `slide_reassigned` on the timeline, so a
  correction is distinguishable later from the mistake never having happened.

### Coverage

6 new harness gates (85 total), including one that plants a 2020 stain date and
insists it survives a rack tick, and one that insists imaging completion is
refused. The harness port and the legacy-upgrade port both gained the new
functions and columns — the legacy test's drift guard caught the omission before
it could ship, which is what it is for.

---

## #113–#120 — what the Logs claim, and where a slide can go — status as of 0.12.0

### The one root cause behind #117, #118 and #119

Three separate reports, one model error. `samplePhase` returned a **single**
value, and derived it from *"has this timestamp ever been set"* rather than from
where the block and its slides actually are. Every symptom follows:

- **#118 — a block read `Sectioned · 0/1` before it had been cut.** Slides are
  created when the cutting *plan* is saved, so the row existed while the block
  was still queued in Needs Sectioning. `isCut()` now gates on the slide having
  *left* that queue (`section_stage !== 'needs_sectioning'`, the same predicate
  #95 established for the `cut` timeline event), and `analyzedProgress` counts
  only cut slides — so the denominator no longer includes glass that does not
  exist.
- **#117 — the Staining / IHC filter returned nothing.** It required
  `stage_stained_at`. A slide sitting *in* the staining column has by definition
  not been stained yet, so the filter excluded precisely the population it was
  named for. Phases are now read off the slide's **current queue**
  (`SECTION_STAGE_TO_QUEUE`), which is what the filter names mean.
- **#119 — filters are inventories, not a pipeline position.** A block in
  Embedded Inventory whose slides are in staining is genuinely in both places;
  furthest-wins made it vanish from one. `samplePhases` returns a `Set` and the
  filter is a set intersection. The Stage *column* still shows one value —
  `furthestPhase` — because a column needs a single string.

The set is also what makes the empty case honest: if a block has no live cut
slides it falls back to embedded-or-earlier, rather than inheriting a phase from
a timestamp left over from something that was later removed.

### Stains

- **#114 — "Add a stain" from the Logs opened the sync-request dialog.** That is
  the flow a *viewer* uses to ask the workstation for something; on the
  workstation it filed a request with itself, which is why nothing appeared to
  happen. The Logs row now calls `requestStainForSamples` directly — the same
  entry point the drawer uses, so it takes a free extra when there is one and
  otherwise leaves the block flagged as needing a cut (#110).
- **#113 — no "Add a Stain" in the Embedded Inventory.** Gated on
  `!isEmbedded`. At that stage there is no glass to stain, so the control could
  only consume a free extra from some *earlier* cut — which reads in the log as
  "this block was stained" when an unrelated slide was used. The action available
  at that stage is a cutting plan.
- **#115 — a slide's agent can be changed, or the slide sent back to extras.**
  `reassignSlide` moves the slide out of its rack and into the one belonging to
  the new agent (`getOpenStainRack ?? getOrCreateStainRack`), then retires the
  rack it emptied via `closeSlideStackIfEmpty` — closed, never deleted, per #83.
  A `removed` slide is refused. **Stamps already earned are kept**: a slide
  stained as H&E and re-cut as CD31 keeps its stained-at date, because that is
  what physically happened to the glass, and this is a posterity log.

### #116 — a queued cutting plan is editable

`showAssignments` in the section drawer excluded `needs_sectioning`, so the one
window in which a plan can still be changed for free — sent, not yet cut — was
the one window with no editor. Widened, and the block's own panel in the Embedded
Inventory now lists its open groups (`Awaiting cut · N slides / Edit plan`), so
the plan is reachable from the block as well as from the card.

### #120 — the Extras search

Rebuilt on a shared `matchesSearch(query, parts)` in `src/lib/utils.ts`, which
the Logs search now uses too. Terms match in any order, and each term is compared
against both the raw text and its `sampleCodeVariants` — so `OG-11` finds
`OG-0011` and `OG-0011` finds `OG-11`, which matters because #87 made the padding
render-time cosmetic while the DB still stores the padded form.

### What #113 moved, and what followed it

Removing the embedded drawer's Add-a-Stain is not a cosmetic deletion: a block
stays `embedded` for its whole life (that is the point of #119), so the control
was gone for *every* block, and with it the only board-side way to raise an
outstanding stain request. The Logs control (#114) is the surviving entry point,
and it is the same data-layer call, so every behaviour built on requests —
the needs-cut flag (#110), the Send-for-Cutting prefill (#41), two requests for
the same agent queueing two slides (#62/#66), the cut clearing the request it
fulfilled (#112), the exhausted-block refusal (#70) — is unchanged.

Nine e2e tests drove those behaviours through the removed control and were
re-pointed at the Logs, via one shared helper (`tests/helpers/stains.ts`) so the
next move costs one edit rather than nine. Two things had to change with them:

- **#109 (a stain applies to the whole selection)** now runs in Pre-processing.
  The multi-target control still exists wherever the drawer shows it; the
  Embedded Inventory is simply no longer one of those places. Bulk stain-adding
  across many *embedded* blocks has no UI home as a result — the Logs control is
  per-row. Worth a decision if it turns out to be missed at the bench.
- **#70's refusal** was asserted against the sync request dialog, which on a
  workstation is exactly what #114 says should not appear. It is now asserted on
  the Logs flash, which is why that flash is a `role="status"`.

Two more things fell out of the section drawer being made editable at
`needs_sectioning`: the read-only "Assay slides" list and the editor were both
rendering, naming every slide twice, and a viewer was being handed an editor.
They are now alternatives — editor when writable, list when not.

*Tests:* one new harness gate (`issue(115)`, port of `reassignSlide`), 4 unit
tests for `matchesSearch`, and 7 e2e tests in `tests/e2e/issues-113-120.spec.ts`.
All eight revert-verified. Note `119-inventory` is pointed at the **#117** test,
not the #118/#119 one: in the latter nothing has been cut, so the block's only
phase is `embedded` and set-intersection and furthest-wins agree — the assertion
cannot tell them apart. The #117 test is where they genuinely disagree.

*Compatibility:* no schema change, no migration. Every fix is a read-path or
UI change except `reassignSlide`, which writes only columns that have existed
since 0.4.x.

---

## #111–#112 — the needs-cut flag, Needs Sectioning filters — status as of 0.11.1

- **#112 — the flag survived the cut that should have cleared it · ✅ fixed.**
  Two independent leaks, either of which alone reproduces the report.
  1. *Regression from 0.11.0.* `plan_saved` was `EXISTS(sectioning_plan event)`.
     A timeline event is never cleared, so one deliberately saved plan flagged
     the block permanently. The event is still needed — it is what tells a saved
     plan from the one every block is auto-seeded at embedding — but the
     predicate now ALSO requires `sectioning_plan <> ''`, and
     `createSectionRequests` clears that column when it sends. So the flag drops
     exactly when the cut happens, which is what the reporter asked for.
  2. *Older.* The trim in `createSectionRequests` only considered groups with
     BOTH `assay_type` and `assay_name`, and `removeFromRequests` demanded an
     exact type match. A group naming an agent without a type could therefore
     fulfil nothing: the request outlived the slide that satisfied it, and no
     later cut could clear it either. Matching is now on the agent name, with
     the type honoured only when both sides state one.
  *Live-data repair:* `reconcileFulfilledRequests`, guarded by a `schema_meta`
  key so it runs once per image, subtracts produced slides from the outstanding
  multiset. Multiset, not "drop every agent with a slide", because asking twice
  is legitimate (#62/#66). It cannot be exact — a stale entry and a deliberate
  re-request are the same two rows — so it resolves towards clearing, on the
  grounds that an uncleanable flag is worse than one that has to be set again.
  *Escape hatch:* outstanding requests can now be withdrawn from the drawer
  (`withdrawStainRequest`, recorded on the timeline), which makes BOTH directions
  recoverable: withdraw one the repair missed, re-add one it cleared too eagerly.
  This is the reporter's "perhaps we should be able to manage requested stains?".
  *Tests:* harness gates for both leaks — one asserts the flag drops after a cut,
  one asserts a typeless plan still clears its request — plus three e2e tests.
  *Note on coverage:* `revert-verify 112-trim` is **expected vacuous** against
  the e2e suite. A request made through the drawer always carries a type, and so
  does the plan built from it, so that path always worked; the typeless plan is
  only reachable at the data layer. The harness gate is the load-bearing check,
  and is revert-verified separately.
- **#111 · ✅ shipped** — Needs Sectioning filter + sort. Unlike every other
  column this one holds GROUPS (all of a block's un-sectioned cut groups
  aggregate into one card, #33), so the sort key is read off the group's first
  section. Its date key is `stage_needs_sectioning_at` — when the cut was
  ordered — since nothing in the column has been sectioned yet. Includes the #85
  stale-filter guard, and `sectionGroupOrder` now follows the DISPLAYED list so
  shift-range selection walks what is on screen.

---

## #109–#110 — bulk stain requests, the needs-cut flag — status as of 0.11.0

- **#109 — the stain dropdown ignored the selection · ✅ fixed.** *Root cause:*
  the drawer is multi-select everywhere else (checklist, Start Run, Delete, Mark
  Exhausted) but this one control read `sample.id`. *Fix:*
  `requestStainForSamples` over the same target set Delete uses, in one commit so
  it is one undo step, with **per-block** error handling — an exhausted block
  legitimately refuses (#70) and must not abandon the blocks behind it in the
  loop. The heading counts its targets so the scope is visible before the click.
- **#110 — the flag · ✅ fixed.** Renamed to **needs cut**: a pending agent on an
  embedded block is waiting to be cut, not stained, and naming it after the
  downstream step sent people to the wrong column.
  *The hard part:* "saved cutting plans should add a needs cutting flag" cannot
  be implemented as "has a `sectioning_plan`", because `ensureAutoSectioningPlan`
  seeds one for **every** block on arrival in Embedded Inventory — the flag would
  be on everything and mean nothing. A deliberate save goes through
  `updateSectioningPlan`, which writes a `sectioning_plan` timeline event; the
  auto-seed writes none. `listOpenSamples` derives `plan_saved` from that.
  *Known edge:* `updateSectioningPlan` early-returns when the plan is unchanged,
  so opening the dialog and saving without editing records nothing and raises no
  flag. That is indistinguishable from never having opened it, and treating it as
  a deliberate plan would flag blocks nobody decided anything about.
  *Test:* harness gate `issue(110, …)` asserts both blocks carry an auto-seeded
  plan and only the deliberately planned one is flagged — the assertion that
  fails if the flag is keyed on the column.
- **#110's parenthetical — plans could not be saved in bulk · ✅ fixed.** Save
  Plan was rendered only when `!isBatch`. It now saves every block in the dialog,
  each by its own page's plan. The drawer also passes the whole selection rather
  than only its embedded members, so a batch can be planned before embedding;
  Send remains gated on every block being embedded (#98).

---

## #102–#108 — board and log housekeeping — status as of 0.10.0

- **#106 — a project rename did not reach its samples or slides · ✅ fixed.**
  *Root cause:* `sample_code` and `slide_code` are stored TEXT with the project
  acronym baked in, and `updateProject` touched only the projects row.
  *Fix:* a prefix swap up to the first hyphen across `samples`, `slides` and
  `stain_requests` — not a re-mint, so numbers, letters and zero-padded legacy
  codes (#87) all survive untouched. *Landmine found by the test:* the fix
  worked in the database and the Logs still showed the old acronym, because
  `useProjectMutations` invalidated only `projects` + `open-samples`. A project
  edit is no longer confined to the projects row, so it now invalidates
  everything a rename can touch. A half-applied rename is worse than none.
  *Test:* harness gate `issue(106, …)` (including that another project is left
  alone and the suffix is byte-identical) plus an e2e rename driven through the
  Manage dialog; both revert-verified.
- **#107 — "Added" sorted by day · ✅ fixed.** *Root cause:* `date_added` is
  `todayIso()` — a date with no clock — so every block logged the same day tied.
  *Fix:* sort on `stage_received_at`, falling back to the day for rows written
  before it existed. *Second cause, found by the test:* the stamp is only to the
  minute, so a batch entered in one sitting still tied and fell back to whatever
  order the query returned. Both `added` and `updated` now break ties on
  `project_sample_number` (creation order), which makes the ordering total.
- **#104 — filters reset on every view switch · ✅ fixed.** Board and Logs each
  unmount when you leave them, so their `useState` filters were rebuilt at
  "all". `lib/viewPrefs.ts` + `hooks/useViewPref.ts` persist them for the
  signed-in session; `clearViewPrefs()` runs synchronously inside `signOut`, and
  both views are keyed on the user id so live state resets with the stored copy.
  *Landmine:* the first `readViewPref` also required the stored value to share a
  `typeof` with the fallback — cheap-looking insurance that silently broke every
  union, since a column filter is `number | "all"` and a remembered project id
  never matched its `"all"` fallback. `isValid` is now the only validation.
- **#105 · ✅ shipped** — "Show removed" beside "Show archived", same default.
  Hides removed blocks *and* removed slides; the removed-count beside the slide
  total still reports them either way, because hiding a row must not hide the
  fact that something was removed.
- **#103 · ✅ shipped** — Needs Embedding filter + sort, including the #85
  stale-filter guard. Its date key is `stage_picked_up_at`: `stage_embedded_at`
  is NULL for everything in that queue by definition, and `stage_received_at` is
  weeks stale by the time a block arrives there.
- **#102 · ✅ shipped** — imaging tiles show `parent_description` beside the ID
  and `agent_names` below it. Both were already on the stack row; nothing new
  was queried.
- **#108 · ✅ shipped** — the sign-in prompt now fires for a manual sign-out too,
  and carries the reason. It previously claimed inactivity in all cases, which
  was already untrue for the launch sign-out.

---

## #96 — Delete on the board, Archive in the Logs — status as of 0.8.1

- **#96 · ✅ shipped.** *Root cause:* not a defect so much as a mis-assignment.
  0.7.4 replaced the drawer's cascading Delete with **Archive** (#83), which
  removed the destruction but also handed the board the wrong verb: archiving is
  a reversible *hide* for a block you expect to want back, and the board's red
  button is reached for when a block should not be there at all. The two
  intentions want different affordances and different places.
  *Fix:* the drawer's button is **Delete**, routed through the existing
  `RemovalReasonDialog` into a new `removeSample`, which is built out of the
  parts already in place — `removeSectionRequest` per live cut group, which is
  `removeSlide` per slide — so a removed block detaches its slides from racks,
  keeps their letters burned, and records a timeline event each, with no new
  code path. The only genuinely new parts are the block's own
  `current_stage = 'removed'` and its own `sample_removed` event. Archiving is
  gone from the drawer and stays in the Logs, where it already was.
  *Note:* the `current_stage != 'removed'` clause added to `listOpenSamples` is
  defence in depth, not the mechanism — `'removed'` maps to no board queue in
  `stages.ts`, so the card is dropped regardless. `revert-verify.mjs 96-logged`
  documents this, having been retargeted once for exactly that reason.
  *Test:* harness gate `issue(96, …)` for the cascade and the burned letters;
  two e2e tests (board deletes with a required reason and keeps everything in
  the log; Logs still archives and restores whole), both revert-verified. The
  never-delete invariant was rewritten rather than relaxed: it now requires the
  drawer to go through `removeSamples` **and** to ask for a reason, and requires
  archiving to be absent from the drawer and present in the Logs.

---

## Sixth wave (#92–#95) + 0.7.4 follow-ups — status as of 0.8.0

Three of these five are **second reports on issues already marked fixed**. In
every case the data layer was correct and the surface the user actually touches
was not, which is why each fix below carries a browser-driven check that was
observed failing with the fix removed (`node scripts/revert-verify.mjs <case>`).

- **#83 follow-up — removed slides unreadable in dark mode · ✅ fixed.**
  *Root cause:* the struck-off row was `bg-red-50/60` and its reason panel
  `bg-red-50` — FIXED near-white Tailwind paints — while the text on them is
  theme-aware (`text-ink`, `text-ink-faint`). In the eleven dark themes that is
  pale grey on bright pink. *Fix:* `.row-removed` / `.note-removed` /
  `.text-removed` in `index.css` blend the theme's own `--color-panel` and
  `--color-ink` with the accent via `color-mix`, so one rule covers every present
  and future theme instead of a per-theme override list. The same was done for
  the stain-filter match tint, which had the identical defect one expression
  away. *Test:* `issues-92-95.spec.ts` measures the computed background
  luminance and the WCAG contrast ratio of the reason text against its actual
  painted background — not the class name.
- **#86 follow-up — "shared description currently does nothing" · ✅ fixed.**
  *Root cause:* the shared field was a pure FALLBACK, consulted only when a row
  was blank and discarded entirely once a row had anything in it. Filling in both
  is the natural thing to do, and it threw away the half that was true of every
  sample. *Fix:* `composeDescription(shared, own)` in `utils.ts` — `shared |
  own`, either half alone if that is all there is, `""` only when both are blank
  (which #88 already refuses). One function, read by both the dialog's preview
  and `createSamples`, so they cannot disagree. The row list renders the shared
  half inline as a prefix so the composed result is visible while typing.
- **#91 follow-up — the Add list offered the Embedded Inventory · ✅ fixed.**
  *Root cause:* eligibility was entirely "has this timestamp been set" —
  fixative in, fixative out, ethanol in, decalc done. Every one of those stays
  true for the rest of the block's life, so a block that had been processed,
  embedded and sectioned satisfied all of them. *Fix:* `PREPROCESSING_STAGES` in
  `stages.ts`, derived from the board's own pre-processing queue definition;
  applied both in `App.tsx`'s candidate memo and — for joiners only — in
  `updateBatchMembers`, since an existing member of a running run is past
  pre-processing by definition. *Test:* harness gate `issue(91, "a block that is
  already embedded…")` plus an e2e check that a still-waiting block IS offered,
  so the assertion cannot pass on an empty list.
- **#95 — a slide read as Cut the moment its group was queued · ✅ fixed.**
  *Root cause:* `createSectionRequests` stamped `stage_cut_at` at INSERT, which
  is when the group is *created* and dropped into Needs Sectioning. This is also
  the whole of the original report ("sectioned, undone, redone — it still shows
  as cut"): undo/redo swaps whole DB images and was never broken, but the stamp
  predated the action being undone, so no amount of rewinding could clear it.
  *Fix:* three parts. The INSERT no longer stamps. `updateSectionStage` stamps
  once, for **any** stage past `needs_sectioning` — two specific destinations
  used to stamp it individually and a group dragged straight to Ready for
  Imaging was never recorded as cut at all. `revertSectionToStage` clears it
  when a group goes back into the queue. On the read side, `slideCutAt()` refuses
  to report a cut for a slide whose group is still queued, which is what corrects
  rows **already written** by 0.7.4 without rewriting history; it keeps the
  `created_at` fallback for genuinely old slides (early builds inserted slides
  with no `stage_cut_at` at all — see `f26448a`). *Test:* harness gate covers the
  write, e2e covers the read; verified separately, because either mechanism alone
  makes the other's revert look vacuous.
- **#92/#93/#94 — settings dialogue · ✅ shipped.** Slides per block (default 4
  → **3**), minimum extras, idle sign-out window and Manifest visibility are now
  rows in `app_settings` — a table that has existed since 0.5, so **no
  migration** and a 0.7.x build opens the database unchanged. Manage, Backups and
  the theme picker moved out of the header; Manifest moved to the foot of the
  left panel above the cog. *Landmine found and fixed during testing:*
  `useAppSettings` seeded with `initialData` was stamped as fetched *now*, and
  the client-wide `staleTime: 5000` then suppressed the mount fetch — so for the
  first five seconds after launch the app silently used the built-in defaults
  rather than the lab's. `initialDataUpdatedAt: 0` marks the seed stale on
  arrival. This is the case `revert-verify.mjs 92-settings` reproduces.

---

## Fourth wave (#85–#87) + 0.7.0 follow-ups — status as of 0.7.1

- **#85 — Ready for Imaging empties itself · ✅ fixed (regression from 0.7.0).**
  *Root cause:* the project/stain `<option>` lists are derived from the stacks
  currently in the queue. Analyzing the last stack of the filtered project
  removes its option, and react-dom's `updateOptions` then re-selects the FIRST
  option **without firing a change event** — so the control reads "All Projects"
  while React state still holds "EE" and `displayedImagingStacks` filters to
  nothing. Aggravated by the header gate: when the queue drained, both selects
  unmounted while the stale value survived, leaving no widget to clear it.
  *Fix:* two effects in `Board.tsx` reset a filter whose value is no longer among
  the options; the gate keys off the raw queue; `NO_STACKS` gives the empty queue
  a stable identity. *Test:* `issues-85-87.spec.ts`, verified to fail without the
  fix (0 tiles instead of 1, while the select still read "all" — the reported
  symptom exactly).
- **#79 follow-up — the fix was unreachable · ✅ fixed.** Shipped in 0.7.0 as a
  12px `text-ink-faint` pencil beside the Description heading; the user reported
  it as missing. Descriptions are now an always-visible field in the Logs
  drill-down beside the notes editor (the pattern users already know) and a
  bordered "Edit" control in the drawer. Writes go through a new
  `setSampleDescription` / `editSampleDescription` that touches ONE column —
  `updateSampleDetails` rewrites eight and was the wrong shape for a text field.
- **#87 — sample ID zero padding · ✅ fixed, deliberately partial.**
  Phase 1 (identity): `formatSampleCode` / `parseSampleCode` /
  `sampleCodeVariants` / `compareSampleCodes` in `utils.ts`;
  `findSampleIdByCode` and `acknowledgeRequestsForSlide` match every spelling;
  `listSlidesForStack` orders by `project_sample_number` rather than code text;
  the extras and request-dropdown sorts and the Logs search are padding-aware.
  Phase 2 (format): the three mint sites now call `formatSampleCode`.
  **Phase 3 (renaming existing codes) was deliberately NOT done** — see below.
- **#86 — per-sample batch descriptions · ✅ fixed.** Optional `descriptions[]`
  on `createSamples`, opt-in checkbox plus a paste-a-column textarea in
  `NewSampleDialog`. Undo already wrapped the whole loop, so a batch is still one
  Ctrl+Z. No data-layer change — `sample_description` was always per-row.
- **#73 follow-up · ✅ fixed.** Rack slide removal was an unlabelled 14px icon
  while the Extras drawer used a labelled button; aligned to the latter.
- **#77 — attribution never rendered · ✅ fixed.** `useSync` built the "changes
  by …" string into `lastMessage`, but `App` never passed it to
  `SyncStatusPill` and nothing else read it — the whole channel was write-only,
  and the 0.7.0 changelog claimed a UI that did not exist. Now rendered.
- **#72 follow-up — setup defaulted to Viewer · ✅ fixed.** `SetupScreen`
  pre-selected `viewer` and `save()` never validated the role, so pressing
  Connect without choosing silently configured a read-only install. Harmless
  before 0.7.0; after it, read-only gating hides every editing control, which
  presents as the app losing features. A role is now required.

### Why existing sample codes are NOT renamed (#87 Phase 3)

Renaming `EE-0001` → `EE-1` across a live database was considered and rejected
for now. The blocking argument is physical: **blocks, cassettes and slides already
carry the padded code in pen.** Renaming desynchronises the database from objects
on the bench, and nothing in the schema would remember the old spelling. Beyond
that: `audit_events.summary` freezes codes as text, so history would disagree with
the present; the unconditional `AFTER UPDATE` audit triggers would inject one junk
row per sample and per slide; and any viewer request already in the inbox names the
old code. Phase 1 makes the mixed state safe — both spellings resolve to the same
sample everywhere — so a rename can be offered later as an explicit, backed-up,
preview-and-confirm maintenance action if the lab wants one. It must never be an
open-time translation: those run before `guardWrites` (so they fire on viewers too)
and their `schema_meta` marker rides with the image, which would silently re-rename
every backup you ever open.

---

## Third wave (#70–#84) — status as of 0.6.1

Fixed and gated in this pass:

- **#81 — staining stacks must be keyed by stain AND substage · ✅ fixed.**
  *Root cause:* there are two ways a rack advances. A board move goes through
  `updateSlideStackStage`, which sets `current_stage`. The **protocol checkbox**
  goes through `syncAssayStackWorkflowStep`, which stamps only the substage
  timestamp (`stage_stained_at` …) and deliberately leaves `current_stage` at
  `'stain_requested'` until the whole checklist is ticked. `getOpenStainRack`
  matched on `current_stage` alone, so a rack that was stained-but-not-
  coverslipped still read as an open loading rack and absorbed newly-moved
  samples. *Fix:* `getOpenStainRack` (`db.ts`) additionally requires every
  substage stamp to be NULL. *Data repair:* `splitContaminatedStainRacks()` runs
  once per image (marker `stain_racks_split_81` in `schema_meta`) and moves
  already-merged late arrivals — identifiable because their own
  `stage_stained_at` is NULL while the rack's is set — into a fresh rack.
  *Tests:* harness `issue #81` ×2 (behaviour + translation), both verified to
  fail without the fix; Playwright `issues-70-84.spec.ts` drives the reporter's
  exact sequence and also fails without the fix.
- **#70 — no stain request to an exhausted sample · ✅ fixed.**
  `requestStainForSample` refuses when the block is exhausted **and** no free
  extra can fulfil the request (that path flags the block for a cut that can
  never happen). A request an existing extra satisfies is still allowed — the
  slide is already cut. The drawer now catches and displays the refusal.
  Harness gate `issue #70` covers both branches.
- **#79 — editable sample descriptions · ✅ fixed.** The drawer's Description
  section is editable and routes through the existing `saveDetails` action, so
  it records an undo command. No schema change (`updateSampleDetails` already
  wrote the column; it simply had no UI).
- **#75 — Logs slide ordering · ✅ fixed.**
  *Root cause:* `slides.slide_ordinal` is a **per-section** counter that restarts
  at 1 for each cut group (`createSectionRequests`), while `slide_code` is issued
  from a **per-sample** running counter (`nextOrdinal`). `listAllSlides` orders by
  `slide_ordinal` with no tie-break, so as soon as a sample has a second cut group
  its slides interleave — A, E, B, F, … A single-cut sample is coincidentally
  ordered correctly, which is why this looks fine in simple cases.
  *Fix:* `compareSlideCodes` (`utils.ts`) sorts by parent code, then label
  **length**, then alphabetically — so A…Z precede AA, matching the bijective
  base-26 labels `duplicateLabel` issues. Applied where slides are grouped, so the
  table, drill-down and exports agree.
  *Test note:* the Playwright case **must** create two cut groups. An earlier
  version of it used a single cut and passed even with the fix reverted — it was
  verified vacuous and rewritten. It now fails without the fix.
- **#82 — filter Ready for Imaging by project and stain · ✅ fixed.**
  `listOpenSlideStacks` now also returns `agent_names` (a plain delimited agent
  list) so the filter is exact rather than parsed out of display text.
- **#84 — active project clarity · ✅ fixed.** Solid fill + accent bar + weight
  + an "active" label, and `aria-current` for tests.
- **#78 — matcha theme · ✅ fixed.** Additive CSS block + picker entry.

Second pass — the remaining eight, all now fixed:

- **#73 / #83 — removing slides · ✅ fixed.** *Root cause:* slide letters were
  issued from `COUNT(slides for this sample) + 1` in **two** places
  (`createSectionRequests`, `ensureSlidesForSectionRequest`), so deleting a slide
  handed its letter to the next cut. Because `slides.slide_code` is UNIQUE this
  did not merely renumber — it **threw `UNIQUE constraint failed`** and the cut
  died. *Fix:* migration `0023` adds `samples.slides_issued`, a high-water mark;
  both paths now issue from `nextSlideLetter()` and `deleteSlide()` freezes the
  mark *before* removing the row (essential on pre-0023 images, where the mark
  reads 0 and the live count is still governing). #83 is the same operation
  surfaced from the Extras inventory drawer. Harness gates: `issue #73` ×2, both
  verified to fail without the fix; Playwright drives the reporter's exact
  "delete C → next is E" sequence.

  *0.7.3 addendum — the total-delete case.* Restricting the initialiser to
  sections with **no** slides fixed removing some of them but left removing
  **all** of them broken, because emptying a group restores the very condition
  the initialiser fires on (`existing_count = 0`). The group came back at its
  original size on the next open, with fresh letters each time, so reopening the
  card burned the letter sequence without bound. `duplicates` is now recomputed
  from the live rows on every removal path (`deleteSlide`,
  `deleteSlidesForStack`) and `0` is read as "the bench removed everything",
  not "never initialised" — legacy rows still carry the column's
  `NOT NULL DEFAULT 1` and initialise as before. Recomputed rather than
  decremented so a database that already drifted self-corrects. Undo is
  unaffected: it restores a whole DB image, so `duplicates` returns with the
  slides. Gate: `issue #83`, observed failing without the fix.

  That fix on its own traded a resurrecting group for a dead one — an emptied
  group has no `HAVING` clause hiding it, so it sat in Needs Sectioning as "×0".
  `deleteSectionRequestIfEmpty` (called from `removeSlides`, alongside the
  `deleteSlideStackIfEmpty` that racks already had) removes the group with its
  last slide. Second `issue #83` gate, also observed failing without it.
- **#74 — archive samples · ✅ fixed.** `samples.archived_at` (same migration).
  `listOpenSamples` hides archived blocks; the Logs view hides them behind a
  **Show archived** toggle, badges them, and offers Archive/Restore with a
  confirmation. Reversible, undoable, and no renumbering.
- **#72 — viewer read-only · ✅ fixed.** New `ReadOnlyContext` consumed by the
  Logs view and by **every** panel that writes: sample, extras, **staining rack**
  (`StackDetailsDrawer`), **cut group** (`SectionDetailsDrawer`) and
  **processing run** (`ProcessingBatchDetailsDrawer`). The rack and cut-group
  panels matter most — they hold the protocol checkboxes, which write on every
  tick and are the likeliest way to hit the reported hanging spinner. A first
  pass gated only the sample/extras/Logs surfaces and left those two open; the
  e2e suite now covers the rack panel specifically and was verified to fail when
  the gating is removed. The data-layer `guardWrites` stays as the backstop it
  was meant to be.
- **#71 — viewer request desync · ✅ fixed.** *Root cause:* a viewer's request is
  uploaded as a repo file; nothing is written locally (a viewer **cannot** write
  — `guardWrites` — and every pull REPLACES the whole SQLite image anyway). So
  "My requests" stayed empty until drain → publish → pull completed, and the
  request vanished silently if any step failed. *Fix:* `lib/pendingRequests.ts`
  keeps the viewer's own submissions in localStorage (which survives the image
  swap), merges them into the inbox, and prunes by uuid once the real row
  arrives. Unit + Playwright coverage, including the no-duplicate case.
- **#80 — remove drying · ✅ fixed, without the translation feared below.** The
  key realisation: `ensureChecklist` keys on `stage_key` and **reuses an existing
  run**, so simply shortening the label list changes NEW runs only. Keeping the
  `_v5` key (rather than bumping to `_v6`, which would orphan in-flight racks
  with a fresh empty checklist) means racks already mid-protocol keep their three
  steps and finish normally. The `sortOrder === 2` handlers are deliberately
  retained to serve exactly those legacy runs — do not "clean them up".
- **#77 — snapshot attribution · ✅ fixed.** `SnapshotManifest` gains optional
  `published_by` / `published_by_install` (optional, so old and new builds
  interoperate); the viewer reports "changes by …" after a pull.
- **#76 — idle auto log-out · ✅ fixed.** `useIdleLogout` drops the session after
  30 minutes of no real input (mouse *movement* deliberately excluded) and App
  prompts to sign back in. Unit-tested with fake timers.

Earlier analysis, retained for context:

- **#80 — remove drying.** Deliberately *not* rushed. The three protocol steps
  live in `checklist_items` rows created by `ensureChecklist`, which is keyed on
  `stage_key` (`stain_workflow_v5` / `ihc_workflow_v5`) and **reuses an existing
  run**. So shortening the label list only affects *new* runs; in-flight racks
  keep their three-item checklist. Bumping to `_v6` instead would orphan the
  progress of every rack currently mid-protocol. The correct fix is a one-time
  translation that deletes the `Dried` item from existing v5 runs **and**
  advances any rack whose remaining steps are already complete — and that
  advance is the stain-rack *scatter* (each slide rejoins its sample's imaging
  stack), which must be reimplemented in raw SQL because the translation runs
  inside `getDb()` and so cannot call `updateSlideStackStage`. Worth doing
  properly; the column itself stays per the append-only contract.
- **#73 / #83 — removing extra slides.** #73 requires deletion that does *not*
  renumber: the next slide after deleting C must be E, so the next ordinal must
  come from `MAX(slide_ordinal)` (or a per-sample high-water mark), not
  `COUNT(*)`. Check `slideCodeFor`/`ensureSlidesForSectionRequest` before
  changing. #83 is the same operation surfaced from the extras inventory.
- **#74 — archive samples.** Needs one additive column (e.g.
  `samples.archived_at`), a matching `ensureRuntimeSchema` line, default-hidden
  filtering in Logs, and a "show archived" toggle. Explicitly must not renumber.
- **#71 — viewer request desync.** The reporter sees a request that flags the
  slide on the workstation but never reaches the viewer's "my requests" or
  cutting plan. Start at `githubSync.ts` / `useSync.ts` and
  `reconcileStainRequests`: the synced payload is the whole SQLite image, so the
  question is whether the request is written to a table that is published, and
  whether the viewer's pull happens before or after it is reconciled.
- **#72 — viewer read-only gating.** `setViewerReadOnly` + `guardWrites` already
  reject writes at the data layer, which is why the reporter sees "perpetual
  loading" — the UI still offers the controls and then swallows the rejection.
  The fix is UI-level: hide/disable depth tagging, slide adds and stain requests
  when read-only.
- **#76 / #77 — auto log-out and manifest attribution.** #77 is largely
  presentational: `audit_events` already records `user_id` (migrations 0010 /
  0011); it needs surfacing in the manifest view. #76 is new behaviour (idle
  timer + re-login prompt) and interacts with #77's attribution.
