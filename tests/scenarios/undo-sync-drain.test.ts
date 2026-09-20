// A write the technician did not make, landing while they undo (ht-undo-snapshot-on-write-path).
//
// A workstation drains a viewer's stain request on a timer, and Settings writes the assay
// catalogue; neither is an action and neither is on the undo stack. An undo entry is one closed
// range of the journal, its own action's rows and nothing else, so such a write is outside every
// entry: an Undo that does not touch its rows leaves it alone, and one that would restore a whole
// row over it is refused with nothing changed. Through the real useActions, on the real db.ts and
// githubSync.ts, against a real SQLite file and the shared fake remote.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";
import { world } from "../compat/world";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let lab: Lab | null = null;
afterEach(async () => {
  world().remote.files.clear(); // the fake remote outlives a lab
  world().remote.assets.clear();
  await lab?.close();
  lab = null;
});

type Row = Record<string, unknown>;

const block = (l: Lab, id?: number): Row =>
  id === undefined ? l.rows(`SELECT * FROM samples`)[0] : l.rows(`SELECT * FROM samples WHERE id = ?`, [id])[0];
const requests = (l: Lab): Row[] => l.rows(`SELECT uuid, status FROM stain_requests`);
const assays = (l: Lab): Row[] => l.rows(`SELECT id, assay_type, name FROM assay_catalog ORDER BY id`);

/** What the New Sample dialog hands to createSamples. */
const newSampleInput = (projectId: number, description: string) => ({
  project_id: projectId,
  sample_description: description,
  processing_type: "Short",
  fixative_agent: "Z-Fix",
  needs_decalcification: false,
  cut_notes: "",
  slide_notes: "",
  embedding_notes: "",
  stains: "",
  preselected_stains: [],
  overall_notes: "",
});

/** A viewer asks for a stain on `id`, which lands in the inbox and nowhere else yet. */
async function requestAStainOn(l: Lab, id: number): Promise<void> {
  await l.app.sync.submitRequest({
    sampleCode: l.rows(`SELECT sample_code FROM samples WHERE id = ?`, [id])[0].sample_code as string,
    requestedAssay: "H&E",
    assayType: "stain",
    requesterName: "Viewer V",
  });
}

async function blockWithARequestWaiting(l: Lab): Promise<number> {
  const id = await l.sample("DESC-0", "embedded");
  await requestAStainOn(l, id);
  return id;
}

/**
 * The app's own actions, bound to the db.ts this lab opened: one render is enough to take them
 * out, and they are closures over the real data layer. Imported after the launch, as undo-lane
 * does, so the hook binds to that instance.
 */
async function appActions(): Promise<Any> {
  const { useActions } = await import("../../src/hooks/useActions");
  let actions: Any;
  const Probe = () => ((actions = useActions()), null);
  renderToString(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)));
  return actions;
}

