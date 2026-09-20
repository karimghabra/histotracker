# Histometer — repo guide for agents

Histology lab workflow tracker. **Tauri 2** desktop app: a **Rust** shell
(`src-tauri/`) hosting a **React 19 + TypeScript + Vite** frontend (`src/`).
Package manager is **pnpm**. Data lives in a local **SQLite** database
(`sqlite:histometer.db`) via `tauri-plugin-sql`.

## Running the app: never on the maintainer's display

These rules bind every agent, including automated validation and test agents.

1. This repository is developed on a WSL machine where `DISPLAY=:0` and the Wayland socket `wayland-0` are the maintainer's REAL Windows desktop, not a virtual display.
   Never launch the Histometer desktop app (the Tauri build), a browser in headed mode, or anything that opens a window against them.
   Never set `DISPLAY`, `WAYLAND_DISPLAY` or `XDG_RUNTIME_DIR` to reach one.
2. Checks that need the running app run only under a virtual display in CI (for example `xvfb-run` on a GitHub Actions Linux runner), or not at all.
   If a check cannot run without a real display, report it as an untested scenario.
   That is a correct result, never a reason to look for a display.
3. Never contact real GitHub, Google, or any live service with any token, real or fake, from a test or a validation run.
   Use the fakes the test suites provide.
4. Never read, open, or write the maintainer's live data.
   Every run uses a scratch location created for it.
5. Screenshots are not evidence here.
   Assert on text, structure and state.

The commands below already honour these rules: `pnpm verify`, `pnpm test`, `pnpm test:ui`, and the headless browser suites against the sql.js Tauri shim.
`tests/suites.json` says which suite runs where.

## Verify before you commit

`pnpm verify` (`scripts/verify.mjs`) is the one command that answers "did this
update break what already works?" Four layers, cheapest first, stopping at the
first red one:

1. **data**, in parallel: typecheck, the workflow harness, the legacy upgrade,
   vitest, `test:scenarios`, `test:compat`, the release checks, the suite manifest, the E4
   capture guard (`scripts/no-unasserted-captures.mjs`, keeps screenshots out
   of `tests/e2e`), and the production `vite build` plus G1's bundle check
   (`scripts/bundle-check.mjs`, which catches a dropped Tailwind plugin or a leaked
   test shim, which every browser suite is blind to since none of them serve
   the production Vite config).
2. **render** (`tests/render/`): the pull request's base and this tree served
   side by side in the same run, the same small lab built on both, ARIA
   structure diffed and layout/contrast audited at two widths - the screenshot
   comparison without a screenshot or a stored baseline.
3. **e2e**: `tests/e2e` at retries 0, a smoke set first (`smoke`, `workflow`,
   `sync`, `sync-pull-relaunch`), then the rest.
4. **screenshot** (`--screenshot`, CI only, never on a lab machine): the
   captures E4 moved out of `tests/e2e` into `tests/screenshot/`, run only
   once 1-3 are green, per the captain's ruling that screenshots are fine as
   long as the lightweight checks run first.

