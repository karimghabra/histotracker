# Changelog

## 0.14.0 - unreleased

Two things the log could not tell you.

- **Embedding Notes (#137).** How a specimen should be embedded — which face
  goes down, which end is proximal, whether it gets bisected — is decided when
  the block is logged in, and read by whoever picks up the mould. It had nowhere
  to live: it went into the cut notes, which are read one station later at the
  microtome, or into General Notes with everything else about the block. There
  is now a box for it at sample creation, and the note is shown wherever the
  block is read — the board drawer, the expanded Logs row, and both exports.
- **Assigned stains now show up in the log before anything is cut (#136).** The
  main screen has always known a block owes a stain: the card flags it, and the
  drawer lists it as "Requested". The Logs read physical slides only, so a block
  sitting in fixative with Safranin O assigned read as having no stains at all —
  and neither did a block already cut for one agent with a second still owed.
  Both now appear, marked *(assigned)* so a plan is never mistaken for glass,
  and the stain filter, the assay-type filter and the search all find them.

  This applies to the exported log too, which is the part worth saying out loud:
  the CSV and Excel exports build their rows from the same helper the on-screen
  table does, so the spreadsheet you take to the bench and the screen you took
  it from cannot disagree about what a block owes.
- **New Sample previewed a different ID than the one you got.** The dialog
  showed the stored, zero-padded code (`EE-0001`) while the board, the Logs and
  both exports have shown the unpadded form (`EE-1`) since #87 — so the first
  thing a new user does named the block one way and every screen after it named
  the same block another. The preview, and both ends of the range shown for a
  batch, now use the display form.
- **The Excel exports were writing empty workbooks.** Every `.xlsx` this app
  produced through a Save dialog — the Logs export and the full workbook export
  — opened as a blank sheet: not one header, not one row. The spreadsheet
  writer had dropped the old argument shape we were still calling it with, and
  accepts it silently rather than failing, so the file was written and saved and
  simply had nothing in it. All three workbook writers now go through one
  function that uses the supported form.

Schema: migration 0025 adds `samples.embedding_notes`. Additive — an existing
database gains the column filled with the empty string, no row is rewritten, and
an older build ignores it. Proven directly against a populated pre-existing
database in `npm run test:legacy`, by both routes an update can arrive (the
migration, and the runtime convergence a backup revert or sync pull takes).

## 0.13.2 - unreleased

No schema change. Six more defects, found by pointing **many random walkers at
one large board** — 150 blocks, ~400 slides — and checking all 19 invariants
after every move. Full account in `docs/stress_test_v2.md`.

The walkers run in two modes, because they answer different questions. Taking
strict turns, they explore *sequences* on a board big enough for the rules to
bind, and any break is attributable to one exact action. Firing together, they
explore *overlap* — the surface where reading a value and writing it back are
separated by an `await`.

- **A slide could be coverslipped before it was stained.** The protocol
  checklist drew every step as its own button with no ordering at all, so
  ticking them out of order was a click away — and produced a slide whose record
  said it was coverslipped on Tuesday and stained on Wednesday. The order is now
  enforced, and un-ticking a step while a later one is done is refused too.
- **A slide that had already been imaged could be sent back to a stainer**,
  which restarted staining on glass whose record says it has been through. A
  slide carries one set of dates, so the new staining landed *after* the imaging
  that preceded it. Refused, pointing at the honest route: cut another section.
- **Sending a group back for cutting left its old rack on the board, empty.**
  Third instance of one pattern — moving a slide out of a rack and retiring the
  rack it emptied are one operation, and three separate places were doing only
  the first half.
- **Cutting a block and refiling a slide could both fail with a database
  error** when two of them overlapped, for the same slide-letter reason fixed in
  0.13.1 for a third path. All three now retry.
- **A rack could be retired while live glass was still in it**, and — the mirror
  image — **left open and empty** when two calls each removed a different slide.
  Retiring now refuses to strand live glass, and the empty sweep runs over every
  rack in one statement rather than asking about one rack at one moment.

**Known and not fixed:** under genuinely simultaneous operations, rack
membership can still land wrong. There is no transaction boundary in the data
layer, so every "choose a rack, then write to it" pair is a window; five
instances were closed this round and a sixth appeared immediately, which is the
point at which patching pairs stops being the answer. The real fix is a mutation
lock, which is a design change rather than a patch. In practice the app never
issues these operations simultaneously today — the swarm is harsher than any
single user can be — so this is a latent risk, recorded rather than hidden.

## 0.13.1 - 2026-08-13

No schema change. Five defects, all found by a **second stress harness**
(`tests/stress2/`, `docs/stress_test_v2.md`) built from what the first one got
wrong — most importantly that it had reported a stain date as "preserved" when it
had been overwritten, because timestamps are stored to the minute and both values
landed in the same one. v2 plants dates the code cannot produce, re-derives every
finding a second way before recording it, and walks a seeded random path through
the workflow instead of following hand-written happy paths.

- **A stain request could take an extra out of a cutting plan that had not been
  cut.** The Extras inventory has always known that a slide is a *plan* until its
  group leaves the queue; the code that picks a free extra did not. So a block
  with a saved-but-unsent plan answered "pulled from an extra" and put glass
  nobody had cut into Staining — where one rack tick recorded it as stained,
  with no cut date. Same family as #118: the plan is not the cut.
- **A planned slide could be assigned to an agent.** It is a line in a plan, not
  a piece of glass, and it cannot go on a stainer. Change the cutting plan
  instead, which has been editable since #116.
- **Removing a slide left its rack on the board, empty.** The panels you actually
  use tidied up after themselves, so this was invisible — but the tidying lived
  in the caller rather than in the removal, which is the fragility that let #73
  ship broken once already. It now happens where the removal happens.
- **Double-clicking "add a slide" showed a database error.** Two clicks race for
  the same slide letter; the database refused the duplicate — the record was
  never at risk — but the second click reported `UNIQUE constraint failed`. It
  now takes the next letter and adds a second slide, which is what the two
  clicks asked for.
- **Images could be recorded for a slide that had been removed**, from a panel
  left open when it went. Refused now. Removing an already-removed slide also
  wrote a second removal to the timeline for one piece of glass; that is a no-op.

## 0.13.0 - 2026-08-13

**Schema change (migration 0024) — every instance must be on this build.** Two
additive columns on `slides`; older builds ignore them and older backups gain
them on open. See `docs/shared_data_sync.md` §1.

Everything here came out of a deep stress test of 0.12.0 rather than a report —
21 scripted runs that fill the board up, drive every workflow through the real
UI, and then read the database to check what actually happened
(`docs/stress_test_0_12_0.md`). Nothing crashed. What it found were four places
where the record did not match the work, and five corrections the bench needs
that the app could not express.

### The record now matches the work

- **A rack's protocol tick no longer rewrites a slide's stain date.** The step
  wrote `SET stage_stained_at = ?` over every slide in the rack, so glass that
  arrived already stained — easy to arrange since 0.12.0 let a slide be moved
  between agents — was restamped with today. Proved with a planted date:
  `2020-01-02` became today. Ticking now keeps the earlier date, and **unticking
  clears only the slides that rack actually stamped** rather than the whole rack.
  Both sets of protocol checkboxes are fixed, not just the one that was found.
- **Completing imaging no longer invents a photograph.** A per-sample stack keeps
  accepting slides after its imaging session — it has to, since one open stack
  per block per stage is a database constraint — so *Complete Imaging* could be
  pressed on glass that arrived after the operator left the microscope, and it
  stamped every member. It is now refused, naming the slides: *"EE-1-B has no
  images captured yet."* The button says so before it is pressed, and the data
  layer refuses regardless of route.
- **A rack shows which of its slides are stained**, beside each slide, and says
  plainly when it holds a mixture. A rack reading `0/2 complete` over a slide
  stained last week, with `Stained` in its own timeline, was three answers to one
  question.
- **The board says why a second rack appeared.** A rack that has begun its
  protocol cannot take newcomers (#81), so the next slide starts a fresh one —
  correct, and previously indistinguishable from a duplicate. The later rack is
  now marked *new rack*, with the reason on hover.

### Corrections the bench needs

- **"It was stained with the wrong thing."** `assay_name` was doing two jobs:
  what was ordered, and what the glass is. Correcting a slide erased the order,
  so a PAS that was asked for and never made simply vanished. The order is now
  kept separately, and a slide whose two disagree says *asked for PAS* in the
  Logs. This is the migration.
- **"This slide is from the wrong block."** A slide reached its block only
  through its cut group, and nothing anywhere could change that — so a
  mislabelled slide could only be removed and re-cut, which throws away the fact
  that the glass exists. It can now be **refiled** from the Logs, with a reason.
  The glass keeps every stamp it earned, takes a fresh code from the correct
  block's own sequence, the old code stays burned so nothing can reuse it, and
  **both blocks record the correction**.
- **"The ribbon gave one more than the plan asked for."** A slide can be added to
  a cut group that has already been cut, from the group's own panel. It takes the
  next burned letter and is cut, because it was — rather than needing a whole new
  cutting plan, which records a second trip to the microtome that never happened.
- **"It went through the stainer twice."** The slide keeps the date it was first
  stained, which is the truth about that glass, and the second run is recorded on
  the timeline. Reassignments are recorded there too: a correction that leaves no
  trace reads, later, exactly like the mistake never happened.

## 0.12.0 - 2026-08-13

No schema change.

**The Logs told you the wrong thing in three ways, all from one cause (#117,
#118, #119).** A sample's stage was a single value derived from "has this
timestamp ever been set". It is now a **set**, derived from where the block and
its slides actually are:

- **A queued block is not Sectioned.** Slides are created when the cutting plan
  is made, so a block read *Sectioned · 0/1* before anyone had been near a
  microtome. Sectioned now requires the slides to have been cut, and the analyzed
  fraction no longer counts slides that do not exist yet.
- **The Staining / IHC filter finds things.** It required a *stained* timestamp,
  so a slide sitting in the staining column that had not been stained yet matched
  nothing and the filter came back empty.
- **Filters behave like inventories.** A block in Embedded Inventory whose slides
  are in staining is in both places, and now appears under both. Picking one made
  it vanish from the other.

**Stains:**

- **Adding a stain from the Logs adds it (#114).** It used to open the *sync
  request* dialog — the flow a viewer uses to ask the workstation for something —
  so on the workstation it filed a request with itself. It now takes a free extra
  if there is one, or leaves the block flagged as needing a cut.
- **No Add a Stain in the Embedded Inventory (#113).** The control silently
  consumed a free extra, which reads as "the block was stained" when an unrelated
  slide was used. At that stage the only action is a cutting plan; agents are
  chosen against real slides in the Extras inventory.
  *Where it went:* asking for a stain on an embedded block is now done from the
  **Logs**, which is the same operation with the same consequences — a free extra
  is taken if one exists, otherwise the block is flagged as needing a cut, and an
  exhausted block still refuses. The drawer keeps the part that only reads: the
  live Stains / IHC list, and Withdraw for an outstanding request.
- **Slides can be reassigned (#115)** — onto a different agent, or back to
  extras, from the rack drawer, even after they have reached staining. The slide
  leaves its rack for the one belonging to its new agent, and the rack it emptied
  is retired. Stamps already earned are kept: a slide stained as H&E and re-cut
  as CD31 keeps its stained-at date, because that is what happened to the glass.

**Cutting plans are editable while they are still queued (#116).** A group that
has been sent for cutting but not yet cut can be edited — reachable from the
block's own panel in the Embedded Inventory, as well as from its card.

**The Extras search finds things (#120).** `OG-11` now finds `OG-0011`, in
either direction, and several terms match in any order. The Logs search uses the
same matcher.

## 0.11.1 - 2026-08-12

No schema change. **Opening this build repairs lingering flags in your existing
database** — see below.

**The needs-cut flag clears when the cut happens (#112).** Two independent leaks
kept it lit on blocks whose slides were already sitting in Needs Sectioning:

- **A saved cutting plan flagged the block for ever.** 0.11.0 keyed that half of
  the flag on a timeline event, and an event is never cleared — so one saved plan
  flagged the block permanently, cut or not. It now also requires the block to
  still be *holding* a plan, and sending for cutting clears that. This was a
  regression introduced in 0.11.0 and it is the main thing this release fixes.
- **A cut did not always clear the request it fulfilled.** The trim skipped any
  planned group that named an agent without also naming its type, and the matcher
  demanded an exact type match — so such a request stayed outstanding for ever
  and no amount of cutting could satisfy it. Matching is now on the agent name,
  with the type honoured only when both sides state one.

**Your database is repaired on first open.** A one-time pass clears outstanding
requests that an existing slide already accounts for. It is a *multiset*
subtraction, so asking for the same agent twice still queues two slides. It
cannot be perfect — "stale because the trim failed" and "deliberately
re-requested after an earlier cut" look identical in the data — so it resolves
towards clearing, on the grounds that a flag you cannot clear is worse than one
you have to set again. Which is also why:

**Outstanding stain requests can be withdrawn (#112).** Each *Requested* line in
the drawer's Stains / IHC list now has a control to take it back, recorded on the
block's timeline. Both directions are recoverable by hand: withdraw one the
repair missed, re-add one it cleared too eagerly.

**Needs Sectioning can be filtered and sorted (#111)**, like the other busy
columns — by project, and by date queued, name or sample ID. Shift-range
selection follows the order on screen rather than the underlying one.

## 0.11.0 - 2026-08-12

No schema change.

- **Adding a stain applies to every selected block (#109).** The drawer has
  always been multi-select — the preprocessing checklist, Start Run, Delete and
  Mark Exhausted all act on the selection — but the stain dropdown read the one
  block whose panel was open, so selecting twelve and asking for H&E gave you one
  slide and no hint that the other eleven were skipped. The heading now counts
  what it will act on, and the result is summarised. A block that legitimately
  refuses (exhausted, no extras left) is reported and **does not abandon the rest
  of the batch**; the whole thing is still a single undo step.
- **The Embedded Inventory flag reads "needs cut" (#110).** It said "needs
  stain", which sent people looking in the staining column — but a pending agent
  on an embedded block is waiting to be **cut**: the slide that will carry the
  stain does not exist yet.
- **A saved cutting plan raises the same flag (#110)**, because somebody has
  decided how the block gets cut and the cut has not happened. Only a plan you
  *saved* counts — every block is auto-seeded one the moment it reaches Embedded
  Inventory, so flagging "has a plan" would flag the entire column.
- **Cutting plans can be saved in bulk (#110).** Save Plan was hidden whenever
  more than one block was selected, so a batch could be sent but never planned —
  twelve blocks meant opening twelve drawers. Each block keeps its own plan, so a
  bulk save writes what is on each page; "Copy to all blocks" is still there for
  when they should be identical. The plan dialog now takes the whole selection
  rather than only its embedded members, so a batch can be planned before it is
  embedded (Send stays hidden until every block can actually be sent, #98).

## 0.10.0 - 2026-08-10

Board and log housekeeping. No schema change.

- **Renaming a project renames what it named (#106).** A block's code is
  `<PROJECT>-NNNN` and a slide's `<PROJECT>-NNNN-X`, stored as text — so changing
  the acronym in Manage left every existing block and slide answering to the old
  one, and the log showed two prefixes for one project with nothing to say they
  were the same. The rename now carries through to samples, slides and
  outstanding stain requests. It is a **prefix swap, not a re-mint**: numbers and
  letters are untouched, so nothing is renumbered and no code already written on
  a physical slide changes meaning.
- **"Added" sorts by time, not by day (#107).** It sorted on `date_added`, which
  holds a date and no clock, so everything logged on the same day tied and the
  order looked arbitrary. It now sorts on the intake timestamp, breaking
  remaining ties by creation order, and the cell's tooltip shows the time it
  used. "Updated" gained the same tie-break.
- **Filters survive switching between the Board and the Logs (#104)**, and are
  dropped when you sign out — both views unmount when you leave them, so every
  filter was previously rebuilt wide open. Deliberately not stored in the
  database: a filter is one person's view of the bench, not a fact about the lab,
  and the next person at a shared machine should not inherit a board that
  silently hides most of it.
- **"Show removed" in the Logs (#105)**, beside "Show archived" and with the same
  default: removed blocks and slides are hidden until you ask for them. They are
  still in the record — one click away, flagged, with the reason.
- **Needs Embedding can be filtered and sorted (#103)**, like the other busy
  columns. Its date key is when the block came out of the processor.
- **Ready for Imaging tiles are readable (#102).** The block's description now
  sits beside its ID, and the agents waiting to be imaged sit below it, instead
  of a slide-by-slide breakdown that buried them.
- **Signing out by hand offers the way back in (#108).** The prompt fired only
  for the idle and launch sign-outs and claimed inactivity in both — untrue for
  the launch case even before this. It now says which of the three happened.

## 0.9.0 - 2026-08-07

The right-hand panel, mostly. No schema change.

- **The Stains / IHC list is live (#100, #101).** It used to be the comma-joined
  string typed at intake, frozen for ever — adding a stain there, or a viewer
  properly requesting one, changed nothing on screen, so the panel disagreed with
  the board. It now lists what actually exists: **one line per slide** carrying
  an agent, with its slide code and the state that slide is in (awaiting cut,
  in staining, imaged, analyzed), plus **one line per agent asked for** that no
  cut has produced yet. "Request a Stain" is now **"Add a Stain"**.
- **"Send for Cutting" only appears where you can send (#98).** Everywhere before
  the Embedded Inventory the button — and the dialog — say **"Cutting Plan"**,
  because that is all they can do there. The dialog's send button is *hidden*
  rather than greyed out; the plan is still saveable, so you can draft it early
  and it will be waiting.
- **The project switcher is gone (#99).** Moving a block between projects
  re-numbered it and rewrote every slide label — a lot of machinery hanging off a
  dropdown one mis-click from the preprocessing checklist, for something that
  should be got right at intake. The block's project is still shown in the drawer
  header. This reverses #60; the capability is removed, not just hidden.
- **The Logs show Short vs Long processing (#97)** as a sortable column, and in
  the Logs export. It decides an 18-hour or 52-hour protocol, so it belongs in
  the record of what was done to a block.

## 0.8.1 - 2026-08-07

**Delete on the board, Archive in the Logs (#96).** These were two different
intentions sharing one button, and the board had the wrong one.

- **The sample drawer's Archive is now Delete.** It asks for a reason and
  refuses without one, then takes the block, its cut groups and every slide it
  held off the board — exactly the treatment a removed slide or cut group
  already gets. **Nothing is deleted:** every row survives, the block keeps its
  place in the Logs flagged **Removed**, and expanding it shows who removed it,
  when, and why. Slide letters stay burned, so a later cut continues the
  sequence rather than reusing them.
- **Archiving is done from the Logs**, where it already lived — you can see what
  you are hiding, and tick "Show archived" to bring it back whole. Archiving is
  the reversible hide for a block you still expect to want; deleting records one
  that should not be on the board at all.

No schema change.

## 0.8.0 - 2026-08-06

Follow-up on 0.7.4 at the bench, plus the settings dialogue. **No schema
change** — the new settings live in `app_settings`, a table that has existed
since 0.5, so a 0.7.x build opens a 0.8.0 database and simply ignores the extra
rows.

**Settings (#92, #93, #94).** A cog at the foot of the left panel, above the
version number.

- **Cutting defaults are configurable.** Slides per block and minimum extras
  were the literals `4` and `2`, written out by hand in three files that could
  drift apart. They are now one setting each, and the slides-per-block default
  drops from 4 to **3**. Existing sectioning plans are untouched.
- **The idle sign-out window is configurable**, instead of a fixed 30 minutes.
- **The Manifest can be hidden**, button and view together — hiding it does not
  stop anything being recorded.
- **The top bar is less crowded.** Manage, Backups and the theme picker moved
  into Settings; they are set-up controls that were competing for space with the
  ones used every few minutes.
- **Manifest moved to the foot of the left panel**, above the cog. It is a
  record you consult, not a place you work, and it sat between the two views
  that are.

**Fixes to 0.7.4's own work:**

- **Removed slides are readable in dark themes (#83).** The struck-off row and
  its reason panel were painted with fixed near-white Tailwind reds under
  theme-aware text, so in the eleven dark themes they were pale grey on bright
  pink. They now blend the theme's own panel colour, which works for every
  present and future theme rather than a list of overrides.
- **A shared description is now a prefix, not a fallback (#86).** It was
  discarded outright the moment a per-sample row had anything in it, so filling
  in both — the natural thing to do — made it "do nothing". A sample now reads
  `shared | specific`, and the row list shows the shared half inline as you type.
- **The processor's Add list only offers blocks still waiting to be processed
  (#91).** Eligibility was purely "has this timestamp been set", and every one of
  those stays true for the rest of a block's life — so the whole Embedded
  Inventory was eligible to be loaded back into the machine. Refused at the data
  layer as well as hidden in the list.
- **A slide is recorded as cut when it is cut (#95).** The stamp was written when
  the cut group was *created* and queued, so every slide waiting in Needs
  Sectioning already read as Cut in the log — and undoing a sectioning could not
  clear a stamp that predated it, which is what made undo/redo look broken. It is
  now stamped when the group leaves the queue, whichever stage it lands in
  (previously two specific destinations stamped it and the rest did not), and
  cleared if the group is dragged back. Rows written by older builds are read
  through the same rule, so a queued group stops claiming a cut it never had.

## 0.7.4 - 2026-08-05

**Nothing is ever deleted (#83).** Histometer is a record, so a slide that was
cut and then lost now reads as *cut, then removed* rather than as though it never
existed. **No schema change** — no migration, no new columns, and a 0.7.3 build
opens a 0.7.4 database without trouble.

- **Removing slides keeps them.** "Remove slides" in the Extras inventory and in
  a rack, "Remove cut group" in the section drawer, and "Remove slide stack" all
  stop deleting rows. The slide leaves the board and its rack, keeps every
  timestamp it earned, and stays in the Logs flagged **Removed** — click the
  slide to read why it went, who recorded it, and when.
- **A reason is now required.** Each of those actions asks for one and refuses to
  proceed without it, replacing a confirmation box whose only content was a note
  about letter sequencing. The reason is stored on the sample's timeline, so it
  is part of the permanent record rather than a throwaway prompt.
- **Removed slides do not distort progress.** They are excluded from the
  analyzed fraction and from the sample's phase — previously a lost slide would
  have stranded its sample at "3/4 analyzed" for good. The Logs slide count shows
  the live total with the removed count beside it.
- **Emptied cut groups and racks retire instead of vanishing.** A cut group whose
  last slide is removed leaves the board but stays in the log; a rack emptied the
  same way is closed rather than dropped, keeping its completed protocol
  checklist as evidence the reagent steps were performed. This reverses 0.7.3,
  which deleted both.
- **The sample drawer's Delete is gone.** It cascaded through the block's cut
  groups into every slide they held — the most destructive action in the app,
  sitting beside Start Run. It is now **Archive**, which does what the button was
  actually being used for: the block leaves the board and the Logs' default view,
  keeps every record, renumbers nothing, and comes back whole from "Show
  archived". The underlying delete functions were removed outright, along with an
  unused one that would have erased a processing run and its protocol checklist.
- Dialogs are now announced to screen readers (`role="dialog"`).

A test now fails the build if any code path deletes a sample, cut group, slide
or processing run — the only exceptions being the two places that unwind a
multi-table write that failed part-way, where nothing was ever committed.

**Every sample now needs a description (#88), and batch entry was rebuilt (#86).**

- **"Same as above" could resolve to nothing.** The Description field was
  optional, a per-sample row could be blank, and a blank row fell back to a blank
  shared field — so a sample was created with no description at all, permanently,
  because nobody goes back to fill in a batch entered last month. Create is now
  blocked until every sample has one, and it **names** the samples that are still
  blank rather than just greying out. Enforced in the data layer too, so a future
  entry point inherits the rule instead of having to remember it.
- **Per-sample descriptions are no longer behind a checkbox.** Set a quantity
  above 1 and you get one row per sample straight away, each labelled with the ID
  it will become. The field above them is now **"Shared description (optional)"** —
  a fallback for the samples that genuinely are identical, not the main event.
- **The paste shortcut moved below the list it fills**, where it reads as the
  shortcut it is. It still maps line-for-line, and a blank line in a pasted
  column now shows up as a named blank sample instead of silently shifting every
  description down by one.

Existing samples with blank descriptions are left alone and stay editable from
the Logs row and the sample drawer.

**A processor run can be edited after it has started (#91).**

Forgetting a sample, or not selecting them all when the batch was created, is
noticed once the machine is already going — which is exactly when the old
planned-runs-only rule refused to help, leaving no remedy but abandoning the run.
Both planned and running batches are now editable from the batch drawer.

- A sample **added** to a run in progress joins it properly: it moves into the
  processor rather than sitting in Pre-processing on the board while physically
  being processed.
- A sample **removed** goes back to the end of pre-processing, ready to be loaded
  again, and does not keep a start time for a run it is no longer in.
- **One batch, one timer.** An added sample shares the run's existing ready time,
  so it gets less than a full cycle — the drawer says so before you add it, with
  the actual ready time. Start a separate run if you need the full duration.
- Every existing guard still applies: same protocol, no double-booking, and
  **only fully preprocessed samples**, so editing a run is not a back door around
  the check that starting one already enforces.

**Pre-processing filters by project and sorts (#89).** The queue where every
sample enters now has the same two controls as Embedded Inventory and Ready for
Imaging — filter by project, sort by date received, name or sample ID. The filter
clears itself when its project empties, rather than silently hiding everything
else.

**"Tag depth" is now "Create Tag" in the Logs (#90).**

**The sidebar says SELECTED, and stops clipping (#84).**

- The badge on the current project now reads **SELECTED**, and the heading above
  the list is just **Projects**. Every project in that list is active, so the old
  wording answered a question nobody asked while the real one — which project
  will a new sample go into? — went unanswered.
- **The selected row no longer sits proud of its neighbours.** Its highlight ring
  was drawn *outside* the row's box, making it 4px wider than every other row.
- **The project code no longer clips when the sidebar is minimised.** At 56px
  wide the selected project was carrying both a coloured fill and a dot, and
  dot + gap + three letters needed more room than the row had. The fill is the
  marker; the dot is gone.

## 0.7.3 - 2026-08-02

Follow-up to 0.7.2, from a second review pass over the same code. Fixes one more
data-integrity bug, restores a read that 0.7.2 took away from viewers by mistake,
and closes the last unmirrored gap in the test harness. **No schema change** —
no migration, no new columns.

**Data integrity**

- **Removing *every* slide from a cut group put them all back.** 0.7.2 stopped
  the initialiser from topping a group up, but only when the group still had
  slides in it — emptying one restored the exact condition the initialiser fires
  on, so the group reappeared at its original size on the next open, with new
  letters each time. Repeatedly opening an emptied card burned the sample's
  letter sequence without bound. The planned count now follows removals down, so
  "remove them all" is an instruction the database actually keeps. Removing a
  group's last slide also removes the now-empty group, instead of leaving a "×0"
  card in Needs Sectioning claiming a cut that would produce nothing — the rule
  slide racks already followed.
- **A failed cut left a phantom group behind.** `createSectionRequests` writes
  across two tables with no transaction; a failure part-way through left a group
  claiming more slides than it held, which could not be opened and therefore
  could not be deleted either. It now unwinds what it created.

**Viewer mode**

- **Viewers could not see the cutting plan.** The 0.7.2 read-only work hid the
  whole slide list instead of just its controls, contradicting what #72 asks for.
  The plan, existing tags, and the "awaiting stains" line are visible again; the
  controls stay disabled.
- **...and un-hiding it was not enough.** The drawer's slide list is fetched by a
  read that calls the initialiser, which *writes*. On a viewer that write is
  refused, and the refusal came out of the **read** — so a single cut group with
  no slides blanked the slide rows of every group on the card. The initialiser is
  a workstation-side repair and now simply does not run on a viewer.
- A viewer no longer runs the timed processing auto-advance, which was firing a
  refused write on mount and every 60 seconds and flashing a "read-only viewer"
  banner nobody had triggered — over the top of real messages like sync errors.
- "Confirm start" on a planned processing run is no longer offered to viewers.

**Smaller fixes**

- The "Duplicate" column in the section drawer took its letter from the
  per-section ordinal, which restarts at 1 for each cut group, so slides in the
  second group were mislabelled. It now reads the slide code (#75).
- Ctrl-click in the imaging queue could select across two columns at once (#82).
- The batch paste box kept showing stale lines after the quantity changed, and
  now warns when the number of lines does not match the number of samples (#86).
  The warning and the rows below it now agree on what a line is: a blank line
  inside a pasted column used to shift every following description onto the wrong
  sample and drop the last one, while the warning stayed silent because it only
  counted non-empty lines. A trailing newline — what a spreadsheet copy always
  ends with — still counts as nothing.
- Grouped cut groups listed their slides interleaved (A, C, B, D) because the
  ordinal restarts at 1 in each group. Same fix the Logs view already had (#75).
- The preselected-stains line printed its raw JSON at the user in three places.
- The collapsed sidebar showed no indication of which project was active (#84).
- The matcha theme rendered dark form controls on its light background (#78).

**Test harness**

- `syncAssayWorkflowStep` was the fourth workflow query never mirrored into
  `workflow-test.mjs`, which is why #81 shipped green twice. Mirrored, with a
  gate observed failing against the old lookup.
- The legacy-upgrade test's copy of `ensureRuntimeSchema` had itself drifted. It
  now reads `db.ts` and fails if any converged column is missing — which
  immediately turned up four it was not applying.
- Fixed `highestLetterOrdinal` reading a malformed code as a base-26 letter
  (`"not-a-code"` returned 62977, which would have thrown the slide-letter mark
  far into the future). Letters must now follow a numeric segment.
- The #81 data-repair gate could not fail: the harness still described racks by
  the 0.7.2 stack-column rule, so it passed whether or not the app implemented
  the fix. Both hand ports now match the shipped rule, with a gate built through
  the cut-group checkboxes — the path the old rule could not see — that fails
  against the old implementation.
- **The intermittent end-to-end failure is understood and fixed.** dnd-kit keeps
  a capture-phase click swallower alive for 50 ms after every drop, and the drag
  helper returned the instant the mouse came up, so the next click was a coin
  flip: dispatched on the right button, no error, nothing happened. Eleven specs
  carried retry loops and forced clicks blaming background refetches and
  re-render churn; that diagnosis was wrong. They now wait for clicks to
  propagate again. The suite runs clean with retries disabled.

**Known, deliberately not changed**

- A cut group emptied under 0.7.0–0.7.2 still refills itself once on its first
  open under 0.7.3, then stays removed. Distinguishing those rows from genuine
  pre-0.4.6 cut groups is not possible — they are the identical row — and
  guessing wrong would permanently destroy a real cutting plan. See
  `docs/audit_0_7_3.md`.

## 0.7.2 - 2026-08-01

Re-does the 0.7.0/0.7.1 fixes properly. An adversarial audit found most of them
did not work; each is now fixed at the invariant rather than at one call site,
and every gate has been **observed failing with its fix removed**. **No schema
change** — no migration, no new columns.

**Data integrity — these corrupt data on 0.7.x, please update.**

- **Removing a slide from the middle of a cut group bricked that group.**
  `slides` carries `UNIQUE(section_request_id, slide_ordinal)` and the top-up
  loop took its next ordinal from a live `COUNT`, so after removing a middle
  slide it retried an ordinal still in use — throwing on *every* open of that
  card, and poisoning delete too, so the group could not even be removed. That
  function is now an initialiser for empty sections only, which also stops it
  silently resurrecting a slide you deliberately removed.
- **Slide letters could be reused.** The allocator consulted a live count, which
  any delete lowers; only one of four delete paths compensated. It no longer
  reads a count at all, and a one-time backfill corrects existing databases at
  open — before any delete can matter.
- **Editing a description could write it onto a different sample (#79).** The
  drawer kept its draft across a sample switch, so editing EE-1, clicking EE-2
  and pressing Save wrote EE-1's text onto EE-2. All four drawers are now keyed
  by id, so no draft of any kind survives a switch.
- **Staining racks still merged (#81).** There are two "Stained" checkboxes; the
  0.7.0 fix covered one. Rack state is now derived from the member *slides* —
  what every path must write — so both are covered, and the repair for existing
  databases was widened to match.

**Features that had shipped but did not work**

- **#77 — the Manifest.** `audit_events` has been recorded since 0.4 but nothing
  ever read it, so the app could not answer "who made what changes". There is
  now a Manifest view, filterable by person and action.
- **#72 — viewer mode** refused writes at the data layer but still offered the
  controls, so clicks did nothing. Every mutation now refuses at one choke point
  with a clear message, and nothing can fail silently anywhere in the app.
- **#74 — archiving** hid the block but left its cut groups, extras and rack on
  the board. All of them now go; a shared rack stays while another sample uses it.
- **#80 — drying** was removed from new checklists only. It is gone from both
  timelines and both exports, and racks stuck mid-protocol on upgrade are freed.
- **#71** a request that could not be applied was deleted without trace; it is
  now recorded as rejected, with the reason.
- **#75** exports and the synced status sheet listed slides A, E, B, F for a
  twice-cut block. **#76** the signed-in user survived reboots, misattributing
  the next person's work. **#84** creating a project did not select it, and the
  selection was lost on restart. **#86** lowering Quantity back to 1 wrote a
  hidden description. **#82** shift-selecting in a filtered queue silently
  selected hidden tiles.

**Why this was needed**

Playwright never ran in CI, two tests were vacuous, and four `db.ts` functions
were never mirrored into the harness as `CLAUDE.md` requires — so the fixes
passed while being unusable. All three are fixed, plus an invariant that fails if
any allocator reads a live count again.

> **Correction (2026-08-01).** An adversarial audit found that most of the fixes
> claimed in 0.7.0 and 0.7.1 below do **not** actually work. Genuinely resolved:
> #70, #78, #83. Partial: #75, #82, #84. Not resolved: #71, #72, #73, #74, #76,
> #77, #79, #80, #81, #86. Three of those corrupt data on a database upgraded
> from 0.6.x — see the audit correction at the top of
> `docs/issue_remediation_plan.md`. The entries below are left unedited as a
> record of what was claimed; do not read them as current status.


## 0.7.1 - 2026-07-31

Fixes a 0.7.0 regression, makes two shipped-but-unreachable features actually
usable, and closes the three new issues. **No schema change** — no migration, no
new columns; existing databases, backups and viewer snapshots are untouched.

- **Ready for Imaging no longer empties itself (#85).** Marking the last stack of
  a filtered project as analyzed made the column go blank while the filter
  appeared to read “All Projects”. A `<select>` whose value leaves its option
  list does not blank — the browser silently shows the first option — so the
  control said “All Projects” while the filter was still narrowing to a project
  that had no stacks left. The filter is now reset for real, and it no longer
  disappears when the queue drains (which used to leave it stuck with no way to
  clear it). **Regression introduced in 0.7.0.**
- **Sample descriptions are actually editable now (#79).** 0.7.0 added this as a
  faint 12px pencil beside a label and nobody could find it — a feature you
  cannot find is not shipped. Descriptions are now an always-visible field in the
  **Logs** drill-down, right beside the notes you already edit, and the drawer
  shows a proper bordered “Edit” control instead of a bare icon.
- **Sample IDs no longer carry leading zeros (#87).** New samples are `EE-1`,
  `EE-22` — not `EE-0001`. **Existing samples keep the codes already written on
  their blocks and slides**; nothing is renamed. Because a database in daily use
  will hold both spellings, lookups, sorting and Logs search now treat `EE-0001`
  and `EE-1` as the same sample — including the request-matching path, which
  previously failed silently and would have dropped a technician's request.
- **Each sample in a batch can have its own description (#86).** Tick “Give each
  sample its own description” when creating more than one, and optionally paste a
  column of descriptions straight from a spreadsheet. Blank rows fall back to the
  shared description; the whole batch is still a single undo.
- **Removing slides from a staining rack is labelled (#73).** It was hidden
  behind an unlabelled icon; it now reads “Remove slides”, matching the Extras
  inventory.
- **Sync attribution is finally shown (#77).** 0.7.0 recorded who published a
  snapshot and built the “changes by …” message, but nothing ever rendered it.
  It now appears next to the sync status.
- **Setup no longer assumes a role (#72).** The role cards defaulted to
  *Viewer* and the form never checked, so pressing Connect without choosing
  configured a read-only install — which since 0.7.0 hides every editing control,
  presenting as “the app lost half its features”. A role must now be chosen
  explicitly.

## 0.7.0 - 2026-07-28

Slide removal, archiving, and a genuinely read-only viewer.

> **Schema change — deploy together.** This release adds two columns to
> `samples` (`slides_issued`, `archived_at`). Both are additive, so existing
> databases, backups and viewer snapshots keep loading, and older images
> converge automatically on open. But the synced payload *is* the SQLite file
> (`docs/shared_data_sync.md` §1), so **every workstation and viewer should be
> updated to this build together.**
>
> This was tested rather than assumed: `scripts/make-legacy-db.mjs` builds a real
> pre-0023 database (migrations 0001–0022, populated with bench-shaped data) and
> `pnpm test:legacy` upgrades it by **both** routes — the plugin-sql migration and
> the runtime `ensureRuntimeSchema()` convergence used when an image is swapped in
> by undo or a sync pull — asserting no rows are lost either way. The same image is
> then opened in the actual running app by `tests/e2e/legacy-db-upgrade.spec.ts`,
> which checks it boots with a clean console, keeps every sample and slide code,
> auto-repairs the merged staining rack, and supports archiving and slide removal.

- **Slides can be removed at any point, and their letters are never reused
  (#73, #83).** Extras can now be deleted from the Extras inventory (select →
  **Remove**), alongside the existing removal from a stack. Letters used to come
  from a live count of the sample's slides, so deleting slide C handed "C" to the
  next cut — which, because slide codes are unique, actually **failed with a
  database error** rather than merely renumbering. Letters now come from a
  high-water mark: delete C and the next slide is E, as intended.
- **Samples can be archived and restored (#74).** In the Logs view, expand a
  sample and choose **Archive** — it asks first, and explains that nothing is
  deleted. Archived samples drop off the board and out of the log by default;
  tick **Show archived** to see them (they carry an *Archived* badge) and
  restore any of them. No numbering changes, and the action is undoable.
- **Viewer mode is properly read-only (#72).** Viewers could previously click
  controls whose writes the data layer then rejected, leaving spinners that
  never resolved. Depth tagging, stain requests, cutting, slide assignment and
  removal, archiving, timeline edits and the sample-panel action bar are now
  simply not offered on a viewer, which still sees cutting plans, timelines and
  existing tags as before.
- **A viewer's own stain requests show up immediately (#71).** A submitted
  request was previously invisible on the requesting machine until the
  workstation drained it, republished, and the viewer pulled the new snapshot —
  up to two sync intervals — and disappeared without trace if any step failed.
  The viewer now remembers its own submissions locally (outside the database
  image, which is replaced wholesale on every pull), so **My requests**
  populates straight away; the local copy is dropped once the real record
  arrives, so nothing is ever listed twice.
- **Drying is no longer a tracked step (#80).** The stain and IHC protocols are
  now *Stained → Coverslipped*, and finishing those two moves the rack to Ready
  for Imaging. Racks that were already part-way through the old three-step
  protocol when this build lands keep their third step so they can be finished
  as expected; only new racks get the shorter protocol.
- **Snapshots record who published them (#77).** `manifest.json` now carries the
  signed-in user (falling back to the workstation's operator name), and the
  viewer's sync status reports "changes by …" after a pull.
- **Idle auto log-out (#76).** After 30 minutes without interaction the signed-in
  user is signed out and prompted to sign back in, so work on a shared bench
  machine isn't attributed to whoever used it last. Mouse *movement* alone does
  not count as activity. You can dismiss the prompt and continue unsigned —
  changes are then recorded as unsigned, as before.

## 0.6.1 - 2026-07-28

Third issue batch — staining-rack separation, plus editing and filtering fixes.
**No schema change:** this release adds no columns or tables, so existing
databases, backups and viewer snapshots keep loading and older builds stay
readable. One automatic data repair runs on first open (see #81).

- **Samples moved into staining no longer merge with an already-stained stack
  (#81).** A rack whose *Stained* box was ticked but which had not yet been
  coverslipped still looked like an open “loading” rack, so newly-moved samples
  were absorbed into it and could not be separated again. The rack is now closed
  to newcomers as soon as any substage is recorded, so a half-finished rack and a
  fresh one coexist. **Existing databases are repaired automatically on first
  open:** slides that were wrongly merged into an already-stained rack are moved
  back out into their own loading rack (one-time, idempotent, no schema change).
- **Stains can no longer be requested from an exhausted block (#70)** when there
  is no extra slide left to fulfil the request — that flag could never be
  cleared. A request an already-cut extra *can* satisfy is still allowed, since
  that slide physically exists regardless of the block being spent. Exhausted
  blocks are now labelled “— exhausted” in the Request-a-stain dialog and the
  request is refused there with the reason, instead of being accepted and then
  quietly going nowhere; the bench drawer shows the reason too.
- **Sample descriptions are editable (#79).** Click the pencil next to
  Description in the sample drawer. The edit is undoable like any other change.
- **Logs list a sample's slides alphabetically (#75)** — A, B, C… — in the table,
  the drill-down, and the CSV/Excel exports. Slide 27 (AA) sorts after Z rather
  than next to A.
- **Ready for Imaging can be filtered by project and by stain (#82).**
- **The active project is now obvious in the sidebar (#84).** The selected
  project gets a strong brand fill, a solid outline, a left accent bar, bold
  text and an **ACTIVE** badge, and the unselected ones are dimmed — so samples
  are much less likely to be created under the wrong project. Checked in the
  light, dark and matcha themes.
- **New “Matcha Tea” theme (#78).**

## 0.6.0 - 2026-07-27

Second issue batch — project moves, easier stain requests, exhaustion visibility,
and depth tagging.

- **Move a sample to a different project (#60).** The sample drawer has a Project
  dropdown; changing it re-numbers the sample under the new project and updates
  its slide labels to match.
- **Request a stain from the Logs view (#64).** Expand a sample and click
  “Request stain for …”. The request dialog opens with the sample already
  selected — and its Sample field is now a dropdown, so no more typing the code.
- **Block exhaustion is shown in the Logs (#65)** — an “Exhausted” badge on the
  sample’s stage — and in exports (#67, a new “Exhausted” column on the Samples
  and Logs exports).
- **Depth tagging (#69).** Select multiple slides in the Logs view and tag them
  as a depth grouping (e.g. “100µm deep”) with a note; the tag shows on each
  slide and is included in exports. **Schema change** (adds `depth_label` /
  `depth_note` to the slides table) — additive, so older data and backups keep
  loading; deploy this build to every workstation and viewer together.

## 0.5.1 - 2026-07-27

- **Tiles can be de-selected (#61).** Click a selected tile again (or un-tick its
  checkbox) to de-select it — and de-selecting now closes the detail panel
  instead of re-opening it.

## 0.5.0 - 2026-07-27

Issue sweep — stain requests, deparaffinization, and several UI fixes.

- **Stain requests now behave correctly (#41/#62/#66).** An embedded block's
  "needs stain" flag and the Send-for-Cutting prefill are driven by a proper
  *outstanding-requests* list: you can request the **same agent twice** (it
  queues two slides), and **re-requesting an agent that was already cut** flags
  the block again and prefills the dialog. Cutting a slide clears exactly the
  request it fulfils. **Existing databases are auto-translated on first open** (a
  one-time reconcile trims already-produced agents), and the change adds no new
  columns — it stays compatible with older builds and backups.
- **Deparaffinization removed (#59).** It was dropped as a tracked protocol step;
  the protocol is back to Stained/IHC → Coverslipped → Dried, and it no longer
  appears in timelines or exports. The database column is retained so older
  data/backups still load.
- **Needs-sectioning tiles show a compact tally (#63)** — e.g. "H&E · 3× Extra"
  instead of repeating "Extra" once per slide.
- **The app now shows its version (#68)** — at the bottom of the sidebar.
- **Undo/redo of the move into Ready for Imaging leaves no ghost tile (#31).**

## 0.4.9 - 2026-07-27

- **Automatic database backups.** The workstation now saves a full backup of the
  database every 3 hours during the working day (defaults to 07:00–19:00, Mon–Fri,
  keeping the newest 48 — all configurable), plus one on launch if a backup is
  overdue. Backups are robust: each is a consistent, checkpointed image, written
  atomically (temp file → flush → rename) and verified, so a crash can never leave
  a half-written backup.
- **Revert to a backup.** A new **Backups** button (next to Manage) opens a panel
  listing every backup with its time and size. “Back up now” takes one on demand;
  “Revert” restores the whole database to that point — and first takes a safety
  backup of the current state, so a revert is itself reversible.
- **Reverting an older backup is safe across updates.** Restoring a backup taken
  by an earlier build runs it through the schema-convergence guard, so any columns
  a newer version added are filled in automatically — no “missing column” errors.
- **Updates stay compatible with existing databases.** Documented and enforced the
  contract: migrations are additive only, and every column the app reads at runtime
  is converged on open. See `docs/shared_data_sync.md` §1a.

## 0.4.8 - 2026-07-26

- **Fixed: clicking the "Deparaffinized" protocol step did nothing** on databases
  that predate 0.4.7 (issue #58). The 0.4.7 schema change adds a column to the
  slides table, but the app swaps the SQLite file out from under itself at
  runtime — undo/redo restore a whole-file image and the sync viewer swaps in a
  downloaded snapshot — and re-opening the file does not re-run migrations. So an
  older image could go live under the new build, the step's write hit a missing
  column and threw, and the checkbox silently stayed unchecked. The app now
  additively converges that column on every database (re)open, and a failed
  protocol step surfaces the error instead of looking like a dead checkbox.

## 0.4.7 - 2026-07-26

- **Deparaffinization is now tracked.** It was a stage that appeared in the
  timelines and exports but was never actually recorded (always blank). It's now
  the first step of the stain/IHC protocol checklist, so it gets a real timestamp
  and shows in order (Deparaffinized → Stained → Coverslipped → Dried) on the
  slide/section/stack timelines and in the exports. **Schema change** (adds
  `stage_deparaffinized_at` to the slides table) — deploy this build to every
  workstation and viewer together (additive, so it's sync-safe).
- **Removed dead/redundant export columns.** The "Refrax" column was always an
  exact duplicate of "Coverslipped" (one step set both) and is dropped. The
  Samples sheet no longer lists slide-level stage columns (Stained, Imaged,
  Analyzed, …) that are never stamped on a block — those live in the Slides and
  Cut Orders sheets.

## 0.4.6 - 2026-07-26

Bug fixes from 0.4.5 testing (issues #55–#57):

- **Section drawer now lists every planned assay slide (#55).** A Needs-Sectioning
  card groups all of a sample's cut groups, but the drawer only showed the first
  group's single slide. It now shows the slides of all the grouped cut groups.
- **Undo after the staining→imaging scatter steps back one stage (#56).** The
  stain-protocol steps weren't recorded as undo snapshots, so undoing after the
  scatter jumped all the way back to Needs Sectioning. Each protocol step (and
  the scatter it triggers) is now undoable — one Undo returns slides to Staining.
- **A viewer stain request now actually drives the workflow (#57).** When the
  workstation drains a request it auto-actions it like a bench request: a block
  with an available extra pulls that extra straight into Staining and the request
  is auto-acknowledged; a block with no extra is flagged ⚑ needs stain with the
  cut prefilled. No manual technician step required for the movement.

## 0.4.5 - 2026-07-25

- **Viewer sync now reflects every workflow stage.** After a viewer pulled a
  snapshot, the app only refreshed a subset of views, so **stain racks, imaging
  stacks, and analyzed rows never appeared on a viewer** even though the data had
  synced. A pull swaps the whole database, so it now refreshes everything.
  Verified with a two-instance harness that walks a block through the entire
  pipeline (pre-processing → analyzed) and checks the viewer at each step.
- **A viewer's stain request is now a formal request.** Instead of only landing
  in the inbox, the workstation drains the request and raises the same request
  its own bench UI does — the block is flagged **⚑ needs stain** (or an existing
  extra is pulled into staining) and that flag streams back to the viewer. The
  viewer's request dialog now picks an agent from the catalog (so the request
  carries its stain/IHC type); an unknown block/agent still falls back to
  inbox-only.

## 0.4.4 - 2026-07-25

Logs rework (GitHub issues #44–#54):

- **Stage column now shows real progress.** Instead of the block's stage (which
  never advances past "Embedded"), each row shows the sample's pipeline phase
  (Pre-processing → Embedded → Sectioned → Staining → Imaging → Analyzed) with an
  `N/M analyzed` progress bar. (#44)
- **Stage filter** — a multi-select of those phases replaces the old
  Active/Analyzed toggle. (#45)
- **Sorting** — new "Updated" (last-activity) column, and the Stage sort now
  follows pipeline order instead of alphabetical. (#46)
- **Assay-type filter** (stain vs IHC) and a slide-count tooltip that breaks down
  assay vs extra slides. (#47)
- **Search** now also matches slide codes, notes, and project name. (#48)
- **Notes indicator** (📝) on rows that carry sample/slide notes. (#49)
- **Date-added range** filter. (#50)
- **Show only matching slides** toggle when a stain filter is active. (#51)
- **Summary bar** (samples / slides / analyzed counts for the current view). (#52)
- **Priority star** shown in the log. (#53)
- **Export to Excel (XLSX)** alongside CSV. (#54)

## 0.4.3 - 2026-07-25

- **Logs "Active" filter fixed.** Active/Analyzed now partition on slide state: a
  sample is *Analyzed* once every one of its assay slides is analyzed (extras are
  ignored, since they never get an analyzed stamp) and *Active* otherwise — so a
  half-finished sample correctly reads as Active.
- **Export the Logs as CSV.** A new "Export CSV" button downloads exactly what's
  on screen (current filter + sort), one row per slide with its sample context
  and timeline stamps (Cut / Stained / Coverslipped / Imaged / Analyzed) plus
  slide and sample notes; slide-less samples still get a row.

## 0.4.2 - 2026-07-25

- **Stack timeline no longer loses the pre-imaging stamps.** When a stain rack
  advances to Ready for Imaging it scatters into a per-sample imaging stack, and
  the new aggregate stack row was only stamped with the imaging stage — so the
  drawer's Stack timeline showed Stained / Coverslipped / Dried as blank even
  though they had happened. The timeline now derives each step from the stack's
  slides (which keep their own stamps through the scatter), falling back to the
  stack row only for stack-only markers like IHC Complete.
- **Logs "Analyzed" filter now works.** It filtered on the block's stage, but a
  block never reaches the analyzed stage — only its slides do. The filter now
  matches samples that have any analyzed slide (and "Active" is the complement).

## 0.4.1 - 2026-07-25

The 0.4.0 tag never produced an installer — its CI build failed at
`pnpm install --frozen-lockfile` because four dev dependencies added for the
Playwright harness (`@playwright/test`, `playwright`, `sql.js`, `@types/sql.js`)
were only written to `package-lock.json`, not `pnpm-lock.yaml`. 0.4.1 syncs the
pnpm lockfile so the release actually builds, and folds in everything intended
for 0.4.0:

- **Image-based undo/redo**: undo now reverts to a previous whole-file SQLite
  image (WAL-checkpointed), and the UI is a pure reflection of the DB. History
  survives reloads (persisted to IndexedDB) and undo never signs you out.
- **Manage dialog**: a tabbed dialog to manage users, projects, and the
  stain/IHC catalog (add / rename / deactivate / delete, where delete is blocked
  when the item is still referenced so prior slide assignments are never lost).
- **Logs page**: a spreadsheet of every sample with filters (project / stain /
  status), sorting, stain search, and per-sample slide drill-down.
- **Separate sample & slide timelines** in the Logs, rendered as even,
  tab-separated columns; the slide timeline is condensed to
  Cut / Stained / Coverslipped / Imaged. Slides are now stamped with a local
  `stage_cut_at` at cut time so "Cut" no longer displays in UTC.
- **Notes** on each sample and each slide, editable from the Logs and undoable.
- **Sectioning rework**: fulfilled plans are archived and cleared on cut (a fresh
  Send-for-Cutting always starts a wholly new plan), and a multi-block cut uses a
  per-block navigator so each block is cut by its own plan.

## 0.3.6 - 2026-07-25

- **Fixed undo/redo corrupting the database** (critical regression in 0.3.5).
  0.3.5's undo copied the raw SQLite *file*, but the app runs in WAL mode, so the
  file snapshot was missing the latest writes (they were still in the `-wal`
  sidecar) — restoring it corrupted the database. Undo/redo now snapshot the
  **logical contents** of every workflow table through the normal connection
  (WAL-safe) and restore them in foreign-key order. No file I/O, no Tauri
  commands, no reopen: undo swaps the DB back, the UI refetches, done. Backed by
  a round-trip regression test (snapshot → destructive churn incl. a cascade
  delete → restore → exact match, with foreign keys enforced).

## 0.3.5 - 2026-07-25

- **Undo/redo reworked to whole-database snapshots** (issue #31, and the class
  behind #29): every action now snapshots the entire SQLite database before its
  write, and undo/redo restore that snapshot wholesale — the UI just refetches.
  This removes the fragile per-row restore logic that could leave ghost tiles
  (e.g. a lingering "needs imaging" tile) or fail to redo. The DB is the single
  source of truth; undo/redo simply move it back or forward.
- **Run planning is now discoverable** (issues #4, #24): the planned-run feature
  worked but was buried behind "Move to Processor" plus an easy-to-miss tab. The
  entry point now reads **"Start / Plan Run"**, so scheduling a future run (with
  its PLANNED FOR tag and confirm-start step) is actually reachable.
- **"Mark Sectioned" counts slides, not stain types** (issue #40): the button
  now shows the number of slides being cut.
- **Requested stains re-flag the block per stain** (issue #41): asking for a new
  stain when no extra is free flags the embedded block for a fresh cut even after
  earlier stains are already in staining, and the Send for Cutting dialog
  prefills the outstanding requested stains.
- **Added a real UI test layer** (vitest + React Testing Library): the actual
  React components are now rendered and asserted in tests (`pnpm test:ui`),
  alongside the existing data-layer harness — so render/interaction regressions
  can no longer pass a type-check unnoticed.

## 0.3.4 - 2026-07-24

- **Sectioning reworked around a "Send for Cutting" step** (issues #35, #36): the
  old editable "sectioning plan" is replaced by a Send for Cutting dialog that
  asks only how many slides to cut and which carry a stain. Pre-selected stains
  prefill it for a one-click send, and the misleading persistent "N slides
  planned" tag is gone from the embedded tile.
- **Pre-assigned slides skip slide assignment** (issues #34, #38): a cut whose
  slides are already assigned goes straight from Needs Sectioning to Staining
  (stains) and Extras (extras) — there is no separate assignment stop. The former
  "Assign Slides" column is now the Extras inventory.
- **Needs Sectioning groups by sample** (issue #33): each sample shows a single
  card aggregating its not-yet-sectioned cut groups, and multi-select /
  select-all work there (issue #37).
- **Requesting a stain now moves the slide into Staining** (issue #39): pulling a
  stain from an available extra sends that slide straight into the staining rack
  instead of leaving it in limbo; it leaves the Extras inventory and appears in
  the Staining lane immediately.
- **Concurrent processor runs, no prompt** (issue #23): starting a second run
  while one is active just works — the "processor busy / Start anyway" override
  prompt is removed entirely.
- **Editable planned-run sample list** (issue #32): a planned run's samples can
  be added or removed from its drawer until it is confirmed.
- Fixed undo/redo of a move into Ready for Imaging leaving a ghost "needs
  imaging" tile behind; the scattered per-sample stacks are now cleaned up on
  undo and recreated on redo (issue #31).
- Verified and locked in the planned processing-run lifecycle end to end with
  new regression gates (issues #4, #24).

## 0.3.3 - 2026-07-24

- **Schema change — every workstation and viewer must update to 0.3.3 together.**
  Migrations 0018/0019 remove section depth and reshape slide stacks (destructive
  for depth data).
- **Removed section depth entirely** (issue #5): the workflow no longer tracks
  cut depth. Slide codes are now per-sample letters (EE-0001-A, -B, …).
- **Cross-sample staining racks**: during staining, slides of the same agent
  group into one cross-sample "rack" that moves through the reagents together
  and never merges with a later rack; leaving staining, slides scatter back into
  their own sample's imaging stack. Staining tiles now show the agent and how
  many samples are in the rack — the groundwork for per-protocol timers.
- **Stains chosen at sample creation** (issue #1): the New Sample screen has a
  checkbox list of the agent catalog. A "needs stain" flag sits on the block
  until each chosen stain enters staining.
- **Auto-planned blocks** (issues #3, #4): a newly embedded block auto-fills its
  sectioning plan — one preassigned slide per chosen stain plus enough extras to
  reach at least four slides with two extras — with assignments pre-saved, so a
  flagged block is a one-click Send to Sectioning → Start Assays. Dialogs still
  open (prefilled, with a "preselected" note) for review.
- **Request a stain** (issue #2): requesting a stain for a sample (from the
  catalog) pulls it from an available extra slide first, or flags the block for
  a fresh cut if none is free.

## 0.3.2 - 2026-07-24

- **Schema change — every workstation and viewer must update to 0.3.2 together.**
  Migration 0017 adds a planned processing-run lifecycle (additive, sync-safe).
- Added planned processing runs: a run can be scheduled for a future start and
  its tile now reads "PLANNED FOR HH:MM · <weekday>" instead of counting up a
  misleading timer. At the planned time the technician confirms the actual start,
  which stamps the real start, computes the ready time, and begins the countdown
  (#4, #24).
- Starting a processor run while another is already active is no longer blocked:
  the batch-start dialog warns and lets the technician start a second run
  simultaneously if they choose (#23).
- Made the processing-batch start time editable from an always-visible "Edit
  start time" button in the batch drawer instead of a hover-only pencil (#30).
- Undoing "start assay workflow" now also removes the slide stack the transition
  created, so tiles no longer linger in the assay stage after the fresh slides
  return (#29).
- Locked in, with a regression test, that a separately-stained extra reaching
  Ready for Imaging merges onto the companion stack so every slide gets its own
  imaging checkbox — the durable-stack rework already made this correct (#14).

## 0.3.1 - 2026-07-18

- Corrected downstream stack identity to sample + physical cut depth + current
  stage. Fresh staining work can no longer pull a companion stack backward
  from imaging, and different cut depths can never share a stack.
- Added forward-arrival merging: companion stacks merge only when the newer
  stack reaches the same stage as an existing sample-depth stack.
- Added migration repair for mixed-depth or mixed-stage stacks created by
  0.3.0, preserving the most advanced group's stack identity.
- Kept multi-stack protocol checklists while filtering stain and IHC batch
  updates to selected stacks that actually contain the matching assay type.

## 0.3.0 - 2026-07-18

- Added durable slide stacks as the owner of downstream staining, imaging, and
  analysis state. Slides retain their cut-group provenance and copied depth.
- Replaced render-time downstream section grouping with stack cards, stack
  selection, a stack drawer, stack-scoped protocols, and stack-level actions.
- Added combined, undoable deletion for selected stacks and selected slides.
- Made section and imaging undo restore slide snapshots, and made batch section
  completion, assay start, and delete act on the complete validated selection
  (#26, #27, #28).
- Rejected backward and skipped drag transitions (#25).
- Reworked the processor pickup indicator into a theme-aware edges-only warning
  treatment (#19).
- Added sample/stack audit context plus explicit undo and redo events as the
  reporting foundation for the future Log and Manifest pages.

## 0.2.6 - 2026-07-18

- Board relayout: the Processor Pickup column is gone; the single Processor
  window now holds both the running run and the run awaiting pickup (flagged by
  its amber tile glow), and Embedded Inventory moved up to the top row — four
  windows on top, four on the bottom (#5, #18).
- The imaging checklist now shows a checkbox for every stain/IHC slide across a
  sample's grouped Ready-for-Imaging sections, so a separately-stained extra is
  no longer missing its checkbox (#14).
- A sectioning plan can now be sent to several selected embedded blocks at once
  as a single action (#8).

## 0.2.5 - 2026-07-18

- Fresh slides saved as "Extra" during assignment no longer appear in the Extra
  inventory until their cut group leaves the Fresh tab (#12).
- The assignment button now reads "Start Assays / Move to Extras" (or "Move to
  Extras" for an all-extras stack), matching what the action actually does (#13).
- Clicking an extras stack in the inventory now highlights it and clears any
  other selection (#15).
- Moving several sections at once now undoes as a single action instead of one
  slide at a time (#16).
- Selecting a processing batch now highlights that batch and clears other
  highlighted tiles (#17).
- A processing batch awaiting pickup now has a clear amber glow (#19).

## 0.2.4 - 2026-07-18

- Fixed a regression from 0.2.3 where the processor could refuse to start any
  batch at all. The one-run-at-a-time guard now judges "busy" from actual
  sample state (samples in the processor) rather than the batch status column,
  which could go stale/orphaned and wedge the processor (#5).
- The processor start-time editor is now available while a batch is awaiting
  pickup too, not only while actively processing, so a misinput can still be
  corrected after the run finishes (#6).

## 0.2.3 - 2026-07-18

- The processor now runs one batch at a time: starting a run that would overlap
  a batch still processing is rejected (a run planned to begin after the current
  one finishes is still allowed) (#5).
- Processing batch start times can be corrected from the batch drawer; the
  expected-ready time and each sample's start stamp recompute automatically,
  and the change is undoable (#6).
- Staining an extra slide now joins the block's existing open stain/IHC section
  instead of spawning a separate one, so companion slides stay together through
  imaging (#9).
- Assigning an extra slide no longer leaves an orphaned, empty section behind,
  and the assignment is now undoable — fixing extras disappearing from the
  inventory on undo (#10).

## 0.2.2 - 2026-07-17

- Default the New Sample fixative to Z-Fix, the most frequently used agent (#2).
- Removed the mandatory processor-load checklist from the batch-start dialog,
  which the technician can't act on while at the processor (#3).
- Added a Quantity field to New Sample so multiple samples with identical
  details can be created at once, each with its own ID, as a single undo (#1).
- Blocked sending a block to sectioning until it reaches Embedded Inventory,
  both in the sectioning dialog and at the data layer (#7).

## 0.2.1 - 2026-07-17

- Fixed a sync failure on the workstation ("TypeError: c.arrayBuffer is not a function") caused by calling the wrong write-excel-file API when building the status workbook. The same fix corrects the manual Excel workbook export.

## 0.2.0 - 2026-07-17

- Added shared data sync: a workstation publishes a database snapshot + status workbook to a private GitHub repo, and viewer installs pull it read-only.
- Added viewer "Request stain" flow with a workstation requests inbox; fulfilling a matching stain auto-acknowledges the request.
- Added single-writer safeguard so only one install can be the authoritative workstation (setup defaults to Viewer).
- Added first-run setup screen and per-install sync configuration (access token stored locally, never in the database or repo).
- Added cloud-built Windows installer via GitHub Actions.

## 0.1.1 - 2026-07-15

- Fixed decalcification workflow ordering so decalc happens after fixation and before ethanol.
- Fixed preprocessing checklist behavior for samples that need decalcification.
- Added grouped extra-slide inventory tiles with filtering, sorting, and right-drawer stain/IHC assignment.
- Added resizable right-side drawers and adjustable board row heights for smaller laptop screens.
- Added per-slide imaging checklists once sections are ready for imaging.
- Added batch completion support for staining, imaging, and analysis workflows.
- Updated downstream staining/IHC tiles so reassigned extra slides stay grouped by sample.
- Improved embedded inventory tile text so saved sectioning plans are visible before sectioning is completed.
