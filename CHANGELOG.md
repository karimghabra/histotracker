# Changelog

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
