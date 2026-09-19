// #159: a whole sample can be removed from the Logs. On the real db.ts, on a real SQLite file.
//
// The Logs' Remove is the board's soft removal (#96): the rows stay, the sample is flagged
// removed, and the reason and the user land on the sample's timeline. These scenarios walk the
// outcomes a lab depends on: nothing deleted, one audit record per removal, undo brings it back,
// and nobody signed in changes nothing. A block in a processing run leaves the run as it is
// removed, from the board or from the Logs.
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
});

describe("a deleted block leaves its processing run", () => {
  const planRun = (l: Lab, sampleIds: number[]) =>
    l.db.planProcessingBatch({ sampleIds, processingType: "Short", operatorName: "Tech", plannedStartAt: "2030-01-01 08:00" });
  const startRun = (l: Lab, sampleIds: number[], startedAt = "2030-01-01 08:00") =>
    l.db.startProcessingBatch({
      sampleIds,
      processingType: "Short",
      operatorName: "Tech",
      startedAt,
      checklistLabels: ["Loaded"],
    });
  const members = (l: Lab, batch: number) =>
    l.rows(`SELECT sample_id FROM processing_batch_members WHERE batch_id = ? ORDER BY sample_id`, [batch]).map((r) => r.sample_id);
  const detachEvents = (l: Lab, id: number) =>
    l.rows(`SELECT user_id, action, entity_type, entity_id, summary, details FROM audit_events WHERE sample_id = ? AND entity_type = 'processing_batch'`, [id]);

  it("stays removed when the run it was in is advanced to Pickup and then to Needs Embedding", async () => {
    lab = await openLab();
    const gone = await lab.sample("deleted in a run", "in_ethanol");
    const stays = await lab.sample("stays in the run", "in_ethanol");
    const batch = await planRun(lab, [gone, stays]);

    await lab.db.removeSamples([gone], "wrong block");
    await lab.db.moveProcessingBatch(batch, "processed");
    expect(stageOf(lab, gone), "advancing the run must not bring the block back").toBe("removed");
    expect(stageOf(lab, stays)).toBe("processed");
    await lab.db.moveProcessingBatch(batch, "needs_embedding");
    expect(stageOf(lab, gone)).toBe("removed");
    expect(stageOf(lab, stays)).toBe("needs_embedding");
  });

  it("is detached from a run under way, and the timer finishing the run leaves it removed", async () => {
    lab = await openLab();
    const gone = await lab.sample("deleted while running", "in_ethanol");
    const stays = await lab.sample("stays in the run", "in_ethanol");
    const batch = await startRun(lab, [gone, stays], "2020-01-01 08:00");
    expect(stageOf(lab, gone)).toBe("processing_started");

    await lab.db.removeSamples([gone], "wrong block");
    expect(members(lab, batch), "only the block that was not deleted is still in the run").toEqual([stays]);
    // The run started long ago, so this is the timed advance a lab sees overnight.
    await lab.db.autoAdvanceProcessingRuns();
    expect(stageOf(lab, gone)).toBe("removed");
    expect(stageOf(lab, stays)).toBe("processed");
    await lab.db.moveProcessingBatch(batch, "needs_embedding");
    expect(stageOf(lab, gone)).toBe("removed");
  });

  it("is detached from a run that is ready to collect", async () => {
    lab = await openLab();
    const gone = await lab.sample("deleted when ready", "in_ethanol");
    const stays = await lab.sample("stays in the run", "in_ethanol");
    const batch = await startRun(lab, [gone, stays]);
    await lab.db.moveProcessingBatch(batch, "processed");

    await lab.db.removeSamples([gone], "wrong block");
    await lab.db.moveProcessingBatch(batch, "needs_embedding");

    expect(members(lab, batch)).toEqual([stays]);
    expect(stageOf(lab, gone)).toBe("removed");
    expect(stageOf(lab, stays)).toBe("needs_embedding");
  });

  it("writes one audit record for the detachment, naming the run, the block and who did it", async () => {
    lab = await openLab();
    const gone = await lab.sample("audited", "in_ethanol");
    const stays = await lab.sample("bystander", "in_ethanol");
    const batch = await planRun(lab, [gone, stays]);
    const user = (await lab.db.getActiveUser()).id;

    await lab.db.removeSamples([gone], "wrong block");

    const events = detachEvents(lab, gone);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ user_id: user, action: "update", entity_id: batch });
    expect(events[0].summary).toContain(`processing batch ${batch}`);
    expect(JSON.parse(events[0].details)).toMatchObject({ batch_id: batch, sample_id: gone, run_dissolved: false });
    expect(detachEvents(lab, stays), "the bystander was not touched").toHaveLength(0);
    const listed = (await lab.db.listAuditEvents()) as Array<{ summary: string }>;
    expect(listed.some((e) => e.summary.includes(`processing batch ${batch}`)), "the Manifest shows it").toBe(true);
  });

  it("dissolves a run left with no members, as emptying it from its drawer does, and says so in the audit record", async () => {
    lab = await openLab();
    const only = await lab.sample("the only block", "in_ethanol");
    const batch = await planRun(lab, [only]);

    await lab.db.removeSamples([only], "wrong block");

    expect(lab.rows(`SELECT id FROM processing_batches WHERE id = ?`, [batch])).toHaveLength(0);
    expect(members(lab, batch)).toEqual([]);
    expect(lab.rows(`SELECT id FROM checklist_runs WHERE scope_type = 'processing_batch' AND scope_id = ?`, [batch])).toHaveLength(0);
    expect(stageOf(lab, only)).toBe("removed");
    expect(JSON.parse(detachEvents(lab, only)[0].details).run_dissolved).toBe(true);
  });

  it("takes every block of one Logs removal out of its run, whichever runs they were in", async () => {
    lab = await openLab();
    const a = await lab.sample("run one", "in_ethanol");
    const b = await lab.sample("run two", "in_ethanol");
    const keep = await lab.sample("keeper", "in_ethanol");
    const one = await planRun(lab, [a, keep]);
    const two = await startRun(lab, [b]);

    await lab.db.removeSamples([a, b], "cleanup");

    expect(members(lab, one)).toEqual([keep]);
    expect(lab.rows(`SELECT id FROM processing_batches WHERE id = ?`, [two])).toHaveLength(0);
    expect(stageOf(lab, a)).toBe("removed");
    expect(stageOf(lab, b)).toBe("removed");
  });

  it("is undone whole: the block is back in its run, with its stage", async () => {
    lab = await openLab();
    const gone = await lab.sample("undo me", "in_ethanol");
    const stays = await lab.sample("bystander", "in_ethanol");
    const batch = await planRun(lab, [gone, stays]);
    const before = await lab.db.snapshotDb();

    await lab.db.removeSamples([gone], "oops");
    await lab.db.restoreDbPreservingSession(before);

    expect(members(lab, batch)).toEqual([gone, stays]);
    expect(stageOf(lab, gone)).toBe("in_ethanol");
    expect(detachEvents(lab, gone)).toHaveLength(0);
  });

  it("is refused with nobody signed in, and the run keeps its member", async () => {
    lab = await openLab();
    const gone = await lab.sample("signed out", "in_ethanol");
    const batch = await planRun(lab, [gone]);
    await lab.db.setActiveUser(null);
    lab.db.setSignedOutReadOnly(true);

    await expect(lab.db.removeSamples([gone], "no one home")).rejects.toThrow("Sign in before making modifications.");

    expect(members(lab, batch)).toEqual([gone]);
    expect(stageOf(lab, gone)).toBe("in_ethanol");
  });
});
