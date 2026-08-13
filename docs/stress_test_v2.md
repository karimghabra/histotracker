# Stress harness v2 — built from what v1 got wrong

`tests/stress2/`, run with:

```bash
pnpm exec playwright test --config playwright.stress2.config.ts
```

v1 found four real defects, so it earned its place. But writing it taught more
than it found, and two of those lessons were uncomfortable enough to justify a
second harness that works differently rather than a bigger version of the first.

## What v1 got wrong

**It reported a false negative, and I nearly shipped it.** v1 checked whether a
rack tick preserved a slide's stain date by comparing the value before and after.
It read *"kept — good"*. It had in fact been **overwritten** — both values simply
landed in the same minute, because `nowTimestamp()` stores
`YYYY-MM-DD HH:MM`. Every same-run timestamp comparison in that harness was
structurally blind, and I only caught it by re-running with a planted date.

**It produced four false positives**, each costing real time: running a whole
protocol before looking for mid-protocol controls, `<details open>` returning the
empty string (falsy, so the popover toggled shut on alternate calls), an
empty-state row counted as a data row, and an export that goes through a Tauri
dialog the browser shim cannot open. Every one was a single-source claim.

**Its fifteen invariants never fired once** across twenty-one tests. I could not
tell "the app is correct on these axes" from "the probes are blind" — and all
four real defects walked straight past them, because each was a *stamp asserting
work that never happened*, which no referential check can see.

**It made static claims that rotted.** Three findings asserted "there is no
affordance for X" from a code reading. After X was implemented, the strings still
said there wasn't.

**It tested one clean path at a time.** Intake, then cutting, then staining — how
a lab is described, not how one runs.

## What v2 does instead

| v1 | v2 |
|---|---|
| compared timestamps taken minutes apart | plants **2019 sentinels** — a value `nowTimestamp()` cannot produce, so "unchanged" actually means something |
| single-source claims | **falsify before reporting**: every finding is re-derived a second way, and a claim that fails its second check is recorded as *not reported* rather than dropped silently |
| invariants that had never failed | a **self-check** that plants a violation of each invariant and insists the catalogue notices |
| hand-written happy paths | a **seeded random walk** over legal actions, invariants checked after *every* step, seed printed so any failure is a command line |
| asserted absent capabilities from code | **attempts** the capability and reports what happened |
| all UI, so shallow | drives `db.ts` directly for depth, leaving the UI paths to v1 and `tests/e2e` |

**19 invariants**, derived from the defects that were real rather than from
imagination: stamps that assert work nobody recorded, stage timestamps running
backwards, codes that disagree with the block they are filed under, letters below
their high-water mark, the request that a correction must not erase.

## What it found

Five defects, none of which v1 could have reached. All are fixed.

### 1 — a stain request pulled an extra out of a cut group that was still queued

**How it surfaced:** the fuzzer tripped `stained-implies-cut` at step 87 on
`AA-0002-B` — a slide with a stain date and no cut date.

`requestStainForSample` looked for a free extra with
`purpose = 'extra' AND current_stage = 'extra'` and **no filter on the group's
stage**. `listExtraSlides` — the inventory the user actually sees — has carried
that filter since #12: a slide saved as an extra is a *plan* until its group
leaves the queue. So the two disagreed about which extras exist. The inventory
correctly hid them; this happily pulled one into a staining rack.

Reachable from the UI: save a cutting plan without sending it, then add a stain
from the Logs. The block answers *"pulled from an extra"* and puts glass nobody
has cut into Staining, where one rack tick records it as stained.

*Fixed:* the same predicate, at the one place that takes an extra.

### 2 — a planned, uncut slide could be assigned to an agent

`reassignSlide` moved any slide into a live rack. A slide in a queued group has
no cut stamp — it is a line in a plan, not glass — and it could be put on a
stainer.