/** The message a replay is refused with, or null if it was applied. */
async function replay(l: Lab, from: number, to: number): Promise<string | null> {
  return await l.db.revertJournalRange(from, to).then(
    () => null,
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

/** What the technician is shown when a step will not replay, or null if it did. */
async function pressed(step: Promise<string | null>): Promise<string | null> {
  return await step.then(
    () => null,
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

it("a request drained between an undo and its redo is refused by the redo, not half applied", async () => {
  lab = await openLab();
  const l = lab;
  const id = await blockWithARequestWaiting(l);

  // The technician renames the block, then takes it back. The entry is the range
  // the rename wrote, closed at its own end, as commit() records it.
  const mark: number = await l.db.journalHead();
  await l.db.setSampleDescription(id, "DESC-B");
  const end: number = await l.db.journalHead();
  const redo: { from: number; to: number } = await l.db.revertJournalRange(mark, end);
  expect(block(l).sample_description).toBe("DESC-0");

  // The sync timer drains the waiting request, which flags the SAME block.
  expect((await l.app.sync.drainRequests()).ingested).toBe(1);
  const drained = block(l);
  expect(drained.preselected_stains).toContain("H&E");
  expect(requests(l)).toHaveLength(1);

  // Redo would put the block's row back as the rename left it — before the drain.
  const refusal = await replay(l, redo.from, redo.to);

  expect(block(l), "the drain's flag is still on the block").toEqual(drained);
  expect(requests(l), "and its request is still recorded").toHaveLength(1);
  expect(String(refusal), "the redo is refused, in words the technician is shown").toMatch(/changed since/);
});

it("an undo of an action taken before the drain still reverts, and leaves the drain alone", async () => {
  lab = await openLab();
  const l = lab;
  const id = await blockWithARequestWaiting(l);
  expect((await l.app.sync.drainRequests()).ingested).toBe(1);
  const flagged = block(l).preselected_stains;

  const mark: number = await l.db.journalHead();
  await l.db.setSampleDescription(id, "DESC-B");
  await l.db.revertJournalRange(mark, await l.db.journalHead());

  expect(block(l).sample_description).toBe("DESC-0");
  expect(block(l).preselected_stains, "the drain came first, so it is not part of this undo").toBe(flagged);
});

it("ingesting a request waits for the write lane instead of writing inside somebody else's action", async () => {
  lab = await openLab();
  const l = lab;
  await blockWithARequestWaiting(l);
  // Imported after the lab has launched, so it is the lane githubSync.ts is using.
  const { inLane } = await import("../../src/lib/writeLane");

  let release!: () => void;
  const held = inLane(() => new Promise<void>((resolve) => (release = resolve)));
  const draining = l.app.sync.drainRequests();
  await new Promise((resolve) => setTimeout(resolve, 25));

  expect(requests(l), "nothing was written while the lane was held").toEqual([]);
  expect(block(l).preselected_stains).not.toContain("H&E");

  release();
  await held;
  expect((await draining).ingested).toBe(1);
  expect(requests(l)).toHaveLength(1);
});

it("an undo leaves a request the sync timer drained alongside it alone", async () => {
  lab = await openLab();
  const l = lab;
  const edited = await l.sample("DESC-0", "embedded");
  const requested = await l.sample("OTHER", "embedded");
  await requestAStainOn(l, requested);
  const actions = await appActions();

  // The technician edits one block; the timer then drains a request for the other.
  await actions.editSampleDescription(edited, "DESC-B");
  expect((await l.app.sync.drainRequests()).ingested).toBe(1);
  const flagged = block(l, requested);
  expect(flagged.preselected_stains).toContain("H&E");

  expect(await actions.undo()).toBe("Edit EE-1 description");

  expect(block(l, edited).sample_description, "the edit is taken back").toBe("DESC-0");
  expect(block(l, requested), "the drained request's block is untouched").toEqual(flagged);
  expect(requests(l), "and the request is still on the record").toHaveLength(1);
});

it("an undo leaves an assay added in Settings meanwhile alone", async () => {
  lab = await openLab();
  const l = lab;
  const id = await l.sample("DESC-0", "embedded");
  const actions = await appActions();

  await actions.editSampleDescription(id, "DESC-B");
  await l.db.addAssay({ assay_type: "stain", name: "Trichrome" }); // what the Settings dialog writes
  const catalogue = assays(l);
  expect(catalogue.map((a) => a.name)).toContain("Trichrome");

  expect(await actions.undo()).toBe("Edit EE-1 description");

  expect(block(l, id).sample_description, "the edit is taken back").toBe("DESC-0");
  expect(assays(l), "the assay Settings added survives the undo").toEqual(catalogue);
});

it("an undo the drain has overtaken is skipped, and the next undo reaches the step before it", async () => {
  lab = await openLab();
  const l = lab;
  const first = await l.sample("FIRST-0", "embedded");
  const overtaken = await blockWithARequestWaiting(l);
  const actions = await appActions();

  await actions.editSampleDescription(first, "FIRST-B");
  await actions.editSampleDescription(overtaken, "DESC-B");
  // The timer flags the very row the newest edit would put back.
  expect((await l.app.sync.drainRequests()).ingested).toBe(1);
  const drained = block(l, overtaken);
  expect(drained.preselected_stains).toContain("H&E");

  const refusal = await pressed(actions.undo());
  expect(block(l, overtaken), "nothing was changed").toEqual(drained);

  // Not wedged: the next Undo reaches the step before the one it could not take back.
  expect(await actions.undo()).toBe("Edit EE-1 description");
  expect(block(l, first).sample_description).toBe("FIRST-0");
  expect(block(l, overtaken), "still untouched").toEqual(drained);
  expect(String(refusal), "said in one plain sentence").toMatch(/^Could not undo "Edit EE-2 description": .*has been skipped\.$/);
});

it("a redo the drain has overtaken is skipped, and is not offered again", async () => {
  lab = await openLab();
  const l = lab;
  const id = await blockWithARequestWaiting(l);
  const actions = await appActions();

  await actions.editSampleDescription(id, "DESC-B");
  expect(await actions.undo()).toBe("Edit EE-1 description");
  expect((await l.app.sync.drainRequests()).ingested).toBe(1);
  const drained = block(l, id);

  const refusal = await pressed(actions.redo());
  expect(block(l, id), "nothing was changed").toEqual(drained);

  expect(await actions.redo(), "the step that cannot run is no longer offered").toBeNull();
  expect(String(refusal)).toMatch(/^Could not redo "Edit EE-1 description": .*has been skipped\.$/);
});

it("a redo whose row has had its code taken is skipped too, and is not offered again", async () => {
  lab = await openLab();
  const l = lab;
  const actions = await appActions();
  const project = l.rows(`SELECT id FROM projects WHERE code = 'EE'`)[0].id as number;

  await actions.createSamples(newSampleInput(project, "FIRST"), "EE", 1);
  const created = block(l);
  expect(await actions.undo()).toBe("Create sample");
  expect(l.rows(`SELECT id FROM samples`), "the block is gone").toHaveLength(0);

  // Somebody enters a block by hand, and it takes the code the undone one had.
  await l.db.addSample(newSampleInput(project, "SECOND"), "EE");
  const entered = block(l);
  expect(entered.sample_code).toBe(created.sample_code);

  // Putting the first block back is impossible, not merely awkward: its code is taken.
  const refusal = await pressed(actions.redo());

  expect(block(l), "nothing was changed").toEqual(entered);
  expect(await actions.redo(), "the step that cannot run is no longer offered").toBeNull();
  expect(String(refusal)).toMatch(/^Could not redo "Create sample": .*has been skipped\.$/);
});

it("a replay that fails for any other reason keeps its step, and says to try again", async () => {
  lab = await openLab();
  const l = lab;
  const id = await l.sample("DESC-0", "embedded");
  const actions = await appActions();

  const mark: number = await l.db.journalHead();
  await actions.editSampleDescription(id, "DESC-B");
  // A journal row that cannot run at all. Nothing has taken anything's place, so
  // this is not a refusal: it may well work next time.
  const db = await l.db.getDb();
  await db.execute(`UPDATE undo_journal SET stmt = 'UPDATE no_such_table SET x = 1' WHERE seq = ?`, [mark + 1]);

  const refusal = await pressed(actions.undo());

  expect(block(l).sample_description, "nothing was changed").toBe("DESC-B");
  expect(String(refusal)).toMatch(/^Could not undo "Edit EE-1 description" just now: .*you can try again\.$/);
  // The step is still there, so pressing Undo again meets the same step, not the one before it.
  expect(String(await pressed(actions.undo()))).toMatch(/^Could not undo "Edit EE-1 description" just now: /);
});

it("an undo the drain refuses leaves the redo of an untouched step still there", async () => {
  lab = await openLab();
  const l = lab;
  const overtaken = await blockWithARequestWaiting(l);
  const other = await l.sample("OTHER-0", "embedded");
  const actions = await appActions();

  await actions.editSampleDescription(overtaken, "DESC-B");
  await actions.editSampleDescription(other, "OTHER-B");

  // Take back the newer edit. Its redo is on the stack now.
  expect(await actions.undo()).toBe("Edit EE-2 description");
  expect(block(l, other).sample_description).toBe("OTHER-0");

  // The timer flags the block the OLDER edit touched, so that step can never replay.
  expect((await l.app.sync.drainRequests()).ingested).toBe(1);
  const refusal = await pressed(actions.undo());
  expect(String(refusal)).toMatch(/^Could not undo "Edit EE-1 description": .*has been skipped\.$/);

  // That refusal wrote nothing, so the step it did not touch is still there to put back.
  expect(await actions.redo(), "the untouched step can still be redone").toBe("Edit EE-2 description");
  expect(block(l, other).sample_description, "and it is back").toBe("OTHER-B");
});
