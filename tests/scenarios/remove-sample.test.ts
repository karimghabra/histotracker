// #159: a whole sample can be removed from the Logs. On the real db.ts, on a real SQLite file.
//
// The Logs' Remove is the board's soft removal (#96): the rows stay, the sample is flagged
// removed, and the reason and the user land on the sample's timeline. These scenarios walk the
// outcomes a lab depends on: nothing deleted, one audit record per removal, undo brings it back,
// nobody signed in changes nothing, and the Logs refuse a block still in a processing run
// while the board's Delete removes it as before.
import { afterEach, describe, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

const stageOf = (l: Lab, id: number) => l.rows(`SELECT current_stage FROM samples WHERE id = ?`, [id])[0].current_stage;
const removalEvents = (l: Lab, id: number) =>
  l.rows(`SELECT user_id, summary, details FROM sample_timeline_events WHERE sample_id = ? AND event_type = 'sample_removed'`, [id]);

async function cutBlock(l: Lab, description: string, duplicates = 2): Promise<{ block: number; group: number }> {
  const block = await l.sample(description);
  const [group] = await l.db.createSectionRequests(block, [
    { duplicates, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
  ]);
  return { block, group };
}

describe("#159: removing a sample", () => {
  it("flags it removed, keeps every row, and records who removed it and why", async () => {
    lab = await openLab();
    const { block, group } = await cutBlock(lab, "wrong animal");
    const slides = lab.rows(`SELECT id FROM slides WHERE section_request_id = ?`, [group]);
    expect(slides).toHaveLength(2);
    const user = (await lab.db.getActiveUser()).id;

    await lab.db.removeSamples([block], "  logged against the wrong animal ");

    expect(stageOf(lab, block)).toBe("removed");
    expect(lab.rows(`SELECT current_stage FROM section_requests WHERE id = ?`, [group])[0].current_stage).toBe("removed");
    for (const s of slides) {
      expect(lab.rows(`SELECT current_stage FROM slides WHERE id = ?`, [s.id])[0].current_stage, "the glass is flagged, never deleted").toBe("removed");
    }
    const events = removalEvents(lab, block);
    expect(events, "one removal, one audit record").toHaveLength(1);
    expect(events[0].user_id).toBe(user);
    expect(JSON.parse(events[0].details).reason).toBe("logged against the wrong animal");

    // The Logs read it back the way they show it: the reason, the person and the time.
    const removals = (await lab.db.listSampleRemovals()) as Array<{ sample_id: number; reason: string; user_name: string | null }>;
    expect(removals.find((r) => r.sample_id === block)).toMatchObject({ reason: "logged against the wrong animal" });
    const listed = ((await lab.db.listAllSamples()) as Array<{ id: number }>).map((s) => s.id);
    expect(listed, "the removed sample still comes back from the Logs' query").toContain(block);
  });

  it("records the removal once however many times it is asked for", async () => {
    lab = await openLab();
    const block = await lab.sample("double click");
    await lab.db.removeSamples([block], "first");
    await lab.db.removeSamples([block], "second");
    await lab.db.removeSample(block, "third");
    expect(removalEvents(lab, block)).toHaveLength(1);
  });

  it("removes glass at any stage, as removing a slide always has", async () => {
    lab = await openLab();
    const { block, group } = await cutBlock(lab, "already analyzed", 1);
    await lab.db.updateSectionStage(group, "analyzed");
    await lab.db.removeSamples([block], "entered in error");
    expect(stageOf(lab, block)).toBe("removed");
    expect(lab.rows(`SELECT current_stage FROM slides WHERE section_request_id = ?`, [group])[0].current_stage).toBe("removed");
  });

  it("is brought back by undo, which restores the sample and its glass exactly", async () => {
    lab = await openLab();
    const { block, group } = await cutBlock(lab, "undo me");
    const before = await lab.db.snapshotDb();
    await lab.db.removeSamples([block], "oops");
    expect(stageOf(lab, block)).toBe("removed");

    await lab.db.restoreDbPreservingSession(before);

    expect(stageOf(lab, block)).toBe("embedded");
    expect(removalEvents(lab, block)).toHaveLength(0);
    expect(lab.rows(`SELECT current_stage FROM slides WHERE section_request_id = ?`, [group]).every((s) => s.current_stage !== "removed")).toBe(true);
  });

  it("is refused with nobody signed in, and changes nothing", async () => {
    lab = await openLab();
    const { block } = await cutBlock(lab, "signed out");
    await lab.db.setActiveUser(null);
    lab.db.setSignedOutReadOnly(true);

    await expect(lab.db.removeSamples([block], "no one home")).rejects.toThrow("Sign in before making modifications.");

    expect(stageOf(lab, block)).toBe("embedded");
    expect(removalEvents(lab, block)).toHaveLength(0);
    expect(lab.rows(`SELECT id FROM slides WHERE current_stage = 'removed'`)).toHaveLength(0);
  });

  it("is refused from the Logs while the sample is in a processing run, and the refusal touches no sample", async () => {
    lab = await openLab();
    const inRun = await lab.sample("in a run", "in_ethanol");
    const free = await lab.sample("not in a run", "in_ethanol");
    await lab.db.planProcessingBatch({
      sampleIds: [inRun],
      processingType: "Short",
      operatorName: "Tech",
      plannedStartAt: "2030-01-01 08:00",
    });

    await expect(lab.db.removeSamples([free, inRun], "cleanup", { refuseInProcessingRun: true })).rejects.toThrow(/still in a processing run/);

    expect(stageOf(lab, inRun)).toBe("in_ethanol");
    expect(stageOf(lab, free), "all or nothing").toBe("in_ethanol");
    expect(removalEvents(lab, free)).toHaveLength(0);
  });

  it("is allowed again once the sample is taken out of the run", async () => {
    lab = await openLab();
    const inRun = await lab.sample("in a run", "in_ethanol");
    const other = await lab.sample("stays", "in_ethanol");
    const batch = await lab.db.planProcessingBatch({
      sampleIds: [inRun, other],
      processingType: "Short",
      operatorName: "Tech",
      plannedStartAt: "2030-01-01 08:00",
    });
    await lab.db.updateBatchMembers(batch, [other]);
    await lab.db.removeSamples([inRun], "wrong block", { refuseInProcessingRun: true });
    expect(stageOf(lab, inRun)).toBe("removed");
  });

  it("from the board's Delete still removes a block in a processing run, as it always has", async () => {
    lab = await openLab();
    const inRun = await lab.sample("in a run", "in_ethanol");
    await lab.db.planProcessingBatch({
      sampleIds: [inRun],
      processingType: "Short",
      operatorName: "Tech",
      plannedStartAt: "2030-01-01 08:00",
    });

    await lab.db.removeSamples([inRun], "wrong block");

    expect(stageOf(lab, inRun)).toBe("removed");
    expect(removalEvents(lab, inRun)).toHaveLength(1);
  });
});
