# Histometer Phase-Zero Product Specification

- **Status:** Draft for operational review
- **Scope:** Product behavior and domain model only; no implementation is authorized by this document.
- **Authority:** Where this document conflicts with the older design document, this document is the current source of truth.

## 1. Product intent

Histometer is a shared operational record for a histology laboratory. Its purpose is to let any operator begin or resume work without relying on one person's memory, private notes, or a manually curated spreadsheet.

At any time, an operator should be able to see:

- What physical material exists.
- Where each item is in the workflow.
- What work is ready, underway, blocked, or overdue.
- What happened previously, when it happened, and who recorded it.
- Which embedded blocks and extra slides remain available for future work.
- What the next required action is.

Histometer is an operations-management system, not an experimental notebook, image-analysis system, or long-term image repository.

## 2. Product principles

1. **The application is the shared memory of the lab.** A new operator should not need a verbal handoff to understand current work.
2. **Physical objects are represented explicitly.** Samples, embedded blocks, cut groups, and slides are different entities with different lifecycles.
3. **Plans are not physical facts.** A planned stain or planned slide does not imply that the work was performed.
4. **Routine updates must be fast.** A correct update should require fewer actions than recording the same event in a spreadsheet.
5. **History is preserved.** Corrections add attributable history rather than silently replacing earlier records.
6. **Inventory and active work are distinct.** An embedded block or extra slide may remain available without appearing as unfinished active work.
7. **The system may be operated by multiple people.** Actions must be attributable, and the current state cannot depend on a particular operator's local UI state.
8. **Exceptions are first-class.** Holds, failed cuts, damaged slides, rework, and exhausted blocks must be recorded rather than hidden in notes.

## 3. Standard terminology and hierarchy

The user interface will use **Sample** as the standard term. "Specimen" may appear during legacy import, but the application should not use both terms interchangeably in routine screens.

```text
Project
  -> Sample
       -> Embedded Block
            -> Cut Order
                 -> Cut Group / Section Level
                      -> Slide
                           -> Stain Assignment (optional)
```

### 3.1 Project

A project groups related samples and provides the prefix for human-readable identifiers.

Examples: `EE`, `TENDON`, `OA`.

Required information:

- Project code.
- Project name.
- Active or inactive status.

Optional operational information:

- Project lead.
- Default protocols.
- Default requested stains.
- Default notes or intake template.

### 3.2 Sample

A sample is the tissue unit entered into Histometer and carried through pre-processing, processing, and embedding.

Examples: `EE-0001`, `EE-0002`.

A sample stores:

- Project and generated sample identifier.
- Description.
- Intake date and operator.
- Fixative.
- Whether decalcification is required.
- Processing protocol or short/long processing type.
- Cut, slide, and general notes.
- Preliminary sectioning plan.
- Planned stains, which are suggestions and requirements for later planning but are not slide assignments.

### 3.3 Embedded block

An embedded block is the physical block produced when a sample is embedded. The block is what resides in Embedded Inventory and is the source of future cuts.

The data model should permit a sample to produce more than one block. The initial user flow may create one primary block automatically because that matches the currently described workflow.

An embedded block stores:

- Parent sample.
- Block identifier.
- Embedding date and operator.
- Current physical location, when recorded.
- Deepest cut depth requested so far.
- Inventory state: available, temporarily unavailable, exhausted, lost, damaged, or retired.
- Inventory notes.

Creating a cut order does not remove a block from Embedded Inventory. A block leaves active inventory only when an operator explicitly records an inventory-ending state and reason.

### 3.4 Cut order

A cut order is a request to produce slides from an embedded block. It may contain one or more cut groups.

A cut order stores:

- Source block.
- Requesting operator and request time.
- Requested due date and priority, when applicable.
- Assigned operator, when applicable.
- General instructions.
- Status: draft, queued, in progress, cut complete, closed, cancelled, or blocked.

Submitting a cut order creates the planned slide records and stable slide identifiers needed for labels and later assignment.

### 3.5 Cut group / section level

A cut group describes one requested level or depth from a block and the number of slides to produce at that level.

A cut group stores:

