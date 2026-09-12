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
pnpm test:compat           # the released build in use vs this tree, both directions
pnpm test:release          # release checks' own tests, then this tree's version sources agree
cd src-tauri && cargo check && cargo test --lib
```

`pnpm test` needs **Node 22+** (it uses the built-in `node:sqlite`). All of the
above should pass before pushing.

Playwright suites drive the real app in Chromium against the sql.js Tauri
shim. A schema or workflow change should run the first two; the third walks the
screen and Undo/Redo (`docs/stress_test_v3.md`):

```bash
npx playwright test                                       # e2e
npx playwright test --config playwright.stress2.config.ts  # scale + invariants
npx playwright test --config playwright.stress3.config.ts  # the explorer
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
- `tests/compat/lab.ts` — the `addSample` payload in `newSample()`, and
  `runTheLab()` must write every column you add (the compat harness fails on a
  new column left at its default).
- Inline `db.addSample({...})` payloads in e2e and tutorial specs;
  `git grep -n 'slide_notes:' tests` lists every hand-written payload.

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
  also add it to `ensureRuntimeSchema()` in `src/lib/db.ts`.
  `getDb()` converges it on every DB (re)open, so an image swapped in at runtime has every column, one with no numbered migration included.
  See `docs/shared_data_sync.md` §1a.
  A column may skip its numbered migration and live in `ensureRuntimeSchema()` alone when a migration would break rollback to the build in use, which refuses a database recording a version it does not know, and so does every sync viewer still on it.
  Precedent: `samples.embedding_notes` (#137, https://github.com/karimghabra/histotracker/pull/138).
- `src-tauri/src/backup.rs` + `src/lib/backup.ts` + `useBackupScheduler.ts` —
  robust local DB backups (atomic write, validation, rotation) taken every N
  hours during the working day, with revert-to-backup in `BackupsDialog.tsx`.
  An image from elsewhere, a backup or a pulled sync snapshot, goes through `bringImageUpToDate()` (`src/lib/db.ts`) before it is swapped in.
  That runs `db_migrate_image` (`src-tauri/src/migrate.rs`), which puts the image through this build's migrations so the migration record in the file stays true, or refuses it with nothing changed.
  The test harnesses model that command in `src/test/sqlx-migrator.ts`, refusal wording included; the CI `rust` job runs the real command's tests.

## Docs worth reading

- `docs/issue_remediation_plan.md` — every open GitHub issue mapped to root
  cause + fix + status. Start here when picking up issue work.
- `docs/shared_data_sync.md` — the workstation/viewer sync design. **§1 is a
  compatibility contract:** the synced payload *is* the raw SQLite file, so the
  **schema is the wire format**. A schema change requires deploying a matching
  build to every instance and a version bump. Additive migrations are safe;
  destructive ones are not.

## Releases

Releases are cut from **master only**, by starting **Cut a release** by hand on
master (`gh workflow run cut-release.yml --ref master`). Its
`plan` job (`node scripts/release-check.mjs plan`) refuses any other ref, a
version already released or not newer than the newest, version files out of
step, a `CHANGELOG.md` with no `## <version>` section, and any `app-v*` tag
master lacks; it then runs all of `test.yml` on that
commit and publishes `app-v<version>` tagged there. Procedure:
`docs/releasing.md`. Why: `docs/release_line_reconciliation.md` (0.14.3 to
0.17.0 shipped from branches master never received).

- **The release workflow lives at `.github/workflows/cut-release.yml`, and that path never moves back.**
  GitHub runs a push-triggered workflow from the copy of the file in the pushed commit, so master's master-only guard binds only commits that descend from it.
  The pre-0.18.0 copy at `.github/workflows/build-installer.yml` still sits on unmerged branches, and a push of one at an already-released version replaces that release's installers while leaving its tag in place, which no check can see.
  That path is now a workflow master does not have, disabled in the repository's Actions settings.
  Never reintroduce it, and never give this workflow a `push` or tag trigger; a tag ruleset substitutes for neither rule (`docs/releasing.md`).
- **Master's version names the next release.** It is written in five places
  kept in step: `package.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`, and the `Cargo.lock` / `package-lock.json` entries
  (`node scripts/release-check.mjs versions`). Bump it in the PR that prepares
  a release, not in feature PRs. Merging publishes nothing.
- **Never rebase, move or rebuild a released commit.** The release-integrity
  workflow fails every PR while a release tag is missing from master or
  master's version is behind the newest release; the fix is a merge.
- **Every PR states its compatibility with the version in use** (a standing
  requirement from the lab): whether its schema change, if any, applies cleanly
  to the database of the release in use. The proof is `pnpm test:compat` (CI
  job `release-compat`): the release's own tagged data layer and this tree
  open, work on and revert each other's database, and sync it
  (`docs/release_compat.md`). When the lab installs a new release, bump
  `IN_USE_RELEASE` in `scripts/compat-releases.mjs`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
