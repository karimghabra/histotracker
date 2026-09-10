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
pnpm test:legacy           # a REAL populated pre-0023 DB, both upgrade paths
cd src-tauri && cargo check
```

`pnpm test` needs **Node 22+** (it uses the built-in `node:sqlite`). All of the
above should pass before pushing.

Two Playwright suites drive the real app in Chromium against the sql.js Tauri
shim, and a schema or workflow change should run both:

```bash
npx playwright test                                       # e2e
npx playwright test --config playwright.stress2.config.ts  # scale + invariants
```

If Chromium fails to launch with `libnspr4.so: cannot open shared object file`
and there is no sudo, fetch the libraries without root: `apt-get download
libnspr4 libnss3 libasound2t64`, `dpkg-deb -x` each, and put the extracted
`usr/lib/x86_64-linux-gnu` on `LD_LIBRARY_PATH`. **Do not edit files while
either suite runs** — the dev server hot-reloads mid-test and the failures look
like real defects.

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

### The other hand-maintained ports — and why `pnpm build` will not save you

`tsconfig.json` includes **`src` only**, so nothing under `tests/` or `scripts/`
is typechecked. Changing a shared input type (e.g. adding a field to
`NewSampleInput`) compiles green while every hand-written caller outside `src`
breaks at runtime. Update all of these in the same change:

- `scripts/workflow-test.mjs` — the `addSample` port (and a gate).
- `scripts/legacy-db-upgrade-test.mjs` — its own copy of `ensureRuntimeSchema`,
  guarded by `assertPortMatchesSource()`, which fails loudly when it falls
  behind `db.ts`. A new converged column goes here too.
- `tests/stress2/driver.ts` — the `addSample` payloads in `seed()` **and**
  `seedLarge()`; plus the inline one in `tests/stress2/13-abuse.spec.ts`. Miss
  one and the whole stress2 harness stops running.

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
  databases and older backups. See `docs/shared_data_sync.md` §1a. A column may
  skip its numbered migration and live in `ensureRuntimeSchema()` alone when a
  migration would break rollback to the build in use or a backup revert —
  precedent `samples.embedding_notes` (#137, https://github.com/karimghabra/histotracker/pull/138).
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

- **Feature branches do not pick versions.** The build in use is cut from a
  long-running `claude/**` release line that is ahead of `master` (check
  `gh release list`); a bump on a branch off `master` names a version
  *behind* what ships. Whoever cuts the release bumps it, in sync across
  `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (and the
  `Cargo.lock` / `package-lock.json` entries). Put changelog prose under the
  existing unreleased heading.
- **Every push to a `claude/**` branch republishes the release for its
  version**, so a release-line push must bump first or it overwrites a release
  a tester is already using.
- **Every PR states its compatibility with the version in use** (a standing
  requirement from the lab): whether its schema change, if any, applies cleanly
  to the release line's database, and how it merges onto that line.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
