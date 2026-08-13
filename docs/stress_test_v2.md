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