- Target depth or level.
- Units used to express the target.
- Optional section thickness.
- Duplicate count, meaning the number of physical slides requested.
- Orientation or cutting instructions.
- Notes.
- Cut status and timestamps.

In the UI, "five duplicates" means five individually tracked slide records.

### 3.6 Slide

A slide is one physical slide produced for a cut group. Every requested duplicate becomes a separate slide.

Example identifiers for five slides from the first level of `EE-0001`:

```text
EE-0001-L01-S01
EE-0001-L01-S02
EE-0001-L01-S03
EE-0001-L01-S04
EE-0001-L01-S05
```

The exact label format may change, but every slide must have a stable internal identifier and an unambiguous human-readable identifier.

A slide stores:

- Parent cut group and block.
- Ordinal number within the cut group.
- Planned, produced, or exception state.
- Cut timestamp and operator.
- Current purpose: assigned to a stain, extra, unassigned, control, or exception.
- Current location, when recorded.
- Stain history.
- Notes and exception history.

### 3.7 Planned stain

A planned stain records that a stain is anticipated for a sample or cut plan. It helps later operators understand intent and provides suggestions during slide assignment.

A planned stain does **not** select a slide and does **not** create a stain request automatically.

### 3.8 Stain assignment

A stain assignment explicitly connects one physical slide to one stain procedure. The assignment records who made the decision and when.

For the initial product model:

- A slide has at most one active stain assignment at a time.
- The same stain may be assigned to multiple slides.
- Re-staining or replacing a failed stain creates additional history rather than overwriting the earlier assignment.

### 3.9 Extra slide

An extra slide is a produced slide intentionally held without a stain assignment. It remains available in Extra Slide Inventory.

An extra slide may later be assigned a stain. At that moment it leaves Extra Slide Inventory and enters the stain workflow without requiring a new cut.

"Extra" is an explicit classification, not a synonym for "unassigned."

## 4. Core lifecycle

### 4.1 Sample and block lifecycle

```text
Logged
  -> Decalcification Complete, when required
  -> Placed in Fixative
  -> Removed from Fixative
  -> Placed in Ethanol
  -> Processing Started
  -> Processor Pickup
  -> Needs Embedding
  -> Embedded
  -> Embedded Block available in inventory
```

Rules:

- A decalcification-required sample cannot move into fixation or later stages until decalcification completion is recorded.
- Short and long processing durations remain configurable protocol properties. The current defaults are 18 and 52 hours.
- Timed processing may mark work ready for pickup, but a physical pickup event is still recorded separately.
- Embedding completes the sample-processing workflow and creates or activates its embedded block.
- The embedded block remains in inventory while cut orders and slides move through downstream work.

### 4.2 Section planning and cut-order lifecycle

1. At sample intake or any later time, an operator may create a preliminary sectioning plan containing depths/levels and expected duplicate counts.
2. The preliminary plan does not create slides and does not move work into the sectioning queue.
3. Once the block is embedded, an operator opens it from Embedded Inventory.
4. The operator selects existing plan rows or adds ad-hoc cut groups.
5. The operator reviews the depth, duplicate count, instructions, priority, and due date.
6. Submitting the cut order:
   - Places the cut order in Needs Sectioning.
   - Creates one planned slide record per requested duplicate.
   - Reserves stable slide identifiers for labeling.
   - Updates the block's deepest requested cut depth when appropriate.
7. The sectioning operator records the cut order as in progress and then records which slides were successfully produced.
8. Failed, damaged, or not-produced slides receive explicit exception states. They are not silently deleted.
9. Produced slides proceed to the slide-purpose checkpoint.

Re-cuts are new cut orders. They must not modify or erase earlier cut orders or slide records.

### 4.3 Mandatory slide-purpose checkpoint

Before produced slides can leave the post-sectioning checkpoint, every produced slide must be deliberately classified as one of:

- Assigned to a specific stain.
- Extra slide.
- Control slide, if control tracking is enabled.
- Exception, such as damaged or unusable.

An operator may leave a slide temporarily unassigned while the cut order is still being resolved, but the system must not send an unassigned slide into staining or close the assignment checkpoint.

The assignment UI should show all slides from the cut group in a compact matrix or list. Planned stains from the parent sample should appear as suggestions, not automatic assignments.

Example:

