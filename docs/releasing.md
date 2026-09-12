# Releasing Histometer

A release is a Windows installer published on the repository's Releases page as `app-v<version>`.
The lab installs from that page, so a release is what reaches the bench.

**Releases are cut from master, by hand, and from nowhere else.**
From 0.14.3 to 0.17.0 they were published from `claude/**` branches that were never merged back, and for a month master and the installed build were two different codebases.
`docs/release_line_reconciliation.md` records how that happened and how it was undone.
Everything below exists so that it cannot happen again without the repository saying so.

## Cutting a release

1. **Bump the version on a pull request to master.**
   The version is written in five places, and all five change together:
   `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, the `histometer` entry in `src-tauri/Cargo.lock`, and both `version` fields in `package-lock.json`.
   `node scripts/release-check.mjs versions` checks them, and so does CI.
   The new version must be newer than every release already published.
   The new version also needs a `## <version>` section in `CHANGELOG.md` saying what the release ships.
   `plan` refuses a release without one.
2. **Merge it.**
   Merging publishes nothing.
   Master may carry an unreleased version for as long as it needs to while further fixes land.
3. **Start the release.**
   On GitHub, open Actions, pick **Cut a release**, and click **Run workflow** on `master`.
   From a terminal: `gh workflow run cut-release.yml --ref master`.
   The workflow is `.github/workflows/cut-release.yml`, and it has no trigger a push can reach.
   The entry named **Build Windows Installer** is the pre-0.18.0 workflow, kept only because unmerged branches still carry its file; it is disabled and must stay that way (see below).
4. **Watch it.**
   The run has four jobs, and each one can stop the release:
   - `plan` runs `node scripts/release-check.mjs plan`. It refuses a run on any ref but master, version files that disagree, a version that is already released or is not newer than the newest release, a `CHANGELOG.md` with no `## <version>` section, and any release tag that master does not contain.
   - `tests` runs the whole of `.github/workflows/test.yml` on the same commit: the harness, the legacy upgrade, the unit and browser tests, the Rust shell's `cargo check` and unit tests (on Linux), and `pnpm test:compat` against the release in use.
   - `build` compiles the app on Windows and publishes the release, tagged at the commit `plan` and `tests` passed.
   - `verify` checks that the new tag names that commit.
5. **After the lab installs it,** bump `IN_USE_RELEASE` in `scripts/compat-releases.mjs` so every later pull request is checked against what the bench actually runs.

A release is never rebuilt or overwritten.
If one turns out to be wrong, fix it on master, bump the version and cut the next one.
If a run fails after the release was created (an upload error, say), use **Re-run failed jobs** on that run: the `plan` and `tests` it already passed are reused.
A fresh run for a version that already has a release is refused on purpose.

## The release-integrity check

`.github/workflows/release-integrity.yml` runs on every pull request, every push to master, whenever a release is published, and once a day.
It fails when:

- **a release tag is not in master's history.** Somebody published a release from a commit master does not have, so the lab may be running code the trunk lacks. Merge that commit into master (never rebase or move a released commit), or withdraw the release if it should never have existed.
- **master declares a version behind the newest release.** The trunk is behind what ships, which is how a branch off master came to number itself 0.14.0 while 0.17.0 was installed. Bring the release into master and move the version forward.
- **the five version sources disagree.** Bump all of them.

While any of these holds, every pull request is red.
That is deliberate: a release the trunk does not account for is the one thing worth stopping for.
The pull request that merges the stray release back is judged by its own merge commit, so it goes green on its own.

## Why the release workflow was renamed, and what a tag ruleset cannot do

GitHub runs a push-triggered workflow from the copy of the workflow file that lives in the pushed commit.
So the master-only guard binds only commits that descend from it, and the pre-0.18.0 copy - push to `claude/**`, `v*` tags, `workflow_dispatch`, `contents: write`, no `plan` and no test gate - keeps working wherever it still sits.
That copy does not need a tag to do damage.
`app-v0.16.1` was tagged at 7363ed7 and published at 01:37:50Z on 2026-08-28, by a push to `claude/issues-129-133`.
The next push to that branch, 3ee5d75, still said 0.16.1, so its run uploaded into the release that already existed: the `.exe` and `.msi` on that release page carry timestamps of 01:49:10Z to 01:49:12Z and were built from 3ee5d75, which the tag does not name.
The tag never moved, so `Release integrity` saw nothing, and every check stayed green while the shipped installers were replaced by a build from a branch nobody had reviewed.

Two things follow.

- **The live workflow is `.github/workflows/cut-release.yml`.**
  The rename separates it from the path those stale copies address, which is now a workflow master does not have and is **disabled** in Actions (Actions, the workflow, "Disable workflow").
  Leave it disabled; re-enabling it re-arms every branch that still carries the old file.
  The lasting fix is to delete or rebase those branches, after checking that master or an `app-v*` tag already contains each tip.
- **A tag ruleset is not the fix.**
  A ruleset on `app-v*` permitting only GitHub Actions to create tags would not have stopped any of this: the old workflow *is* GitHub Actions, and replacing a release's assets needs no tag at all - `tauri-action` uploads into the existing release for that version.
  A ruleset that forbids deleting or moving `app-v*` tags is still worth having, but as a guard against a hand-made tag, not as a substitute for the rename and the disable.

## Repository settings worth adding

The workflows make a stray release loud; GitHub settings can make one impossible.
These are settings on the repository, not files in it, so they are recorded here rather than applied:

- a tag ruleset on `app-v*` that lets nobody delete or move a tag, and only GitHub Actions create one (a guard against a hand-made tag, and no more than that - see the section above);
- branch protection on `master` that requires the `Workflow tests` and `Release integrity` checks.

## Compatibility with the release in use

Every pull request states whether it is compatible with the build the lab runs, and proves it with `pnpm test:compat` (see `docs/release_compat.md`).
A schema change is a wire-format change for sync (`docs/shared_data_sync.md` section 1), so it ships to every workstation and viewer in the same release.
