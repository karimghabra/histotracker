# Stress harness v3 — the explorer

*Run against 0.13.2. Findings triaged, fixed and gated in 0.13.3.*

```bash
pnpm exec playwright test --config playwright.stress3.config.ts
```

## Why there is a v3

v2 did what it was built for. It fixed v1's method — sentinels so "unchanged"
means something, falsification so a finding is checked twice, a seeded walk so a
failure is a command line — and it proved the store stays coherent under
thousands of moves.

It also had a hole I put there on purpose and then had to admit. **v2 does not
click.** Across five spec files it performs seven UI interactions, and all seven
are signing in. Everything after that goes through `page.evaluate` into `db.ts`.

That is a real trade: it buys depth, and it costs the single class of bug this
project has reported most often. #117, #118 and #119 were each a perfectly
coherent database rendered wrongly. Nothing in v2 could have found any of them.

So v3 keeps v2's method and adds three things.

1. **The screen is checked against the store.** Every few rounds each surface is
   opened and compared with a count recomputed from the database — and on the
   board, three ways: the store, the column's own count badge, and the cards
   actually drawn. The two possible disagreements mean different things.
   Badge≠cards is React drawing something other than what it counted. Badge≠store
   is the view and the database disagreeing about the world.
2. **A wider move vocabulary.** v2's twelve moves all lived inside the slide
   lifecycle — which is the part of the app the tests were already thinking
   about, and therefore the part with the fewest bugs left. v3 adds eight that cut
   *across* it: archiving a block mid-cut, renaming a project while its codes are
   in use, retiring an agent that open racks depend on, reverting a block's stage
   while its slides are downstream, exhausting a live block, editing descriptions
   with hostile text. Bugs live where one module's change invalidates another
   module's assumption, and no per-module test looks there.
3. **Undo and redo, through the real button.** Undo swaps the entire SQLite image
   (`src/lib/undo.ts`), so the honest test is a whole-image comparison:
   fingerprint the database, make a move, press Undo, fingerprint again, insist on
   byte-identical workflow state.

## What it does

| Spec | What it drives |
|---|---|
| `30-explorer.spec.ts` | 10 walkers × 26 rounds over 130 blocks, 20 move types, invariants after every round, view checkpoints throughout |
| `31-undo-redo.spec.ts` | 24 single-move undo/redo round-trips; a 31-deep storm back and forward; branch discard; undo of a removal |
| `32-hostile.spec.ts` | hostile text, ghost ids, stale rows, nonsense quantities, illegal stage keys, concurrent calls, a reload mid-work |

The last run: **252 moves, every one of the 20 types exercised at least five
times, and no move refused 100% of the time** — that last number is printed
deliberately, because a move that is always refused is coverage the run did not
actually have.

### The fingerprint

`driver3.ts` serialises every table in rowid order and diffs table-by-table, so
"undo didn't restore" becomes "`slides`: 104 rows before, 103 after". Four
tables are excluded and each exclusion is deliberate: `users`, `app_settings`,
`audit_events` and `schema_meta`. `restoreDbPreservingSession` re-adds the
session on purpose, and `undo()` writes its audit row *after* the restore lands.
Rolling those back would be the bug.

### What the harness reproduces, and what it doesn't

`recordUndoPoint()` is the recording half of `useActions.commit()` — `snapshotDb()`
plus `useUndoStore.record()` — reproduced because the explorer drives the data
layer and nothing else would fill the stack. The interesting half is not
reproduced: popping, the whole-image restore, session preservation, invalidation
and the re-render all run the app's own code, reached by clicking the toolbar
button.

## Findings

### 1 · A cut could be retracted after the glass had been stained — FIXED

Found by the explorer in round 1 and every round after: a slide carrying
`stage_stained_at` with `stage_cut_at` NULL. Stained on a day it had not yet been
cut.

`revertSectionToStage(id, 'needs_sectioning')` clears `stage_cut_at` on every
slide in the group — correct on its own, and added for #95 so a group dragged out
and back doesn't keep a cut date for a cut that was retracted. It just never
asked whether anything had happened to that glass since.

This is not an exotic path. It is **dragging a card backwards on the board**, and
`onMoveSections` is wired to it.

The fix refuses the revert once any live slide in the group has been stained,
coverslipped or imaged, and names the slides. The alternative — cascading the
revert and clearing the staining dates too — was rejected outright: it destroys
the record of work that genuinely happened, which is the one thing this
application exists not to do. Once a section is on a slide and stained, the cut is
a fact. Fix the slide (reassign it, or remove it with a reason), not the history.

