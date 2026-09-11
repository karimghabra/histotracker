# Release compatibility: does this change work with the build the lab runs?

`pnpm test:compat` answers that with a test you can watch pass. It takes a real
released build and this checkout, and has each one open, read, and work on a
database the other one wrote.

```bash
pnpm test:compat                      # the release in use, and only that
pnpm test:compat app-v0.18.0          # any release, by tag (several may be named)
pnpm test:compat origin/some-branch   # or any ref, such as a branch tip
```

CI runs it on every push and pull request (the `release-compat` job in
`.github/workflows/test.yml`).

## What is real and what is modelled

**Real: each build's own code.** The release is extracted from its git tag
(`app-v<version>`, which the installer workflow creates when it publishes that
version) into `.compat/`, and its version is checked against the tag. Up to
0.17.0 a later push at the same version could republish the installer without
moving the tag, so the harness warns when a fetched branch carries the tag and
still builds that version past it; name that branch to test it. For 0.17.0 the
tag is the tip of its release line, `claude/issues-129-133`. From 0.18.0 every
release is cut from master and never rebuilt (`docs/releasing.md`). Both builds
run their own `src/lib/db.ts`, backup and sync code, and exports. They also use
their own migration list, read from their own `src-tauri/src/lib.rs`, and their
own migration files. Nothing about a release is retyped into the harness, so it
cannot drift from what shipped.

**Modelled: what sits underneath.** A Tauri webview cannot run in CI, so the
code runs in Node:

- `src/test/sqlx-migrator.ts` models what tauri-plugin-sql does on the
  first open of each process. It is ported line by line from the sources of
  the crates both builds lock (sqlx-core and sqlx-sqlite 0.8.6,
  tauri-plugin-sql 2.4.0). It includes the `_sqlx_migrations` ledger, SHA-384
  checksums, the refusal of unknown or modified versions, and one transaction
  per migration. `builds.ts` refuses a build that locks a different sqlx or
  plugin line, so the model cannot quietly go stale.
  It also models `db_migrate_image` (`src-tauri/src/migrate.rs`), which runs that migrator on a backup before a revert.
  The Playwright shim uses the same file; `tests/compat/sqlx-migrator.ts` binds it to node:sqlite.
- `tests/compat/tauri-sql-shim.ts` is the SQLite connection. It opens a real
  file with node:sqlite, sets `foreign_keys = ON`, and sets no journal mode, as
  sqlx does by default.
- `tests/compat/tauri-core-shim.ts` provides the Rust commands the data layer
  calls: file read and write, the `backup_*` commands (mirroring `backup.rs`),
  `db_migrate_image`, and a shared fake GitHub remote. The remote lets a workstation and a viewer
  on different builds exchange the database file through each build's real
  `publishSnapshot` / `pullSnapshotIfNewer`.

**Not covered:** the UI itself (the e2e suites cover it for this branch), the
Windows installer, and the SQLite version compiled into the shipped binary
(node:sqlite bundles its own).

## What it proves

`tests/compat/release-compat.test.ts` tells one story on one lab database.

1. **The migration ledger.** This branch must register every migration the
   release has applied, with byte-identical SQL. Otherwise the update refuses
   the lab's database. The release must also register every migration this
   branch does. Otherwise the release refuses any database this branch has
   opened, and so does every sync viewer still running it.
2. **Upgrade.** The release builds up a working lab (`tests/compat/lab.ts`
   `runTheLab`). This branch opens the database and must not lose or change a
   single value the release wrote. Every column this branch adds must be
   nullable or defaulted. This branch then reads everything and must read the
   stored values exactly as the release does. Finally it works a day on top.
3. **Rollback.** The release opens the database this branch wrote and must
   change nothing. It reads everything, works on it (including editing and
   cutting rows this branch created), and every value in this branch's new
   columns must survive. Then this branch opens it again.
4. **Backups.** Each build reverts to a backup the other took, and the next
   launch, a new process with the migrator running, must open it with
   everything there.
   Then a backup older than this branch's schema, taken by the real `OLD_BACKUP_RELEASE` (`scripts/compat-releases.mjs`), is reverted to by this branch.
   The revert must leave a migration record that lists every migration this branch registers.
   The next two launches must open the database with everything the backup held, and so must the release.
5. **Sync.** A viewer on each build pulls what a workstation on the other
   published, reads it, and relaunches.
6. **The populated legacy fixture** (`tests/fixtures/legacy-pre-0023.b64`)
   goes release, this branch, release, with every row intact.

"Reads everything" means every zero-argument `list…()`/`get…()` the build
exports is found and called, so a reader added in a future release is covered
without editing the harness. It also means every per-record reader for every
record, the Logs CSV and XLSX, and the status workbook.

## When a version changes

- **The lab installs a new release:** bump `IN_USE_RELEASE` in
  `scripts/compat-releases.mjs`. Until you do, the run keeps checking the
  pinned release only. To check a release the lab has not installed yet, name
  it: `pnpm test:compat app-v0.18.0`.
- **You add a column:** make `runTheLab()` write a non-default value into it.
  The harness fails if a new column only ever holds its default, because
  survival of a value nobody writes proves nothing.
- **You add a numbered migration:** the ledger check fails against every release that lacks it.
  That failure is the real thing: once this build opens the database, the older build refuses it, and so does every sync viewer still running it.
  A viewer on this build that pulls a snapshot from a workstation still on the older build swaps it in without the migration, so its next launch runs the migration again on top of the column `getDb()` converged ("duplicate column name"), and it cannot open its database.
  A backup revert is not exposed to this, because it runs the migrations on the backup before swapping it in.
  Converge the column at runtime only (see AGENTS.md, precedent `samples.embedding_notes`).
  The alternative is to get the captain's sign-off and record the version in `ACCEPTED_ONE_WAY` in the test, which then asserts the refusal instead of failing on it.
- **An older release lacks a function the lab uses:** that step is skipped and
  listed at the end of the run. This branch lacking one fails, because it
  means `lab.ts` is out of date.

## Reading a failure

Each check is named for the claim it makes. The error names the build, the
machine, and the step, or lists the exact rows and values that were lost or
changed, for example `samples row 12 cut_notes: "x" -> "X"`. A failure against
the release in use is a finding about this change, not a flaky test. Stop and
report it rather than working around it.
