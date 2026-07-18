# Changelog

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