```text
Sample: EE-0001
Cut group: 100 um, 5 duplicates
Planned stains: Safranin O, Collagen I, Collagen II

Slide 01 -> Safranin O
Slide 02 -> Collagen I
Slide 03 -> Collagen II
Slide 04 -> Extra
Slide 05 -> Extra
```

The system may warn when a planned stain has not been assigned to any slide, but it must allow the operator to continue after acknowledging the warning. Laboratory intent can change between intake and cutting.

No planned stain is automatically assigned merely because enough slides exist.

### 4.4 Stain lifecycle

```text
Stain Assigned / Requested
  -> Staining In Progress
  -> Stained
  -> Pictures or Imaging Pending, when required
  -> Analysis Pending, when required
  -> Complete
```

Rules:

- Each active stain assignment belongs to one physical slide.
- Starting or completing a stain records an operator and timestamp.
- A failed stain is retained in history and may produce a re-stain or replacement-slide request.
- Stain names should come from a managed catalog, with an explicit ad-hoc option for legitimate one-off work.
- Extra slides bypass active staining work and remain searchable in inventory.

Detailed imaging and analysis requirements will be specified separately, but the model must preserve the connection from those tasks back to the exact slide, cut group, block, sample, and project.

### 4.5 Timeline semantics

The concise laboratory timeline shows events that physically occurred. Queue names and "needs" states are operational statuses and must not appear as if they were completed laboratory events.

The sample/block timeline may include:

- Logged.
- Decalcification completed, when applicable.
- Placed in fixative.
- Removed from fixative.
- Placed in ethanol.
- Processing started.
- Collected from the processor.
- Embedded.
- Block exhausted, damaged, lost, or retired, when applicable.

The cut/slide timeline may include:

- Sectioned or slide produced.
- Staining started.
- Staining completed.
- Pictures or imaging completed.
- Analysis completed.

The following are statuses, not concise timeline events:

- Needs Processing.
- Ready for Processor Pickup.
- Needs Embedding.
- Needs Sectioning.
- Slide Assignment Required.
- Needs Staining or Stain Requested.
- Pictures Needed.
- Analysis Pending.

All status changes still appear in the complete attributable activity history. The UI therefore provides two related but distinct records:

1. **Laboratory Timeline:** a concise record of meaningful physical events.
2. **Activity History:** the complete audit record of assignments, queue moves, corrections, notes, checklist changes, exceptions, and administrative actions.

### 4.6 Protocol checklists

Most workflow stages may have an associated checklist because laboratory protocols often contain multiple steps.

Checklist requirements:

- Checklists are created from named, versioned protocol templates.
- A template may be associated with pre-processing, processing, embedding, sectioning, staining, imaging, or another configured operation.
- Steps may be required, optional, or conditionally required.
- A step may capture a checkbox, timestamp, numeric value with units, selected option, short note, or operator confirmation.
- Completing a step records the operator and time automatically.
- A required step may be marked not applicable only with a reason when the protocol permits it.
- Protocol steps may gate later steps or completion of the operation.
- The UI shows progress such as `4 of 6 required steps complete` without expanding the entire checklist.
- Completed checklist instances retain the template version used at the time. Editing a protocol template must not change historical work.
- Checklists support notes and item-level exceptions without turning the core workflow state into free text.
- A checklist supplements the SOP; it does not replace the authoritative SOP. A protocol template may link to the applicable SOP and version.

Checklist scope follows the physical work:

- If a protocol is performed on one item, it has an item checklist.
- If a protocol is performed on a batch, the batch has one shared checklist.
- Batch members may record individual exceptions, exclusions, or failed steps without duplicating the whole shared checklist.
- A batch cannot be completed while required shared checklist steps or unresolved member exceptions remain.

## 5. Shared-operations requirements

Histometer must support a lab where multiple people can take over work from one another.

### 5.1 Shared source of truth

- The default board shows open work across all active projects.
- Project filtering changes the view, not the underlying workflow state.
- Queue counts, timers, assignments, and inventory must refresh after another recorded action.
- No critical information may exist only in a local UI selection, temporary modal, or one person's memory.

### 5.2 Operator identity