Gated twice, and both gates revert-verified: one that the refusal happens, one
that an **untouched** group can still be dragged straight back, so the guard
cannot quietly grow into a wall.

### 2 · A removed slide could still be given a depth tag — FIXED

Found by the hostile spec, which acts on a slide it has already removed. Four of
the five slide mutations refused it — `setSlidePicturesTaken`, `reassignSlide`,
`relabelSlideToSample`, `removeSlide`. `setSlidesDepthTag` retagged it happily.

A removed slide is the record of glass that is gone; its depth can no longer be
established by anyone. Fixed by excluding removed slides in the statement rather
than throwing, because this is the only one of the five that acts on a
**selection**: a technician tagging eleven slides, one of which broke last week,
should get the ten tagged, not an error and nothing done.

### 3 · Mutations report success against rows that do not exist — OPEN, observation

Ten of sixteen calls made against id 999999 returned success. None of them changed
anything — the whole-image comparison confirms that — because they are `UPDATE …
WHERE id = ?` and simply match nothing.

Left alone. Making ten functions throw on a missing row would change the
behaviour of every bulk caller that passes a list, to defend against a caller that
does not exist. Recorded because a caller that trusts a return value would be
building on a lie, and if one ever appears this is where it is written down.

### 4 · Concurrency — still the known open structural class

The concurrent spec re-reaches the class documented in `docs/stress_test_v2.md`:
`db.ts` has no transaction boundary, so every read-then-write across an `await`
is a window. v3's contribution is a bound rather than a fix — after firing five
mutations at once at six blocks and eight racks, the schema holds, slide codes
stay unique, and the screen still agrees with the store. The fix remains a
mutation lock, and remains deferred: it needs an audit of which exports call which
before it can be added without deadlocking.

## Two harness bugs worth writing down

Both produced confident, dramatic, completely false findings. They are recorded
because the next harness will have the same shape of hole.

**A reused dev server made redo look catastrophic.** The first undo run reported
that redo emptied the entire database — every table, zero rows, run after run. The
app was flawless. `reuseExistingServer: true` had kept a Vite server that had
hot-reloaded since it started, so Vite was serving both `db.ts` and `db.ts?t=…`.
The SQL shim holds its sql.js connection in module scope, so two module instances
meant **two databases over one virtual file**: the walk wrote through one, the
app's Undo through the other, and Undo's snapshot clobbered the file with a
schema-only image.

It bit twice more before the day was out — the v1 suite failed its stack-merge
spec on the batch run and passed on a clean server with nothing changed. All
three stress configs now start their own server. `playwright.config.ts` and the
showcase config still reuse one deliberately: they are the interactive suites,
and `--ui` against a hand-started `pnpm dev:browser` is worth keeping. The rule
is the same one either way — **if source changed since the server started, restart
it before believing anything.**

**The view checks needed a real refresh.** The explorer calls `db.ts` directly,
which is what buys its depth — and means nothing ever calls `useActions`'
`invalidate()`, so React Query happily served the cache it filled before the walk
began. Every column read zero and the first run reported six defects that were
entirely the harness's own doing. `checkViewsAgainstData` now remounts first,
which is exactly what the app does on launch. The consequence is stated in the
code: this harness cannot catch a view that goes stale because a mutation forgot
to invalidate. That bug is unreachable from here by construction, and belongs to
`tests/e2e`, which drives the buttons.

There is a third, smaller one. The board check first demanded that the Logs be
scoped to active projects, and reported a defect the moment a walker deactivated
one. That was the check being wrong: the Logs are the permanent record, and
deactivating a project is about board clutter. The check now counts every
candidate predicate in one statement and says which one the screen matches, so a
disagreement points at a rule rather than at a number.

## What v3 still cannot see

Stated plainly, because a harness that does not say this reads as more thorough
than it is.

- **Stale-after-mutation rendering**, as above — by construction.
- **The rack columns' populations.** Only Embedded Inventory is compared against
  the database. `listOpenSlideStacks()` is forty lines with five archival
  sub-clauses about racks holding other people's slides; re-typing it in the test
  would fork it, not test it. Those columns are covered by badge-versus-cards,
  which needs no predicate because the badge comes from the very query the cards
  come from.
- **Anything drag-and-drop.** The moves call the data layer; `tests/e2e` and
  stress v1 drive the board itself.
- **#77, manifest attribution.** Still no automated coverage of any kind, flagged
  since 0.7.0, and now the oldest untested thing in the app.
