# The 0.18.0 reconciliation: why master jumps from 0.13.2 to 0.18.0

Written 2026-09-11, when the change it describes was made.
If you are reading `git log` and wondering why a month-old branch was merged into master in one go, or why the version skips four minor numbers, this is why.

## What had happened

For a month, master and the build the lab ran were two different codebases.

- Master and the releases last agreed at **44a05c9**, 0.13.2, on 2026-08-13.
- From there, every release was published from a long-running branch that was never merged back: `claude/issues-121-128` (app-v0.14.3) and then `claude/issues-129-133` (app-v0.15.0 to app-v0.17.0).
  The installer workflow of the time published a release on every push to any `claude/**` branch, and nothing compared those branches with master.
- That line gained **21 commits**, four minor versions and fourteen closed issues (#121 to #135).
- Master gained **one**: PR 138 (62e7828), embedding notes (#137), assigned stains in the Logs and exports (#136), and the `pnpm test:compat` harness.
- Master still said **0.13.2** while the lab ran **0.17.0**.

The consequences were concrete.
PR 138 was merged to master and was not in the build on the bench.
PR 138's branch numbered itself 0.14.0, the next number after master's 0.13.2, which is why the tutorial screenshots it regenerated said "Histometer v0.14.0" while the lab ran 0.17.0.
Every piece of work branched from master inherited the same gap.

## What was decided

On 2026-09-11 the lab's owner chose to merge the release line back into master, over abandoning master and over investigating further first:

- master becomes the union of both lineages, not one replacing the other;
- the version becomes **0.18.0**, the next release after the 0.17.0 in use;
- releases are cut from master from then on;
- the 21 commits are reviewed rather than assumed good, because none of them had ever been reviewed.

## Why a merge and not a rebase

The release tags app-v0.14.3 to app-v0.17.0 are real releases that were installed.
Rebasing the release line onto master would have created new commits and left every one of those tags pointing at commits outside master's history, which is the very condition this change sets out to end.
A merge keeps every released commit exactly where it was, with its tag, and makes it an ancestor of master.
The merge commit's first parent is master (62e7828) and its second is app-v0.17.0 (e5b709c).

So master's first-parent history reads 44a05c9, 62e7828, the merge, and everything after.
The releases between 0.13.2 and 0.17.0 are on the merge's second parent: `git log --oneline 44a05c9..e5b709c`.

That only holds if the pull request carrying it is landed with GitHub's **Create a merge commit**.
Squash or rebase merging would flatten the second parent away and leave every release tag from app-v0.14.3 to app-v0.17.0 outside master's history once more.
The release-integrity check fails on master if that happens; the repair is to merge e5b709c into master again.

## What the version jump means

- **0.13.2 to 0.17.0** exist only on the second parent of the merge. They were released from branches, and each is tagged `app-v<version>` there. app-v0.15.3 was published and withdrawn on 2026-08-27; the changelog explains it.
- **0.18.0** is the first release of the union and the first release cut from master. It is 0.17.0 plus PR 138: assigned stains in the Logs and exports (#136), embedding notes (#137), the release-compatibility harness, and the working Excel exports.
- Nothing numbered 0.14.0 was ever built from master. The "v0.14.0" in PR 138's screenshots named a version its branch briefly declared (0a48a25, dropped again in af41902).

## How the two lines were joined

Four files conflicted, and none of them was a migration, the Rust shell, or the backup and sync code, which are byte-identical in both lines.

| File | Master | Release line | Union |
|---|---|---|---|
| `scripts/workflow-test.mjs` | the #136 and #137 gates | 1,000 lines of new gates, stored with CRLF line endings since 0cc2b63 | a three-way merge of the LF-normalised files, with no conflicts; LF again, like every other file |
| `src/lib/db.ts` | added `embedding_notes` to `RESTORE_COLUMNS` | deleted `RESTORE_COLUMNS` with the unused per-row undo code (f058090) | deleted; nothing reads it, and undo restores whole database images |
| `src/hooks/useActions.ts` | kept `createSample` | deleted `createSample` as superseded by `createSamples` | deleted; nothing calls it |
| `src/components/LogsView.tsx` | imports for the #136 stain helpers | imports for bulk remove and reassign (#133) | both |

Some auto-merged files needed more than textual merging so that both lines' tests pass on the union:

- **`src/components/NewSampleDialog.test.tsx`** rendered the dialog with the pre-#132 `project` prop; it now passes `projects` and `initialProjectId`, and gains a test that the project picker (#132) and per-sample embedding notes (#137) file a batch together.
- **The #136 harness gate** "a block with slides still names a second stain" built its block by only *queueing* a cut. Under #125 a stain requested while the cut is still queued joins that cut as a planned slide, so the gate now really cuts first, which is what it says it tests, and a companion gate pins the #125 path.
- **Inline `addSample` payloads** in seven release-line specs predate `embedding_notes` and now carry it, as `AGENTS.md` requires.

Hygiene that the merge made visible, fixed in the same change:

- a `.gitattributes`, so a checkout that converts line endings cannot flip a file to CRLF again;
- `tests/stress3/32-hostile.spec.ts` spelled its NUL and control characters as raw bytes, so git showed it as binary and no reviewer could read it; they are escape sequences now;
- a duplicate `openStainRack` key in the harness API;
- `docs/issue_remediation_plan.md` said undo restored embedding notes through `RESTORE_COLUMNS`, which the union no longer has; undo restores whole database images, notes included.

### The changelog, as merged

`CHANGELOG.md` currently attributes PR 138's #136 and #137 features and the Excel export fix to 0.13.2, inside the "0.13.2 - 2026-08-13" section, although they first ship in 0.18.0.
Its 0.17.0 heading still reads "0.17.0 - unreleased", although 0.17.0 was published on 2026-09-04.
Both are wrong.
The lab owner's standing order that agents never hand-edit `CHANGELOG.md` prevented the agent doing this merge from correcting them.
`scripts/release-check.mjs plan` now refuses to cut 0.18.0 until `CHANGELOG.md` has a 0.18.0 section, but it does not check which section an entry sits in.
That section now exists and holds PR 138's schema note and its `pnpm test:compat` entry; the rest has to be moved by hand before 0.18.0 is cut.

## How releases work now

`docs/releasing.md` is the procedure.
In short: the installer workflow runs only when started by hand on master; it refuses anything that procedure lists, including any release tag master does not contain; it runs the whole test workflow on the commit first; and it tags the release at that commit.
A separate release-integrity check turns every pull request red while any release tag is missing from master or master's version is behind the newest release.
Either condition would have flagged this divergence the day 0.14.3 was published.

The review of this merge also dropped the test workflow's Rust job, which compiled the Rust shell on Windows.
0.18.0 deliberately supersedes that part of the decision and brings the job back, on Linux, running `cargo check` and the Rust unit tests.
The Rust shell now holds `db_migrate_image`, which brings a backup or a pulled snapshot up to the build's migrations on the lab's machine, and only the Rust tests exercise the real command rather than its TypeScript model.
Linux is cheap and catches the breakage that matters; the installer build still compiles for Windows at release time.

## The review

The 21 commits were reviewed before the merge, and the review found defects in code the lab had been running, none of them in migrations, backups or sync code.
The ones to fix first, all present in 0.17.0:

- **Undo, redo and revert-to-backup bypass the sign-in gate that 0.14.0 (#128) added.** A signed-out session can rewind the record, and the restore leaves `active_user_id` at the previous user. Reproduced in the app.
- **A signed-out workstation stops ingesting viewer requests and stops publishing** while a request is waiting (also #128).
- **Emptying a processing run that is already running deletes it** with its protocol checklist, and nothing records who removed it (#135, 0.16.3).
- Partial bulk slide moves are written but neither refreshed nor undoable; rack capacity can be exceeded by multi-slide cut groups; a rack can be split from any stack, including a stained one.

Two tests fail on the release line itself, and fail the same way on the union: the #115 case in `tests/e2e/issues-113-120.spec.ts`, intermittently, and the stress3 explorer, which stops at its baseline because its view check predates the project filtering of #131 (0.15.0).
No gate here had ever run them, since the fleet only ran master, and stress3 is not in CI.

The full review, with file and line references and a recommended order of follow-ups, was delivered with the reconciliation to the lab's owner.
None of these was fixed in the merge itself, so that the merge changes nothing about behaviour the lab already had except what PR 138 adds.