- Every workflow event, correction, deletion/void, assignment, and exception must record an operator.
- On a shared workstation, switching the active operator should be quick.
- The UI should always show the active operator before recording work.
- Authentication strength may be configured later, but anonymous operational changes are not acceptable.
- Cards and detail views should show the most recent meaningful update, its time, and its operator.

### 5.3 Handoff clarity

For every active work item, the application should make these fields visible or immediately accessible:

- Current stage.
- Time in stage.
- Assigned operator, if any.
- Due date and priority, if any.
- Next required action.
- Blocking reason or exception.
- Last meaningful note.
- Parent identifiers and project.

### 5.4 Update behavior

- Routine actions should be possible from the board or a compact drawer.
- Batch actions must exist for physical work performed as a batch.
- A batch action records the same event for all selected items while preserving individual histories.
- Dangerous or unusual transitions require confirmation and a reason.
- The data layer must enforce workflow rules; disabled buttons alone are insufficient.

### 5.5 Explicit batches

A batch is a persistent operational entity, not merely a temporary multi-selection.

Processing, embedding, staining, and other physically grouped work may create batches. A batch stores:

- Batch type and identifier.
- Member samples, blocks, cut groups, or slides.
- Protocol and protocol version.
- Assigned operator or operators.
- Equipment or station, when applicable.
- Start, ready, collection, and completion times as applicable.
- Shared checklist.
- Notes and exceptions.

Batch behavior:

- Selecting multiple compatible items and moving them into a batched stage opens a compact batch-start review.
- The review confirms membership, protocol, operator, start time, and any required batch fields.
- Members remain individually traceable even when shown as one collapsed batch row.
- Expanding a batch shows its members and their exceptions.
- A member may leave or fail a batch only through an explicit, attributable exception action.
- Batch completion may complete all eligible members together, but it must support partial completion when exceptions are recorded.
- Undoing or correcting a batch action is atomic where possible and never silently leaves mixed state.
- Items with incompatible protocols or invalid workflow states are not silently moved together.

## 6. Required operational views

### 6.1 List-first workflow board

The workflow remains a drag-and-drop board, but each queue uses compact list rows rather than large standalone cards.

Requirements:

- Rows prioritize information density and scanability.
- Queue headers remain visible while scrolling and show visible and total counts.
- The default row shows the primary identifier, short description, project, stage age or timer, and exception/priority indicators.
- Secondary details appear in an expandable row or right-side drawer.
- Operators may choose compact or comfortable row density independently of the visual theme.
- Long queues use efficient rendering so hundreds or thousands of inventory records remain responsive.
- Sorting and filtering must not change the underlying workflow state.

### 6.2 Selection and batch movement

The list interaction supports familiar desktop selection:

- Click selects one row.
- `Ctrl`/`Cmd`-click toggles individual rows.
- Shift-click selects a contiguous range.
- A queue-level checkbox selects all currently visible eligible rows.
- `Escape` clears the selection.
- Dragging any selected row drags the whole selection.
- Dragging an unselected row moves only that row.
- A keyboard-accessible bulk move action provides the same behavior as drag-and-drop.

The drag preview shows the number and type of selected records rather than rendering every row. The target queue highlights whether the selection is valid.

Dropping multiple items opens a compact review when the action creates a batch, requires a timestamp, changes a protocol, or contains an exception. The system must never silently perform a partial multi-item move. If some records are ineligible, the review identifies them and asks the operator to resolve the selection or explicitly move only the eligible subset.

### 6.3 Sample and block workflow

- Pre-processing.
- Processing.
- Processor Pickup.
- Needs Embedding.
- Embedded Inventory.

Individual samples appear as rows before batching. A processing batch appears as one collapsed group row with a member count and protocol/timer summary; it may be expanded to show every sample. Processor pickup may preserve the same grouping until individual exceptions or later work require separation.

### 6.4 Cutting and slide workflow

- Needs Sectioning.
- Sectioning In Progress.
- Slide Assignment Required.
- Stain Requested.
- Staining In Progress.
- Stained / Downstream Work.

Before cutting, each cut group is one work row regardless of duplicate count. For example, `EE-0001 / 50 um / 6 slides` appears as one item in Needs Sectioning.

After cutting, the six physical slides exist as six individually tracked records. To prevent board clutter:

