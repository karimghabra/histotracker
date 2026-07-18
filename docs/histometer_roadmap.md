# Histometer Roadmap

## Purpose

This document is the implementation roadmap for the workflow-integrity release
and the operational features that follow it. It reflects `master` at 0.2.6 and
the open GitHub issues reviewed on 2026-07-18.

The app is not deployed. The current local database is disposable, so 0.3.0
will begin from a fresh database rather than attempting to repair historical,
conflicting slide state.

## Current Baseline

- The board derives downstream slide stacks by grouping `section_requests` by
  `sample_id` in `Board.tsx`. There is no durable stack record.
- `updateSectionStage` advances slides along with a section, but section undo
  restores only the section snapshot. That split ownership explains the
  disappearing-slide behavior in #28.
- Projects already support `is_active`, and the assay catalog already supports
  active entries. The missing work is complete management UI and mutations,
  not a replacement catalog/project model.
- `audit_events` and `sample_timeline_events` already provide an audit base.
  Future reporting will extend and query that base rather than create a second,
  competing event system.

## Release 0.3.0: Workflow Integrity

### Implementation Status

Completed on `codex/slide-stack-foundation`:

- Migration 15, durable stack queries, immutable copied slide depth, and one
  open stack per sample.
- Stack-owned downstream cards, selection, drawer, protocol checklists, stage
  transitions, imaging, analysis, whole-stack delete, selected-slide delete,
  and symmetric undo/redo snapshots.
- Extra-to-assay assignment through `stack_id` without section re-parenting.
- Regression fixes and gates for #19 and #25 through #28, plus stack lifecycle
  and cut-provenance invariants.
- Audit context for stack/slide events and explicit undo/redo audit records.

Remaining release gates:

- Add browser-level smoke coverage for multi-select, deletion, imaging undo,
  drag rejection, and the pickup indicator in light and dark themes.
- Run `cargo check` once a Rust toolchain is available, then exercise the real
  Tauri application against a fresh development database.
- Synchronize version numbers and lockfiles only after those gates pass; then
  build and confirm the Windows installer before tagging 0.3.0.

### Database and Domain Model

- Delete the development database before running the release candidate, then
  apply the complete migration set to a clean database. Do not implement data
  backfill or compatibility handling for prior, conflicting stacks.
- Add an additive migration for `slide_stacks`. A stack represents one sample's
  active downstream assay/imaging lifecycle and owns its downstream stage and
  timestamps. A new cutting cycle creates a new stack only after the prior
  stack is complete.
- Add nullable `stack_id` and immutable copied depth fields to `slides`. A
  slide retains its physical-slide identity and depth when it joins a stack.
  Sections remain cut groups and pre-assignment workflow records.
- Entering assay work creates or joins the sample's open stack. Assigning an
  extra changes that slide's purpose and `stack_id`; it must not re-parent the
  slide to an arbitrary section or delete a cut group.
- Extend the existing audit surface as needed for reporting: retain the
  existing trigger-based `audit_events`, add stable sample/stack context and
  structured details for stack actions, and record undo/redo as explicit audit
  actions. Preserve `sample_timeline_events` for sample-specific narrative.

### Board and Actions

- Replace render-time `groupDownstreamSections` with stack queries for the
  Staining and Ready for Imaging queues. Cards, drawers, selection, delete,
  checklist, and batch operations address stack IDs.
- Make every stack transition atomic across the stack and all member slides.
  Undo/redo captures and restores both the stack and every changed slide.
- Fix #28 by making image completion and reversal symmetric. No move may leave
  a slide in a state not returned by a board query.
- Fix #26 and #27 by validating the complete selection before writing and then
  applying one combined, undoable action to every eligible item.
- Fix #25 by rejecting drag targets that move a card backward or skip more than
  one permitted workflow transition. Purpose-built controls may still perform
  their explicitly supported transition.
- Re-test #12, #13, #14, and #19 against the 0.2.6 behavior. Close tickets only
  after the symptom is reproduced as fixed; #14 remains covered structurally by
  stack ownership.

### Verification and Release

- Mirror every changed workflow query in `scripts/workflow-test.mjs`. Add hard
  regression gates for #25 through #28 and stack lifecycle invariants: create,
  extra assignment, stage moves, delete, and undo/redo.
- Add focused Playwright smoke tests for multi-select actions, stack deletion,
  image undo, and drag rejection. The data-layer harness remains authoritative
  for SQLite behavior.
- Require `pnpm test`, `pnpm build`, and `cargo check`. Bump all application
  version locations, update `CHANGELOG.md`, and document the clean-database
  requirement for development installs.

## Post-0.3 Operations

### Log

- Add a read-only Log page with a vertically scrollable registry of samples.
  Columns include project, project lead, description, submission and preparation
  dates through embedding, and block availability (`Yes` when not exhausted).
- Provide filters for project, lead, availability, and date ranges; provide
  sorting for every date and project field. Render dates as `DD-MM-YYYY`.
- Selecting a sample opens its slide detail: depth, cutter, stains/IHCs, and
  cut, stain, imaging, and analysis dates. Historical inactive projects remain
  visible and filterable.

### Manifest

- Add a date-scoped Manifest page, defaulting to today, backed by the extended
  audit query. It lists time, operator, action, target, and sample/slide context.
- Default to milestone completions. Provide an audit toggle that includes all
  recorded actions, including corrections, deletes, undo, and redo.

### Administration

- Add workstation-only project administration: create, edit, deactivate, and
  reactivate projects. Deactivated projects remain in history but cannot receive
  new samples.
- Add workstation-only assay catalog administration: create, edit, deactivate,
  and reactivate stain/IHC entries. Preserve historic assigned labels when a
  catalog entry is renamed or deactivated.

## Deferred Data Features

- Planned processor runs (#4, #23, #24) are a separate lifecycle release. Add
  a `planned` status and planned start time, require confirmation of actual
  start, and allow only non-overlapping processor windows.
- Multiple stains/IHCs on a slide (#11) follows the stack release. Add a
  `slide_assays` relation with one row per assay and its own status history;
  the slide remains the physical object. Update assignment, stack summaries,
  imaging views, Log detail, and workbook exports together.

## Access and Compatibility

- Workstation mode remains the only mode that mutates workflow data, projects,
  or catalog entries. Viewer mode can read the board, Log, and Manifest.
- The synced SQLite database is the wire format. Every schema-changing release
  must be rolled out to workstation and viewers together, following
  `docs/shared_data_sync.md`.
