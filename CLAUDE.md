# Histometer — repo guide for agents

Histology lab workflow tracker. **Tauri 2** desktop app: a **Rust** shell
(`src-tauri/`) hosting a **React 19 + TypeScript + Vite** frontend (`src/`).
Package manager is **pnpm**. Data lives in a local **SQLite** database
(`sqlite:histometer.db`) via `tauri-plugin-sql`.

## Verify before you commit

```bash
pnpm install
pnpm build                 # tsc typecheck + vite build
pnpm test                  # data-layer workflow harness (see below)
pnpm test:ui               # component/render tests (vitest + RTL, jsdom)
cd src-tauri && cargo check
```

`pnpm test` needs **Node 22+** (it uses the built-in `node:sqlite`). All four
should pass before pushing.

## Driving the real UI — Playwright (`tests/e2e/`)

```bash
pnpm test:e2e                                  # whole suite
npx playwright test tests/e2e/logs.spec.ts     # one file
npx playwright test -g "rename and delete"     # one test by title
pnpm test:e2e:headed                           # watch it run
pnpm test:e2e:ui                               # interactive picker/inspector
npx playwright show-trace test-results/<dir>/trace.zip
```

These run the **real app** — real `db.ts`, real hooks, real components — in
Chromium. `vite.config.playwright.ts` aliases `@tauri-apps/plugin-sql` to a
sql.js shim (`src/test/browser-sql-shim.ts`) that loads the **actual
migrations**, so the schema can't drift; `tauri dev` and production are
untouched. That config also stubs a fake GitHub remote, so **workstation↔viewer
sync is drivable** from two browser contexts against one shared store
(`sync.spec.ts`).

Conventions worth copying:

- `page.goto("/?freshdb=1")` starts from a clean DB (honoured once per load, so
  a restore/undo reopen doesn't wipe itself).
- Seed helpers at the top of `workflow.spec.ts` (`seedSample`,
  `completePreprocessing`), and a `dragOnto()` that clears dnd-kit's 5px
  activation threshold — reuse them rather than re-deriving the drag.
- Prefer **label/role locators over positional ones**. `getByRole("textbox")
  .nth(1)` silently retargets when a panel gains an input; `Field` renders a
  wrapping `<label>`, so `getByLabel("Name", { exact: true })` is stable.
- Several bare names render in *both* the sidebar and a dialog — scope to the
  dialog's own format (e.g. `"EE · Enthesis Engineering"`) or you'll trip
  strict mode once the sidebar list loads.

`playwright.showcase.config.ts` → `tests/tutorial/` regenerates the tutorial
screenshots (`docs/tutorial/img/`). It's deliberately a separate `testDir` so it
never gates a release; run it on demand with
`npx playwright test --config playwright.showcase.config.ts`.

If the environment ships a Chromium whose build number doesn't match the pinned
`@playwright/test` (common in sandboxes and CI images that can't download one),
point both configs at it — otherwise they behave exactly as before:

```bash
CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm test:e2e
```

Note the e2e suite is **not** part of CI (`.github/workflows/test.yml`); it's a
local correctness tool, so run it yourself when touching board/drawer/sync UI.

## The test harness — keep it green, keep it in sync

`scripts/workflow-test.mjs` loads the **real** migrations
(`src-tauri/migrations/*.sql`) into an in-memory SQLite DB and exercises the lab
pipeline. Run it with `pnpm test` (add `--verbose` to list every PASS).

- **Invariants** must always pass — a failure is a regression.
- **Issue gates** (`issue(N, …)`) assert desired behaviour for GitHub issue N.
  A gate may be marked `{ knownOpen: true }`, meaning the bug isn't fixed yet
  (it's expected to fail and does not fail the run). When you fix issue N, clear
  its `knownOpen` flag so the gate becomes a hard check.
- Exit code is non-zero on any *unexpected* result (broken invariant, or a
  `knownOpen` gate that started passing — go clear the flag).

**The SQL helpers in the harness are a hand port of `src/lib/db.ts`.** The
schema is loaded verbatim from the migrations (so it can never drift), but the
query logic is duplicated. **When you change a workflow query in `db.ts`, mirror
the change in the harness port** and add/adjust a gate. This is what turns a
future regression into a red test instead of a shipped bug.

## Where things live

- `src/lib/stages.ts` — the workflow stage graph and board-queue layout.
- `src/lib/db.ts` — all SQLite access (blocks/samples, `section_requests` = cut
  groups, `slides` = physical slides, processing batches, checklists, requests).
- `src/hooks/useActions.ts` — the mutation layer; every action does its write,
  invalidates queries, and records an **undo/redo** command (`src/lib/undo.ts`).
- `src/components/Board.tsx` — the drag-and-drop board.
- `src-tauri/migrations/NNNN_*.sql` — schema; **append-only, numbered**. Never
  edit an applied migration; add a new one. Register it in `src-tauri/src/lib.rs`
  (the migration list is explicit, not auto-discovered). **Additive only** — new
  migrations `ADD COLUMN`/`CREATE TABLE`; never drop/rename a column a shipped
  build still reads (backups, sync, and undo all restore raw DB *images*, so an
  older image must stay openable). If the new column is read/written at runtime,
  also add it to `ensureRuntimeSchema()` in `src/lib/db.ts` — `getDb()` converges
  it on every DB (re)open, which is what keeps updates compatible with existing
  databases and older backups. See `docs/shared_data_sync.md` §1a.
- `src-tauri/src/backup.rs` + `src/lib/backup.ts` + `useBackupScheduler.ts` —
  robust local DB backups (atomic write, validation, rotation) taken every N
  hours during the working day, with revert-to-backup in `BackupsDialog.tsx`.

## Docs worth reading

- `docs/issue_remediation_plan.md` — every open GitHub issue mapped to root
  cause + fix + status. Start here when picking up issue work.
- `docs/shared_data_sync.md` — the workstation/viewer sync design. **§1 is a
  compatibility contract:** the synced payload *is* the raw SQLite file, so the
  **schema is the wire format**. A schema change requires deploying a matching
  build to every instance and a version bump. Additive migrations are safe;
  destructive ones are not.

## Releases

The Windows installer is built in CI (`.github/workflows/build-installer.yml`)
on every push to a `claude/**` branch (and on `v*` tags). It publishes a GitHub
Release tagged `app-v<version>`, where `<version>` comes from
`src-tauri/tauri.conf.json`.

- Keep the version in sync across `package.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml` (and the `Cargo.lock` / `package-lock.json` entries).
- **Every push to the branch republishes the release for the current version.**
  Bump the version *before* pushing new work, or you'll overwrite a release a
  tester is already using.
- Record user-facing changes in `CHANGELOG.md`.