- The main board keeps the cut group as a collapsed parent row.
- The parent summary shows total slides and a purpose summary, such as `6 slides: Saf-O x1, Col I x1, Extra x3, Unassigned x1`.
- Expanding the row or opening its drawer shows one compact row per slide.
- The Slide Assignment Required view opens directly to the assignment matrix when action is needed.
- Stain queues may group slide rows by cut group, stain method, or stain batch while preserving individual slide state.
- A filter can switch between grouped and individual-slide views when detailed work requires it.

### 6.5 Inventory views

- Embedded Block Inventory.
- Extra Slide Inventory.
- Exhausted, damaged, lost, or retired material.

Inventory views should support search and filters for project, sample, location, date, stain plan, cut depth, and availability.

### 6.6 Attention views

- Ready for processor pickup.
- Due today.
- Overdue.
- Unassigned.
- Blocked or on hold.
- Waiting for slide-purpose assignment.
- Stalled longer than the configured threshold.

### 6.7 Station and saved views

Operators should be able to open focused views such as:

- Processing station.
- Embedding bench.
- Sectioning queue.
- Slide assignment.
- Staining bench.
- Imaging queue.
- My assigned work.
- All open work.

Filters, sorting, visible columns, grouping, and density may be saved as named views. A saved view changes presentation only and must not create private workflow state.

### 6.8 Visual themes and accessibility

Theme support is a product requirement, not a workflow requirement.

The initial theme system should provide:

- Follow operating-system setting.
- Light theme.
- Dark theme.
- High-contrast theme.
- A small set of restrained accent-color choices.

Theme and density preferences may persist per operator or workstation. Workflow meaning must not depend on a theme-specific color: icons, text, shape, and labels must accompany semantic colors. All themes must retain sufficient contrast, clear selected-row states, visible keyboard focus, and distinct warning/error presentation.

Arbitrary user-authored theme colors are deferred until the semantic design system is stable.

## 7. Data-integrity and workflow rules

1. Human-readable sample identifiers are unique within a project and generated transactionally.
2. Every block, cut order, cut group, and slide has a stable internal identifier.
3. Every slide belongs to exactly one cut group.
4. A produced slide cannot simultaneously be an extra slide and have an active stain assignment.
5. Planned stains never become stain assignments without an explicit operator action.
6. A cut order cannot be closed while successfully produced slides remain unassigned.
7. A block remains in inventory until explicitly exhausted, lost, damaged, or retired.
8. Physical-history records are voided with a reason rather than deleted after work has begun.
9. Corrections preserve the original value, corrected value, operator, time, and reason.
10. Backward workflow moves clear or supersede invalid later state while preserving the audit history.
11. Re-cuts and repeat stains create new records linked to the earlier work.
12. Controlled vocabularies use stable identifiers so renaming a displayed stain does not fragment historical reports.
13. Timestamps use one consistent stored format and include sufficient timezone context for later interpretation.
14. Inventory-ending actions never remove historical samples, blocks, cut orders, or slides from reports.
15. A batch action preserves individual member history and cannot silently leave a partially moved selection.
16. Concise timelines contain physical events; queue-status changes remain available in activity history.
17. A completed checklist remains linked to the exact protocol version used.
18. Visual themes never change the meaning of workflow states or hide required status information.

## 8. Minimum entity set for implementation planning

The implementation plan should account for these entities even if some are introduced in later migrations:

- `projects`
- `operators`
- `samples`
- `blocks`
- `cut_orders`
- `cut_groups`
- `slides`
- `stain_catalog`
- `planned_stains`
- `stain_assignments`
- `batches`
- `batch_members`
- `protocol_templates`
- `protocol_template_steps`
- `checklist_instances`
- `checklist_item_results`
- `locations`
- `workflow_events`

Current-stage columns may be retained as cached summaries for fast board queries, but the event history is the authoritative record of actions and corrections.

## 9. Phase-zero acceptance scenarios

The product specification is considered viable only if it supports all of the following scenarios without relying on free-text notes for core state:

### Scenario A: Routine sample to inventory

An operator logs a sample, completes its required preprocessing checklist, starts processing, records pickup and embedding, and finds the resulting block in Embedded Inventory.

