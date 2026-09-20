// The sync timer writes while the technician is undoing (ht-undo-snapshot-on-write-path).
//
// A workstation drains a viewer's stain request on a timer, so that write can land at any
// moment — including between an Undo and the Redo of it. A redo replays one closed range of
// the journal, and every inverse in it restores a WHOLE row, so a drain that touched the same
// block would be half erased: the block's request flag gone, the stain_requests row it belongs
// to left behind, and the inbox file already deleted from GitHub. On the real db.ts and
// githubSync.ts, a real SQLite file and the shared fake remote.
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";
import { world } from "../compat/world";

let lab: Lab | null = null;
afterEach(async () => {
  world().remote.files.clear(); // the fake remote outlives a lab
  world().remote.assets.clear();
  await lab?.close();
  lab = null;
});

type Row = Record<string, unknown>;

const block = (l: Lab): Row => l.rows(`SELECT * FROM samples`)[0];
const requests = (l: Lab): Row[] => l.rows(`SELECT uuid, status FROM stain_requests`);

async function blockWithARequestWaiting(l: Lab): Promise<number> {
  const id = await l.sample("DESC-0", "embedded");
  await l.app.sync.submitRequest({
    sampleCode: l.rows(`SELECT sample_code FROM samples WHERE id = ?`, [id])[0].sample_code as string,
    requestedAssay: "H&E",
    assayType: "stain",
    requesterName: "Viewer V",
  });
  return id;
}

/** The message a replay is refused with, or null if it was applied. */
async function replay(l: Lab, from: number, to?: number): Promise<string | null> {
  return await l.db.revertJournalRange(from, to).then(
    () => null,
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

it("a request drained between an undo and its redo is refused by the redo, not half applied", async () => {
  lab = await openLab();
  const l = lab;
  const id = await blockWithARequestWaiting(l);

  // The technician renames the block, then takes it back.
  const mark: number = await l.db.journalHead();
  await l.db.setSampleDescription(id, "DESC-B");
  const redo: { from: number; to: number } = await l.db.revertJournalRange(mark);
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
  await l.db.revertJournalRange(mark);

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
