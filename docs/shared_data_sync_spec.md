# Histometer — Shared Data Sync (spec + implementation status)

This is the original design + handoff spec for the "shared data layer over git"
feature (viewer/workstation sync).

> **Status: implemented.** The frontend (steps 1–8 below) is built and both
> `cargo check` and `pnpm build` pass. For the maintainer-facing reference —
> architecture, the schema/compatibility contract for big updates, the file
> map, and the operational runbook — see
> [`shared_data_sync.md`](./shared_data_sync.md). This file is kept as the
> historical spec and record of the decisions settled with the user.

---

## Implementation status & handoff

### Done
Rust backend — commit "Add GitHub REST sync backend + stain_requests migration":
- `src-tauri/src/sync.rs` — all sync backend commands (see reference below),
  plus a per-install `install_id` for the single-writer claim.
- `src-tauri/src/lib.rs` — `mod sync;`, migration 14 registered, `read_file`
  command added, all `sync::*` commands registered in the invoke handler.
- `src-tauri/migrations/0014_stain_requests.sql` — durable request table.
- `src-tauri/Cargo.toml` — `reqwest = "0.13"` (**feature `rustls`**, json) +
  `base64 = "0.22"`.

Frontend — implemented across `src/lib/{syncConfig,githubSync,export,db,types}.ts`,
`src/hooks/{useSync,useData}.ts`, and
`src/components/{SetupScreen,RequestStainDialog,RequestsInbox}.tsx` + `App.tsx`.
Also added: the single-writer workstation claim (§5 of the reference doc).

Build fix applied during verification: the backend originally declared the
reqwest feature as `rustls-tls`, which does not exist in reqwest 0.13 — corrected
to `rustls`. Linux builds need the GTK/WebKit system libs (see the reference doc).

### Rust command reference (already implemented, call from TS via `invoke`)
Config (token kept in a local `sync-config.json`, NEVER in the snapshot DB):
- `sync_config_get() -> { role, repo_owner, repo_name, operator_name, operator_initials, last_synced_version, configured, has_token }` (token redacted)
- `sync_config_set({ role, repo_owner, repo_name, token?, operator_name, operator_initials })` (empty/absent token keeps existing)
- `sync_set_last_version(version: string)`
GitHub REST (read repo/token from config):
- `github_get_file(path) -> { content, sha } | null` (null on 404)
- `github_put_file(path, content, sha?, message) -> sha`
- `github_delete_file(path, sha, message)`
- `github_list_dir(path) -> [{ name, path, sha }]` (`[]` on 404)
- `github_upload_release_asset(tag, asset_name, bytes: number[], content_type)`
- `github_download_release_asset(tag, asset_name) -> bytes: number[]`
- `github_validate() -> repo_full_name` (setup check)
File I/O (for snapshot DB):
- `save_file(path, contents: number[])` (existing)
- `read_file(path) -> number[]` (new)

### DB-path trick (avoids hardcoding the tauri-plugin-sql storage dir)
The workstation must read the live SQLite file and the viewer must overwrite it.
Get the exact path at runtime from SQLite itself:
`SELECT file FROM pragma_database_list WHERE name='main'` → pass that path to
`read_file` / `save_file`. Do not hardcode app_config/app_data dirs.

### Remaining work (frontend — do WITH the compiler running) — ✅ DONE
All steps below are implemented; kept here as the record of what was built.
Build order (phased), reusing existing patterns:
1. `src/lib/syncConfig.ts` — typed `invoke` wrappers for the config commands.
2. `src/lib/githubSync.ts` — `invoke` wrappers for the github commands + high-level
   `publishSnapshot()`, `pullSnapshotIfNewer()`, `submitRequest()`, `drainRequests()`,
   and manifest read/write. Manifest shape: `{ version, updated_at, db_asset, workbook_asset }`.
   Release tag: `snapshot-latest`. Assets: `histometer.db`, `histometer-status.xlsx`.