### Scenario B: Five slides, three stains, two extras

An operator requests five duplicates at one depth from an embedded block. Histometer creates five slide records. The operator assigns three different stains to three chosen slides and marks the remaining two as extra. No assignments occur automatically.

### Scenario C: Use an extra slide later

Days or weeks later, an operator finds one of the two extra slides, assigns a stain, and sees it enter the stain queue with its complete parent history intact.

### Scenario D: Partial cutting failure

Five slides were requested but only four usable slides were produced. The operator records the failed slide explicitly, classifies the four produced slides, and optionally creates a replacement cut request.

### Scenario E: Re-cut an embedded block

An operator returns to a block that already produced slides, requests a deeper level, and creates new slides without changing the earlier cut order or slide records.

### Scenario F: Shift handoff

A second operator opens Histometer and can determine what is ready, who last acted, which items are blocked, which slides need assignments, and what is overdue without asking the first operator.

### Scenario G: Correction

An operator corrects an erroneous timestamp or classification. The current display becomes correct while the original value and correction reason remain available in history.

### Scenario H: Exhausted block

An operator marks a block exhausted with a reason. It disappears from active Embedded Inventory but remains linked to all samples, cuts, slides, stains, exports, and audit history.

### Scenario I: Start a processing batch

An operator shift-selects twelve compatible samples in Pre-processing and drags them to Processing. A batch review confirms the short-processing protocol, operator, start time, and members. One collapsed batch row appears with a twelve-member count and timer; expanding it shows each sample.

### Scenario J: Batch exception

One member of a processing batch cannot complete with the other eleven. The operator records an exception and reason. The eleven eligible members advance together while the excluded member remains visible with its own accurate state and history.

### Scenario K: Section group expands into slides

A request for six slides at 50 um appears as one compact row in Needs Sectioning. Once the slides are produced, the board still shows one grouped parent row with a six-slide summary. The assignment view exposes six individual rows so each slide can receive a stain or be marked Extra without creating six bulky board cards.

### Scenario L: Versioned protocol checklist

A technician starts a staining batch using a named protocol checklist, completes its required steps, and records an exception on one slide. A later edit to the protocol template does not alter the completed batch's checklist or version history.

### Scenario M: Theme and density preference

An operator chooses dark theme and compact density. Another operator uses high contrast and comfortable density. Both see the same records, selection state, warnings, and workflow meaning.

## 10. Decisions established by this specification

- The standard UI term is **Sample**.
- Embedded material is represented as an explicit **Block**.
- A sample-to-block relationship supports one or more blocks, while the initial UI may default to one.
- Preliminary section plans and planned stains are non-executing plans.
- Cut-order submission creates individual planned slide records.
- Every requested duplicate maps to one individually tracked slide.
- Planned stains are never assigned automatically.
- Every produced slide must be classified before leaving the assignment checkpoint.
- Extra slides are explicit inventory and can be stained later.
- Embedded blocks remain in inventory while downstream work proceeds.
- Workflow queues use compact selectable list rows rather than large cards.
- Shift-click, modifier-click, bulk selection, batch drag-and-drop, and a keyboard bulk-move alternative are required.
- Processing and similar physical group work create persistent, expandable batches.
- Cut groups remain one collapsed work row before and after cutting, while their produced slides remain individually accessible and traceable.
- The concise laboratory timeline contains physical events, not "needs" statuses.
- Full status and administrative history remains available in the separate activity history.
- Most operational stages may use versioned protocol checklists at item or batch scope.
- Light, dark, high-contrast, and operating-system themes are required; density is a separate preference.
- Multiple operators share one operational truth, and actions are attributable.
- The first deployment may use a shared workstation; simultaneous multi-workstation operation is not assumed by this specification.
- Imaging and analysis remain downstream stages, with their detailed request models deferred to a later specification.

## 11. Explicitly deferred scope

- Microscope or scanner instrument integration.
- Storage of large microscopy image files inside Histometer.
- Detailed imaging and analysis request schemas.
- Reagent and consumable inventory.
- Billing or cost accounting.
- SharePoint synchronization.
- Simultaneous multi-workstation architecture.
- Regulatory certification or electronic signatures.
- Automated stain assignment.