CI (`.github/workflows/test.yml`) runs the same layers as separate jobs; the
`screenshot` job's `needs:` gates it behind the others. `pnpm verify --only
data` (or `render`, `e2e`) runs one layer alone; `--keep-going` does not stop
at the first red layer.

```bash
pnpm install
pnpm verify                # the layered gate above; also run individually:
pnpm build                 # tsc typecheck + vite build
pnpm test                  # data-layer workflow harness (see below)
pnpm test:ui               # component/render tests (vitest + RTL, jsdom)
pnpm test:scenarios        # lab-record scenarios on the REAL db.ts (tests/scenarios)
pnpm test:legacy           # a REAL populated pre-0023 DB, both upgrade paths
pnpm test:compat           # the released build in use vs this tree, both directions
pnpm test:release          # release checks' own tests, then this tree's version sources agree
pnpm test:suites           # every suite is accounted for in tests/suites.json (see below)
cd src-tauri && cargo check && cargo test --lib
```

`pnpm test` needs **Node 22+** (it uses the built-in `node:sqlite`). All of the
above should pass before pushing.

`test:scenarios` is where a data-layer behaviour goes when it must be tested on the real `src/lib/db.ts` rather than a port of it (`tests/scenarios/lab.ts` opens a lab the way the app does).
An open issue is a scenario marked `it.fails` (vitest) or `test.fail()` (Playwright, `tests/e2e/open-issues.spec.ts`) with a comment naming it; CI stays green until the fix lands, then goes red until the marker is removed, so **the pull request that fixes an issue deletes its marker**.
stress2, stress3 and stress v1's `06`/`07` run nightly on master (`.github/workflows/nightly.yml`), a failure opening an issue; they are not in `pnpm verify`.

`tests/suites.json` is the answer to what a green check proved.
It lists every suite this repository has, with either the command a pull request's CI runs it with or the reason CI does not run it.
`scripts/test-coverage.mjs` (CI job `suites`) fails when the tree holds a suite the file does not account for - a `package.json` script, a directory under `tests/`, or a vitest/Playwright config - or when the file claims a command no workflow runs, and it posts the unrun suites on every pull request.
So **a new suite, script, test directory or test config must be added to `tests/suites.json` in the same change**, or CI goes red.
This is the same mechanism as projtracker's `tests/suites.json`, read the same way.

`pnpm test:legacy` regenerates its fixture, so it leaves
`tests/fixtures/legacy-pre-0023.b64` modified in git with no change of substance.
Restore it (`git checkout --`) rather than committing it.

Playwright suites drive the real app in Chromium against the sql.js Tauri
shim. A schema or workflow change should run the first two; the third walks the
screen and Undo/Redo (`docs/stress_test_v3.md`):

```bash
npx playwright test                                       # e2e
npx playwright test --config playwright.stress2.config.ts  # scale + invariants
npx playwright test --config playwright.stress3.config.ts  # the explorer
```

**What the whole set costs**, measured 2026-09-14 on the lab's WSL2 host,
idle figures. Budget from a loaded figure when other work shares the machine:
running several browser suites at once here inflated an unrelated e2e test's
wait past its timeout. The same caution as "Do not edit files while either
suite runs" below applies to running two heavy suites side by side.

| suite | idle | scope |
| --- | --- | --- |
| `pnpm verify --only data` | 21s | tsc, harness, legacy, vitest, scenarios, compat, release, suites, E4 guard, G1 build+bundle |
| `pnpm verify --only render` | 30s | 8 surfaces x 2 widths, base vs head |
| `pnpm verify --only e2e` (= `npx playwright test`, retries 0) | 514s | 156 tests, `tests/e2e` |
| `pnpm test:screenshot` | ~130s | 35 tests writing the 26 captures E4 moved here |
| stress2 (nightly in CI) | 702s | 14 tests |
| stress3 (nightly in CI) | 363s | 13 tests |

`pnpm verify` (without `--screenshot`) runs the first three in sequence, stopping at the first red one.

**Never run the packaged desktop app or its suite on the lab machine.** It opens
real windows on the desktop someone is working on. Browser suites are headless;
keep them that way (`DISPLAY` unset) so nothing can reach the desktop.

If Chromium fails to launch with `libnspr4.so: cannot open shared object file`
and there is no sudo, fetch the libraries without root: `apt-get download
libnspr4 libnss3 libasound2t64`, `dpkg-deb -x` each, and put the extracted
`usr/lib/x86_64-linux-gnu` on `LD_LIBRARY_PATH`. If the environment ships a
Chromium whose build number does not match the pinned `@playwright/test` and
cannot download one, point every config at it with `CHROMIUM_PATH=/path/to/chromium`
(unset, nothing changes). **Do not edit files while either suite runs** — the dev
server hot-reloads mid-test and the failures look like real defects.

Conventions in the specs, worth following rather than re-deriving:

- `page.goto("/?freshdb=1")` starts from a clean DB, honoured once per load, so a
  restore's reopen does not wipe itself (`src/test/browser-sql-shim.ts`).
- The shim copies the database file instantly, which hides any race that lives in a
  copy's duration. `window.__SNAPSHOT_IPC_MS__` gives `read_file`/`save_file` of the
  database the time they take on a lab-sized one (`tests/e2e/undo-races.spec.ts`).
- **Address inputs by label or role, never by position.** `getByRole("textbox").nth(1)`
  silently retargets when a panel gains a field, and a wrong guess edits the wrong
  column while a loose text assertion still passes; `Field` (`src/components/ui.tsx`)
  renders a wrapping `<label>`, so `getByLabel("Name", { exact: true })` is stable.
- Several names render in both the sidebar and a dialog, so scope the assertion to the
  dialog (by role, or by its own `"<code> · <name>"` row format) or strict mode trips
  once the sidebar list loads.
- Reuse a spec's own `seedSample`/`dragOnto` helpers: `dragOnto` clears dnd-kit's 5px
  activation threshold, which a hand-rolled drag does not.

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
  invalidates queries, and records an **undo/redo** entry (`src/lib/undo.ts`).
  Undo is a journal, not a copy of the file: persistent triggers that `getDb()` installs write each change's inverse SQL into `undo_journal` (`src/lib/undoJournal.ts`), and undo replays one entry's range of it in a single Rust transaction (`src-tauri/src/undo_journal.rs`, modelled for the browser and compat harnesses by `src/test/undoJournalCommands.ts`; change the two together).
  Every action, undo and redo enters the write lane (`src/lib/writeLane.ts`) at the moment it is called, before any await, so they take effect in gesture order; a new undoable write goes through `useActions` (or `inLane` plus `journalHead()`, as `ProtocolChecklist` does), never around it - the timer-driven writes (the sync drain, the processing auto-advance) too.
  Each inverse is guarded by what its change left in the row, so a replay whose range no longer matches the file - a write landed outside it - is refused whole, with nothing changed, rather than restoring a full row over that write.
  A new table or column is journaled automatically; a table undo must not rewind (session state) is listed in `NOT_JOURNALED`.
- `src/components/Board.tsx` — the drag-and-drop board.
- `src-tauri/migrations/NNNN_*.sql` — schema; **append-only, numbered**. Never
  edit an applied migration; add a new one. Register it in `src-tauri/src/lib.rs`
  (the migration list is explicit, not auto-discovered). **Additive only** — new
  migrations `ADD COLUMN`/`CREATE TABLE`; never drop/rename a column a shipped
  build still reads (backups and sync restore raw DB *images*, so an
  older image must stay openable). If the new column is read/written at runtime,
  also add it to `ensureRuntimeSchema()` in `src/lib/db.ts`.
  `getDb()` converges it on every DB (re)open, so an image swapped in at runtime has every column, one with no numbered migration included.
  See `docs/shared_data_sync.md` §1a.
  A column may skip its numbered migration and live in `ensureRuntimeSchema()` alone when a migration would break rollback to the build in use, which refuses a database recording a version it does not know, and so does every sync viewer still on it.
  Precedent: `samples.embedding_notes` (#137, https://github.com/karimghabra/histotracker/pull/138).
- `src-tauri/src/backup.rs` (thin Tauri commands) over `backup_fs.rs` (the file logic, tested on temp dirs; `scripts/backup-mutants.sh` proves those tests can fail) + `src/lib/backup.ts` + `useBackupScheduler.ts` —
  robust local DB backups (atomic write, validation, rotation) taken every N
  hours during the working day, with revert-to-backup in `BackupsDialog.tsx`.
  An image from elsewhere, a backup or a pulled sync snapshot, goes live only through `swapInImageFromElsewhere()` (`src/lib/db.ts`).
  That first runs `db_migrate_image` (`src-tauri/src/migrate.rs`), which puts the image through this build's migrations so the migration record in the file stays true, or refuses it with nothing changed.
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