*Fixed:* refused, pointing at the cutting plan, which is editable (#116).

### 3 — removing a slide left its rack open and empty

`removeSlide` detached the slide but did not retire the rack. The shipped UI was
fine, because `useActions.removeSlides` compensated — but the compensation lived
at the *call site*, which is the exact fragility this file warns about in
`nextSlideLetter`: *"requiring each removal path to compensate is exactly the
per-call-site fragility that let #73 ship broken."* The fuzzer called the
function directly, as the next caller would.

*Fixed:* the rack is retired inside `removeSlide`. Idempotent, so the caller
doing it too is harmless.

### 4 — a double click surfaced a raw SQLite error

Allocating a slide letter is a read-then-write across `await` boundaries.
JavaScript is single-threaded, but these interleave, so two overlapping calls
both read the same high-water mark and try the same code. The `UNIQUE` index
caught it — the data was never at risk, which is defence in depth working — but
the loser of the race saw `UNIQUE constraint failed: slides.slide_code`.

Checking for a clash before inserting does **not** fix this: both callers pass
the check before either inserts. The only reliable arbiter is the index itself.

*Fixed:* the insert is attempted and a collision retried with a freshly read
letter. Two overlapping clicks now produce two slides with two letters.

### 5 — images could be recorded for a slide that was removed

`setSlidePicturesTaken` checked only that the slide was an assay slide. A stale
panel — one left open when the slide was removed — could stamp images on broken
or lost glass, producing an imaging stamp with no imaging stage behind it.

*Fixed:* refused. And while there: removing an already-removed slide wrote a
**second** removal event for one piece of glass, so that is now a no-op.

### Also worth knowing

- **Two harness gates were relying on defect 1.** Their fixtures requested a
  stain straight off a queued group; one even said so in a comment. They now cut
  first, which is what a bench does anyway.
- **Hostile text is handled.** Quotes, semicolons, `<script>`, newlines, 5 000
  characters, emoji, `%`/`_` wildcards — all stored and read back intact;
  empty and whitespace-only descriptions are refused (#88).
- **Stale references are refused** with human sentences, not stack traces.
- **`updateSectionStage` accepts a backwards move.** Reverting a group is a real
  feature, and it broke no invariant, so it is recorded rather than "fixed".

## Coverage

- **14 seeds × 300–400 steps ≈ 5 000 randomized actions**, 19 invariants checked
  after each. Clean after the fixes.
- 4 new harness gates (89 total), one per defect, so none can come back quietly.
- v1's 21 tests still pass, as do 101 e2e, 74 unit, and the legacy upgrade.

## Still not covered

Honest list, unchanged from v1 except where noted:

- **Sync / viewer mode** — `tests/e2e/sync.spec.ts` covers it; neither stress
  harness runs two contexts.
- **Drag and drop** — too positional to run thousands of times; the functional
  suite covers it.
- **Export file contents** — the Tauri save dialog cannot open under the shim.
- **#77 (Manifest attribution)** — still no automated coverage of any kind,
  flagged since 0.7.0. Now the oldest untested thing in the app.
- **The fuzzer does not drive the UI.** It reaches states the UI would take
  minutes to build, and every invariant is checked against the same image the UI
  renders — but a bug that lives only in a component is out of its reach by
  construction.

---

# The swarm — many walkers, one large board

A second phase of v2 (`14-swarm.spec.ts`), built to reach two things a single
walker on a small board cannot.

**Scale.** Some rules only bind when there is enough on the board for them to
bind on: racks shared by many blocks, agents with several open racks, letters
allocated past Z. Eight blocks never get there, so the board is seeded to ~150
blocks and ~400 slides in one round trip (every real `db.ts` call, just not
paying a process crossing per step).

**Overlap.** `db.ts` is full of read-then-write sequences across `await`
boundaries. One walker awaiting each action can never interleave with itself;
eight firing together do. JavaScript being single-threaded does not save you —
it just means the interleaving happens at `await` rather than mid-statement.

Two phases, deliberately separate:

| phase | walkers | attribution | finds |
|---|---|---|---|
| **interleaved** | strict turns | exact: round, walker, action | states that are legal at every step and impossible as a whole |
| **concurrent** | fire together | a *set* of in-flight actions | races |

Each walker carries a `bias` that tilts it toward one part of the workflow, so
the swarm is not eight identical processes: one cuts, one stains, one images, one
corrects. The self-check runs at scale too — a probe can pass on eight blocks and
quietly stop meaning anything on six hundred.

## What the swarm found

**Interleaved (all fixed):**

1. **Coverslipped before stained.** `CC-0021-C`: cut 02:32, coverslipped 02:33,
   stained 02:34. The protocol checklist drew every step as its own button with
   no ordering guard at all — ticking them out of order was one click. Now
   enforced at the checklist *and* in both stamp writers, since those are
   exported and called directly by two components.
2. **Imaged, then stained.** `BB-0022-A`: imaged 02:40, stained 02:41. A slide
   that had been imaged was reassigned to a new agent, restarting staining on
   glass whose record says it is finished. One slide carries one set of dates, so
   the second pass cannot be told from a corrupt first one. Refused, pointing at
   cutting another section — which is what the "one more off this ribbon" control
   is for.
3. **An empty rack left on the board** by a group sent back for cutting. Third
   instance of one pattern: moving a slide out of a rack and retiring the rack it
   emptied are one operation, and three places were doing only the first half.

**Concurrent (four fixed, one open):**

4. **The slide-letter race, in two more allocators.** 0.13.1 fixed it in
   `addSlideToSection`; `createSectionRequests` and `relabelSlideToSample` have
   the same read-then-write and produced the same `UNIQUE constraint failed`.
   Both now retry against the index — which is the only real arbiter, because any
   check before the insert is itself racy.
5. **A rack retired with live glass inside it**, and the mirror image, **a rack
   left open and empty** when two calls each removed a different slide. Retiring
   now refuses to strand live glass; the empty sweep runs over every rack in one
   statement rather than asking about one rack at one moment.

### Known open, and why it is recorded rather than patched

Under genuinely simultaneous operations, **rack membership can still land
wrong**. There is no transaction boundary in the data layer, so every "choose a
rack, then write to it" pair is a window. I closed five instances this round and
a sixth appeared immediately — that is the point at which patching pairs stops
being the answer.

The real fix is a **mutation lock**: one promise chain that every write goes
through. It is not a patch, and it has a genuine hazard — a naive lock deadlocks
the moment one locked function calls another, and JavaScript gives you no way to
tell "nested call" from "new call arriving during an await" without threading
context through. Doing it properly means auditing which exports call which and
locking only true entry points. That is a design change and deserves its own
cycle rather than the end of this one.

**In practice the app cannot currently produce this.** The UI fires concurrent
calls only via `Promise.all` across selected stacks; a single user on a single
workstation cannot issue eight simultaneous mutations, and sync swaps the whole
database image rather than applying concurrent writes. So this is a latent risk —
real, reachable if the app ever gains true concurrency, and recorded here rather
than hidden behind a green tick. The concurrent test still runs and still fails
the build on **any other** invariant; only these two rack-membership ones are
allowed through, with the reason attached.

## Coverage

- Interleaved: 8 walkers × 90 rounds ≈ 720 actions on a 150-block board, all 19
  invariants after every one. Clean.
- Concurrent: 8 walkers × 60 rounds ≈ 450 actions fired in batches of eight.
  Clean except the known class above.
- The self-check passes at scale: all seven plantable violations still caught on
  a 600-slide board.
- 3 new harness gates (92 total), v1's 21 stress tests, 101 e2e, 74 unit, and the
  legacy upgrade all still pass.
