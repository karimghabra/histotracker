# Deep stress test — 0.12.0

A dedicated stress suite (`tests/stress/`, run with
`pnpm exec playwright test --config playwright.stress.config.ts`) that fills the
board up and drives every workflow through the real UI in Chromium, then reads
the **database** to check what actually happened.

**16 tests, 4.6 minutes, all passing, zero console errors and zero uncaught
exceptions across the whole run.** Nothing here is a crash. What it found is a
small number of places where the record the app keeps does not match the work
that was done — which matters more in a posterity application than a crash does,
because a crash announces itself.

## How this differs from `tests/e2e`

Two capabilities the functional suite does not have:

1. **Console watch.** Every stress test fails if the page logs an error or
   throws. A workflow app can render perfectly while throwing on every update.
2. **Direct SQL.** `window.__SHIM_SELECT__` (test-only, added to the sql.js shim
   that is aliased in only by `vite.config.playwright.ts`) lets a test query the
   very SQLite image the app is using. Most of what goes wrong in a lab tracker
   is invisible on screen: an orphaned slide, a rack left open with nothing in
   it, a code issued twice, a stamp for work that never happened.

**15 integrity probes** run at every junction of every test — orphaned slides,
duplicate codes, empty open racks, live slides in retired racks, stain slides
with no agent, extras that kept one, samples in two open batches, analyzed
slides that were never imaged, stained slides that were never cut, and so on.
**Every probe held, in every test, at every junction.** The defects below are
things the probes were not looking for.

---

## Confirmed defects

### D1 — "Complete Imaging" back-fills an images-captured stamp onto slides that were never imaged

**Severity: high** (the record asserts work that did not happen)

*Reproduction — `04-merge-deep.spec.ts`, "can a newcomer be swept through
imaging it never had?"*

1. Cut one block for two agents, e.g. H&E and CD31.
2. Take the H&E rack through its protocol. It scatters into the block's
   per-sample imaging stack.
3. In Ready for Imaging, tick "images captured" for the H&E slide. **Do not**
   press Complete Imaging.
4. Now take the CD31 rack through its protocol. Its slide scatters into the
   **same** per-sample stack (see D2) — unimaged.
5. Press **Complete Imaging**.

**Observed:** the CD31 slide, whose "images captured" box was never ticked, is
stamped `stage_pictures_taken_at`. Evidence from the run:

```
per-slide BEFORE: SW-0001-A images=yes, SW-0001-B images=NO
per-slide AFTER:  SW-0001-A images=yes, SW-0001-B images=yes
```

**Expected:** either Complete Imaging is refused while a member is unimaged, or
it completes only the slides that were actually ticked.

**Why it matters:** the per-slide checkbox exists precisely to record *which*
glass was photographed. If a rack-level button back-fills it, the checkbox is
advisory and the log cannot be trusted on the one question it is there to
answer. In the merge case above the operator has no way to know: they imaged
what was in front of them, and the newcomer arrived afterwards.

**Note:** the same click does *not* mark the newcomer analyzed — the analyzed
stamp is correctly withheld. So the guard exists one step later but not here.

---

### D2 — a per-sample imaging stack keeps accepting new slides after its imaging session

**Severity: medium-high** (root cause of D1)

*Reproduction — `03-stack-merge.spec.ts`, "per-sample stacks converge at
imaging, including a half-imaged one"* — steps 1–4 of D1.

**Observed:** the half-imaged stack went from `1/1 imaged` to `1/2 imaged`. The
newcomer merged into a stack whose imaging session was already over.

**Root cause:** the two merges in this app are governed by different rules.

| merge | function | guard |
|---|---|---|
| loading rack (slides pool by agent) | `getOpenStainRack` | **refuses any rack whose stack row OR any member slide has been worked** — this is the #81 fix, and it is thorough |
| per-sample stack (rack scatters at imaging) | `getOpenSampleStack` | matches on `(sample_id, current_stage, closed_at IS NULL)` **only** |

`getOpenSampleStack` has no equivalent of the "untouched" guard. A stack that is
part-way through imaging is indistinguishable from a fresh one.

**Options** (this is a judgement call, not an obvious fix):

- Mirror #81: refuse a stack with any imaged member, so late arrivals get their
  own stack. Costs one extra card per sample in that case.