3. `src/lib/export.ts` — export `SAMPLE_COLUMNS`/`SLIDE_COLUMNS`; add
   `buildStatusWorkbookBytes(): Uint8Array` producing a 2-sheet workbook
   ("Sample Status", "Slide Status") via `write-excel-file/browser` with
   `stickyRowsCount: 1` + header style. (AutoFilter likely unsupported by
   write-excel-file — if pre-applied filters are required, switch this one
   generator to ExcelJS or Rust `rust_xlsxwriter`.)
4. `src/lib/db.ts` — add `stain_requests` queries (`insertStainRequest`,
   `listStainRequests`, `setStainRequestStatus`), plus `getDbFilePath()`
   (PRAGMA) and `resetDb()` (close + clear the memoized promise) for the viewer
   DB swap.
5. `src/lib/types.ts` — add `StainRequest` interface.
6. `src/hooks/useSync.ts` — interval + manual "Sync now"; workstation runs the
   publish cycle, viewer runs the pull cycle. Invalidate React Query on new data.
7. `src/components/SetupScreen.tsx` — first-run onboarding (role + repo + token +
   operator name → `sync_config_set` → `github_validate`). Gate `App` on
   `sync_config_get().configured`.
8. Role-aware UI in `App.tsx`: viewer disables mutation controls + shows
   "Request stain" (new `RequestStainDialog.tsx`) + own pending requests;
   workstation shows a "Requests" inbox (`RequestsInbox.tsx`) + sync status.

### Viewer DB swap sequence
`resetDb()` (close connection) → `save_file(dbPath, downloadedBytes)` →
re-`getDb()` → invalidate all queries. Viewer role must also disable writes at
the UI layer (and ideally guard the data layer).

### Prerequisites (before running e2e)
- Create a **separate private** data repo (e.g. `karimghabra/histometer-data`).
- Fine-grained PAT scoped to that repo, Contents read/write. Never commit it.

### Verification (network-enabled session)
- `cd src-tauri && cargo check` ; `pnpm install && pnpm build`.
- Two-instance e2e: run one Workstation + one Viewer against a throwaway private
  repo; workstation publishes DB+xlsx+manifest; viewer pulls read-only, submits a
  request; workstation drains it into its inbox and resolves; status shows back
  on the viewer. Confirm the token never lands in `histometer.db` or any commit.

---

## Design (settled with the user)

- **Remote members: "view + request."** Mostly view; can submit append-only
  requests. Not full remote editors.
- **Sync medium: DB snapshot (drives the rich in-app viewer) + a 2-sheet Excel
  workbook** (human-facing + SharePoint/posterity + zero-install glance).
- **Cadence:** automatic periodic sync + a manual "Sync now" button.
- **Transport:** a private GitHub repo reached via the HTTPS REST API — no git
  install, no SSH keys on laptops. Auth = one shared fine-grained token in a
  local config file (extractable-from-app trade-off accepted for a trusted lab
  repo with no PHI).
- **Model: snapshot-down + requests-up** — conflict-free by construction (one
  writer publishes; viewers only add uniquely-named request files).

### Preventing repo clutter
Requests are transient: created by a viewer, then drained + deleted by the
workstation once imported into the DB (the permanent record). The heavy DB +
xlsx are overwritten Release assets, never committed — so the git tree stays
tiny (`manifest.json` + a near-empty `requests/`) and never grows.

### No-PHI handling (decided)
Trust the lab users; do NOT special-case free-text fields — descriptions/notes
are important for the logs and are included in full. Safety comes from the repo
being private, not from field filtering.

### Data-model notes
- A `samples` row IS the embedded block (no separate blocks table).
- `section_requests` is the cut order/group; slides carry stain assignment as
  columns (`purpose`, `assay_type`, `assay_name`, `stain_name`, `control_agent`).
- Existing export column sets + `listAll*()` queries in `src/lib/db.ts` and
  `src/lib/export.ts` are the reuse basis for the workbook.

---

## Later builds (not this feature)
The broader "next version" also covers new features, bug-fixes, and code cleanup
(user to specify). Initial cleanup candidates already spotted: unused `src/App.css`,
`src/assets/react.svg`, `public/tauri.svg`, and the stale `index.html` `<title>`.