- Keep the merge (one stack per sample really is the friendlier board) and fix
  D1 instead, so completion only ever stamps what was ticked.

The second is probably right — the merge is a feature, the back-fill is not.

**Verified correct alongside it:** a **closed** stack never absorbs anything. A
second wave of slides for the same sample, after its stack was analyzed and
retired, correctly opened a new stack (`#5 sample/1 ready_for_imaging ×1`).

---

### D3 — moving an already-stained slide into a fresh rack silently shuts that rack to every later slide

**Severity: medium**

*Reproduction — `03-stack-merge.spec.ts`, "a stained slide moved into a fresh
rack, and what that rack accepts next"*

1. Cut block 1 for H&E, block 2 for PAS. Two fresh loading racks.
2. Tick "Stained" on the H&E rack.
3. Use **Move…** (#115) on the stained H&E slide to reassign it to **PAS**. It
   joins the fresh PAS rack, keeping its stained stamp (correct, and deliberate).
4. Cut block 3 for PAS.

**Observed:** block 3's PAS slide does **not** join the PAS rack. It opens a
second one:

```
after a stained slide joined the PAS rack, a new PAS slide produced
2 open PAS rack(s): #2 ×2 (1 worked), #3 ×1 (0 worked)
```

This follows logically from #81 — the PAS rack now has a worked member, so it is
no longer a loading rack — but nothing on screen explains it. The bench sees two
PAS racks and no reason why, and the second will keep collecting while the first
sits there.

**Related, same test set:** step 3 also produces a rack holding one stained and
one unstained slide, which the rack's own protocol cannot express (D4).

---

### D4 — a rack's protocol is a single state, but a rack can hold slides in different states

**Severity: medium** (display contradicts the data)

*Reproduction — `03-stack-merge.spec.ts`, "what the bench SEES on a rack that
mixes worked and unworked glass"* — D3 steps 1–3, then open the PAS rack.

**Observed**, from the same rack at the same moment:

- the panel's workflow section reads **`Protocol v1 · 0/2 complete`**
- the panel's stack timeline reads **`Stained 2026-08-12`**
- the database holds `MX-0001-A STAINED, MX-0002-A unstained`

Three different answers to "has this rack been stained?" on one screen. The card
itself (`PAS 2 samples 2 slides …`) says nothing about it either way.

**It is worse than a display problem.** My first pass here recorded that
re-ticking the rack's Stained step *keeps* the already-stained slide's original
date. That was wrong — the two timestamps happened to fall in the same minute, so
the check could not tell them apart. Re-run with a planted date, the original is
**overwritten**; see **C2** in Part 2, and `syncAssayStackWorkflowStep`, which
issues `SET stage_stained_at = ?` with no `COALESCE`. So a mixed rack does not
merely display three answers — ticking it destroys one of them.

**Suggested direction:** either show per-slide state in the rack panel (a tick
beside each slide, not just a rack-level fraction), or refuse the move that
creates the mixture and require the slide to go back to extras first.

---

## Observations — worth a decision, not obviously bugs

### O1 — the sample timeline records almost nothing

A complete run of 8 blocks through the entire pipeline — intake, two processing
batches, embedding, 17 cut groups, 28 slides, staining, imaging, analysis —
wrote **8 rows** to `sample_timeline_events`, all of them `sectioning_cut`.

Block-level stages are stored as columns on `samples` and render fine. But for a
posterity application, nothing narrates staining, imaging, analysis, batch start
or pickup as *events*. Removals do write one (with the reason), which is what
makes the gap noticeable: the app clearly can do this, and does it for exactly
one kind of thing.

### O2 — the same assay pair is encoded three different ways

- cutting-plan dialog and the Logs "Add a stain" control: `stain::H&E` (two colons)
- rack **Move…** control (#115) and the extras "Assay for …" control: `stain:H&E` (one colon)

Each side parses what it emits, so nothing is broken today. It is a trap for the
next person to wire these together, and it cost time in this very exercise.

### O3 — one selection control has no accessible name

Every selection control in the app carries an explicit label — `Select EE-1`,
`Select slide EE-1-A`, `Reassign EE-1-A`. The extras panel's per-slide checkbox
has none; it borrows its name from the wrapping `<label>`, so it is named after
the slide code itself. Cosmetic, but it makes that one control the odd one out
for anything driving the UI by name — a screen reader included.

### O4 — renaming a project is three clicks deep and unlabelled

The rename cascade (#106) works perfectly: renaming `RN` → `ZZ` under a full
board renamed 4 samples and 5 slides with nothing left behind. But the only
route to it is **Settings → Manage users → Projects tab → pencil icon**, where
the pencil's only name is the tooltip "Edit". Nothing on the sidebar, where the
projects live, suggests a project can be edited at all.

### O5 — a block's cutting plan splits into one cut group per agent

8 blocks with mixed plans produced **17** `section_requests`. This is by design
(and #33 aggregates them into one card), but it means the group count grows with
agents per block rather than with blocks, which is worth knowing before anyone
reasons about that table's size.

---

## Verified correct under load

Everything below was driven and then checked against the database.

**Intake and numbering.** 3 projects, 18 samples created in bulk (6 / 4 / 8) with
per-sample descriptions and a shared description. Each project numbers from 1
independently. No sample was created with an empty description (#88).

**Processing.** Two runs alive at once, five blocks and three. Members recorded
correctly; no sample in two open batches.

**Cutting.** Eight different plan shapes — pure extras, a single stain, repeated
stains, pure IHC, mixtures, an 8-slide plan. 28 slides produced, exactly as
planned. No slide carried a cut timestamp while its group was still queued
(#95/#118). A queued group's slides stayed editable (#116).

**Loading-rack merging.** Two fresh slides for one agent pool into one
cross-sample rack. A rack that has begun its protocol never absorbs a newcomer
(#81) — verified for both the cutting route and the reassignment route.

**Cross-project pooling.** Four blocks from two different projects pooled into
one H&E rack, then scattered into exactly four per-sample stacks with no slide
landing under the wrong sample.

**Reassignment (#115).** Moving an untouched slide into an untouched rack joins
it rather than making a second; the rack it left is retired, never left open and
empty; sending a slide back to extras clears its agent, stage and rack.

**Removal (#83).** Removing an extra requires a reason, keeps the slide as a
record, drops its rack place, and writes the reason to the timeline.

**Exhausted blocks (#70).** `Mark Exhausted` sets the flag, and adding a stain
afterwards is refused with a specific message: *"EX-0001 is marked exhausted and
has no extra slides left — it cannot be cut again for H&E."*

**Archive (#74).** Hides the sample without deleting the row.

**Undo / redo.** 25 undos rewound a full board to nothing (`samples: 0`) and 25
redos replayed it exactly — every table back to its peak count, integrity intact
at both ends, and the signed-in user preserved throughout. Undo of a *merge* put
both racks back the way they were.

**Backups.** A backup taken mid-workflow, three more slides cut afterwards, then
revert — restored to precisely the captured state, user session preserved.

**Logs.** Row count matches the sample count; project filter matches per-project
counts exactly; all six stage filters return sane sets; search matches `VA-1`,
`VA-0001` and `va1` alike (#87/#120) and returns nothing for a term that matches
nothing; every column sort leaves the table populated; archived/removed toggles
work.

**Board controls.** Every filter and sort on Pre-processing, Needs Embedding,
Needs Sectioning and Ready for Imaging cycled through every option without
emptying its column or throwing.

**Manifest.** 112 rows for 112 audit events — the view and the table agree.
Search and both filters work.

---

## Not covered by this pass

- **Sync / viewer mode.** The existing `tests/e2e/sync.spec.ts` and
  `viewer-readonly.spec.ts` cover it; the stress suite runs a single
  workstation.
- **The second protocol checkbox path.** `getOpenStainRack`'s comment describes
  a second set of protocol checkboxes in the *cut group* drawer wired to
  `syncAssayWorkflowStep`. I could not reach it from the board in this harness —
  every staining card opened the rack drawer. The rack path is verified; if the
  cut-group path is still reachable in the shipped UI it deserves its own test,
  since it is the route the first #81 fix missed.
- **Drag-and-drop transitions.** The fill uses the drawer's buttons for
  embedding after a drag proved too positional to run 40 times reliably. Drags
  are still exercised for the processor and batch moves, and by the functional
  suite.
- **Export file contents.** Export goes through the Tauri save dialog, which the
  browser shim cannot open, so only the click path is verified here.
- **#77 (Manifest attribution)** still has no automated coverage of any kind —
  flagged since 0.7.0.

---

## Running it

```bash
pnpm exec playwright test --config playwright.stress.config.ts
```

Retries are off by design: a stress run that quietly passes on the second
attempt has hidden the thing it was built to find. Findings are printed per test
and attached to the report.

---

# Part 2 — bench reality, and what the data model makes hard

Part 1 asked "does the software do what it says". This part asks the question
that matters more: **when something happens to a piece of glass, can the record
say so?** A workflow app is only as good as its worst correction, because that is
the one the technician works around with a pen and paper — and once there is a
pen and paper, the database has stopped being the record.

Every scenario below was attempted through the UI (`07-bench-reality.spec.ts`)
and then checked in the database.

## What the software handles well

| At the bench | In the software |
|---|---|
| **A slide breaks in the rack, mid-protocol** | Select it in the rack panel → Remove → reason required. It leaves the rack, keeps its stained date, and stays in the log as removed with the reason. Correct. |
| **Change of mind before staining** | *Move… → Back to extras* returns it to inventory, clearing agent, stage and rack. Correct. |
| **Wrong agent, caught before staining** | *Move…* to the right agent. It joins that agent's loading rack; the emptied rack is retired. Correct. |
| **Mis-ticked a protocol step** | Un-ticking clears the stamp. Reversible. |
| **Images came out poor; re-take them** | Un-ticking "images captured" clears the stamp. Reversible. |
| **A slide is lost after it was analyzed** | I expected this to be impossible — the stack is retired and the card has left the board. It is not: the **Logs drill-down still offers Remove**. Correct, and worth knowing. |
| **The block is spent** | Mark Exhausted, and later stain requests are refused with a specific reason. Correct. |

## What the software makes hard or impossible

### C1 — "it was stained with the wrong thing"

*Verified: "a slide is stained with the wrong agent".*

A slide requested as PAS goes into the H&E dish. *Move…* corrects the agent and
keeps the stained date, which is right. But `assay_name` is **one field holding
two different facts**: what was asked for, and what the glass actually is. After
the correction the slide says "H&E", and nothing says a PAS was ordered and never
made — so the block no longer looks like it still needs one.

The only trace left is the `sectioning_cut` timeline event that happens to name
the original plan. That is incidental, not a record of the mistake.

### C2 — a rack-level tick rewrites every member's stained date

*Verified with a planted date: a slide stained `2020-01-02 09:00`, moved into a
rack, then that rack's Stained step ticked — the slide now reads
`2026-08-12 23:10`.*

`syncAssayStackWorkflowStep` issues `SET stage_stained_at = ?` for every slide of
that assay in the rack, with **no `COALESCE`**. So:

- ticking overwrites the true date of any slide stained earlier elsewhere —
  which is exactly what #115's *Move…* now makes easy to arrange;
- un-ticking sets it to `NULL` **for the whole rack**, including slides that were
  genuinely stained on a previous run.

Same class as D1: a rack-level action writing slide-level truth it does not know.

### C3 — a slide cannot be re-stained

One slide carries one `stage_stained_at`. A pale H&E sent back through the
stainer either overwrites its own history or goes unrecorded. There is no concept
of a staining **run**, so "stained twice, second time properly" cannot be said —
and neither can "counterstained".

### C4 — a slide cannot be moved to a different block

Every slide reaches its sample through `section_request_id`, and **no code path
anywhere updates that column**. A slide cut from block A and labelled B can never
be corrected. The only recourse is to remove it and cut another, which destroys
the fact that the glass physically exists and is sitting in a folder.

I would rank this highest of the four: mislabelling is common, it is discovered
late, and the workaround is a lie in the record.

### C5 — a good ribbon cannot add a slide to a group already cut

If the block ribbons better than planned and the technician mounts one more
section, there is no way to add it to that cut group. The only route is a fresh
cutting plan, which reads in the log as a second, separate trip to the microtome
on a later date.

---

## Stepping back: would a simpler structure make this easier?

### The one observation that explains most of the findings

**The same fact is stored in three places, and they are allowed to disagree.**

"This slide was stained on date X" lives on:

1. `slides.stage_stained_at` — the physical truth,
2. `slide_stacks.stage_stained_at` — the rack's copy,
3. `checklist_items` — the protocol step that was ticked.

Every defect found today is a synchronisation failure between those copies:

- **D1** — stack-level completion writes slide-level stamps for slides nobody ticked.
- **C2** — a stack-level tick overwrites slide-level dates it does not know.
- **D4** — a panel reading `Protocol v1 · 0/2 complete`, a stack timeline reading
  `Stained`, and a database holding one stained and one unstained slide. Three
  answers on one screen.
- **D3** — the merge guard has to consult *both* the stack row *and* every member
  slide, precisely because the copies can disagree. `getOpenStainRack`'s
  six-column-plus-`NOT EXISTS` predicate is not complexity for its own sake; it
  is a workaround for duplicated state.

### The smaller, sharper structural problem

**`slide_stacks` is doing two unrelated jobs.**

- `kind = 'stain'` — a cross-sample **rack**: a batch of work, a real object on a
  bench, shared by many samples.
- `kind = 'sample'` — a per-sample **bundle** at a stage: a grouping for the
  board, belonging to one sample, with no physical existence at all.

They share one table, one stage vocabulary and one set of timestamp columns, but
they are different concepts with different merge rules — which is *exactly* why
one has an "untouched" guard (#81) and the other does not (D2). That bug is a
direct consequence of two ideas wearing one table.

**This is the cheapest high-value change available**, and far smaller than an
event log: give the rack its own table, or make the per-sample bundle purely
*derived* — it is a `GROUP BY sample_id, current_stage` over slides, and storing
it buys nothing. Either way a whole class of confusion disappears and D2 stops
being possible to write.

### The larger change: events instead of columns

The standard fix for the three-copies problem is to record what happened and
derive what is true:

```sql
slide_events(
  id, slide_id, event_type, occurred_at, recorded_at, user_id,
  stack_id,                 -- the run it happened in, if any
  assay_type, assay_name,   -- what was ACTUALLY applied
  details
)
```

Mapped against the findings, this is not theoretical:

| Finding | What an event log does to it |
|---|---|
| **D1** back-filled imaging | Impossible — no column to back-fill. Completion emits events for the slides that have one, or emits them explicitly and attributed. |
| **C2** overwritten stain date | Impossible — a second staining is a second row; the first is never touched. |
| **C3** re-staining | Free. Two staining events on one slide. |
| **C1** wrong agent | Expressible: `requested PAS` and `stained H&E` are two events. One `assay_name` column cannot hold both. |
| **D4** contradictory rack display | One place to ask. The rack shows a derived "3 of 5 slides stained" — the per-slide truth the current design cannot express. |
| **D3** silent rack shutting | The guard becomes "no member has a staining event", and the UI can finally explain itself. |
| **C4** wrong block | Becomes tractable: identity separates from history, so re-parenting is an update plus a `relabelled` event rather than a structural impossibility. |

**Is it simpler?** Fewer places for one fact, and one rule instead of three — yes,
in the sense that matters here. It is more rows and needs derived reads, so
"simpler" is not the same as "less code".

### What I would actually do

**The schema is the wire format** (`docs/shared_data_sync.md` §1): the synced
payload *is* the SQLite file, so a schema change means every instance upgrades in
lockstep. That constraint decides the sequencing, not taste.

1. **Now, in a patch.** Fix the four defects where they stand. `COALESCE` on the
   stain stamp; make imaging completion stamp only what was ticked; say on the
   board why a second rack appeared. Hours of work, no schema change, no lockstep
   upgrade.
2. **Next cycle, contained.** Split the two meanings of `slide_stacks`, or make
   the per-sample bundle derived. Additive, and it removes D2 by construction.
3. **The cycle after, if it earns its place.** Add `slide_events` **additively**,
   for staining and imaging only, dual-written alongside the existing columns.
   Move reads across one at a time and keep writing the columns, so older builds
   and older backups stay readable. Leave samples, processing and cutting on
   columns — they are append-only in practice and have produced no defects.
4. **Decide C4 separately.** Whether a slide may be re-parented to another block
   is a *policy* question about what the log is allowed to say, not a technical
   one. It needs your answer before any of the above matters to it.

What I would resist is a rewrite. Every defect found today is small, local and
fixable in place; the structural work earns its keep by preventing the *next*
one, and it should be taken in additive steps that never cost a shipped build its
ability to open an old backup.
