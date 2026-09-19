// Issues #139, #144 and #148, all fixed and now hard checks, each as a scenario on the real db.ts.
//
// Each assertion is written against the harm the issue describes, not against one
// fix: where the issue leaves the remedy open (refuse the action, or allow it and
// keep the record straight), every remedy that removes the harm passes.
//
// Each open issue's test is `it.fails`: the bug is open, so the test is expected to fail and CI stays green.
// The day the fix lands the test passes, `it.fails` reports that as a failure, and whoever fixed
// the issue must change `it.fails` to `it` here, which turns the scenario into a hard check.
import { afterEach, describe, expect, it } from "vitest";
import { workedButNeverCut } from "./invariants";
import { openLab, type Lab } from "./lab";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

// #139 is fixed: it is a plain `it`, and retraction-routes.test.ts sweeps every other route.
describe("#139: retracting a cut never leaves glass that was worked on but never cut", () => {
  for (const reached of ["ready_for_imaging", "analyzed"]) {
    it(`after the group reached ${reached}`, async () => {
      lab = await openLab();
      const block = await lab.sample(`retract after ${reached}`);
      const [group] = await lab.db.createSectionRequests(block, [
        { duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
      ]);
      await lab.db.updateSectionStage(group, reached);
      // The board allows this drag; whether the data layer refuses it is the fix's call.
      let refusal = "accepted";
      await lab.db.revertSectionToStage(group, "needs_sectioning").catch((e: Error) => (refusal = `refused: ${e.message}`));
      expect(workedButNeverCut(lab).join("; ") || "none", `retraction ${refusal.slice(0, 60)}`).toBe("none");
    });
  }
});

describe("#144: a stain request never plans glass on a block with no tissue left", () => {
  it("an exhausted block with a cut still waiting in Needs Sectioning", async () => {
    lab = await openLab();
    const block = await lab.sample("spent block");
    await lab.db.createSectionRequests(block, [{ duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" }]);
    const planned = () =>
      Number(
        lab!.rows(
          `SELECT COUNT(*) AS n FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
            WHERE sr.sample_id = ? AND sr.current_stage = 'needs_sectioning' AND sl.current_stage <> 'removed'`,
          [block],
        )[0].n,
      );
    let exhausted = true;
    await lab.db.setBlockExhausted(block, true).catch(() => (exhausted = false));
    if (!exhausted) {
      // A fix may refuse to exhaust a block with a cut queued; then the harm cannot arise.
      expect(lab.rows(`SELECT block_exhausted FROM samples WHERE id = ?`, [block])[0].block_exhausted).toBe(0);
      return;
    }
    // Exhausting may itself cancel the waiting cut (#144); the request must add nothing on top.
    const before = planned();
    let outcome = "accepted";
    await lab.db
      .requestStainForSample({ sampleId: block, assayType: "stain", assayName: "PAS" })
      .catch((e: Error) => (outcome = `refused: ${e.message}`));
    expect(planned(), `planned slides on the exhausted block's waiting cut; request ${outcome.slice(0, 60)}`).toBe(before);
  });
});

describe("#144: exhausting a block cancels the cut waiting for it, with a record", () => {
  it("the group is marked removed, its slides removed with a reason, and restoring does not revive it", async () => {
    lab = await openLab();
    const block = await lab.sample("spent block, cut queued");
    const [group] = await lab.db.createSectionRequests(block, [
      { duplicates: 2, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
    ]);
    await lab.db.setBlockExhausted(block, true);

    expect(lab.rows(`SELECT current_stage FROM section_requests WHERE id = ?`, [group])[0].current_stage).toBe("removed");
    const slides = lab.rows(`SELECT current_stage, stack_id FROM slides WHERE section_request_id = ?`, [group]);
    expect(slides.length).toBeGreaterThan(0);
    expect(slides.every((s) => s.current_stage === "removed" && s.stack_id === null)).toBe(true);
    const events = lab.rows(
      `SELECT details FROM sample_timeline_events WHERE sample_id = ? AND event_type = 'slide_removed'`,
      [block],
    );
    expect(events).toHaveLength(slides.length);
    expect(events.every((e) => /exhausted/i.test(String(e.details)))).toBe(true);

    await lab.db.setBlockExhausted(block, false);
    expect(lab.rows(`SELECT current_stage FROM section_requests WHERE id = ?`, [group])[0].current_stage).toBe("removed");
  });

  it("a database that already holds the state shows no Needs Sectioning card for it", async () => {
    lab = await openLab();
    const block = await lab.sample("already spent, cut still queued");
    const [group] = await lab.db.createSectionRequests(block, [
      { duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
    ]);
    const raw = await lab.db.getDb();
    await raw.execute(`UPDATE samples SET block_exhausted = 1 WHERE id = ?`, [block]);

    const open = (await lab.db.listOpenSectionRequests()) as Array<{ id: number; sample_id: number }>;
    expect(open.some((request) => request.id === group)).toBe(false);
    expect(lab.rows(`SELECT current_stage FROM section_requests WHERE id = ?`, [group])[0].current_stage).toBe(
      "needs_sectioning",
    );
  });

  it("a cut already past the queue is left alone", async () => {
    lab = await openLab();
    const block = await lab.sample("spent block, already cut");
    const [group] = await lab.db.createSectionRequests(block, [
      { duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
    ]);
    await lab.db.updateSectionStage(group, "sectioned");
    await lab.db.setBlockExhausted(block, true);
    expect(lab.rows(`SELECT current_stage FROM section_requests WHERE id = ?`, [group])[0].current_stage).not.toBe("removed");
    const open = (await lab.db.listOpenSectionRequests()) as Array<{ id: number }>;
    expect(open.some((request) => request.id === group)).toBe(true);
  });
});

describe("#148: emptying a processing run that already ran leaves a record that it ran", () => {
  // #148 is fixed: a started run is cancelled, never deleted.
  it("the last sample taken out of a running run", async () => {
    lab = await openLab();
    const block = await lab.sample("in the processor", "in_ethanol");
    const batch: number = await lab.db.startProcessingBatch({
      sampleIds: [block],
      processingType: "Short",
      operatorName: "KG",
      startedAt: "2026-09-14 08:30",
      checklistLabels: ["Reagents checked"],
    });
    expect(lab.rows(`SELECT status FROM processing_batches WHERE id = ?`, [batch])[0]?.status).toBe("processing");

    let outcome = "accepted";
    await lab.db.updateBatchMembers(batch, []).catch((e: Error) => (outcome = `refused: ${e.message}`));

    const stillThere = lab.rows(`SELECT id FROM processing_batches WHERE id = ?`, [batch]).length > 0;
    const recorded = lab
      .rows(
        `SELECT action, entity_id, summary, COALESCE(details, '') AS details FROM audit_events
          WHERE entity_type = 'processing_batch' AND action NOT IN ('create', 'update')`,
      )
      .filter((r) => r.entity_id === batch || new RegExp(`\\b(batch|run) #?${batch}\\b`, "i").test(`${r.summary} ${r.details}`));
    expect(
      stillThere || recorded.length > 0,
      `running batch ${batch} emptied (${outcome.slice(0, 50)}): row kept=${stillThere}, deletion audit rows=${recorded.length}`,
    ).toBe(true);

    // The remedy the captain ruled on: the run is kept, marked cancelled, with
    // what was in it, its protocol checklist and an audit record of the cancel.
    expect(lab.rows(`SELECT status FROM processing_batches WHERE id = ?`, [batch])[0]?.status).toBe("cancelled");
    expect(lab.rows(`SELECT sample_id FROM processing_batch_members WHERE batch_id = ?`, [batch]).map((r) => r.sample_id)).toEqual([block]);
    expect(
      lab.rows(
        `SELECT COUNT(*) AS n FROM checklist_runs WHERE scope_type = 'processing_batch' AND scope_id = ?`,
        [batch],
      )[0].n,
    ).toBe(1);
    expect(recorded.map((r) => r.action)).toContain("cancel");
    expect(lab.rows(`SELECT current_stage FROM samples WHERE id = ?`, [block])[0].current_stage).toBe("in_ethanol");
  });

  it("a cancelled run does not come back on the board when one of its samples is processed again", async () => {
    lab = await openLab();
    const block = await lab.sample("in the processor", "in_ethanol");
    const first: number = await lab.db.startProcessingBatch({
      sampleIds: [block],
      processingType: "Short",
      operatorName: "KG",
      startedAt: "2026-09-14 08:30",
      checklistLabels: ["Reagents checked"],
    });
    await lab.db.updateBatchMembers(first, []);
    const second: number = await lab.db.startProcessingBatch({
      sampleIds: [block],
      processingType: "Short",
      operatorName: "KG",
      startedAt: "2026-09-14 10:00",
      checklistLabels: [],
    });
    const open = (await lab.db.listOpenProcessingBatches()).map((b) => b.id);
    expect(open).toEqual([second]);
  });

  it("a planned run that is emptied is still deleted", async () => {
    lab = await openLab();
    const block = await lab.sample("planned", "in_ethanol");
    const batch: number = await lab.db.planProcessingBatch({
      sampleIds: [block],
      processingType: "Short",
      operatorName: "KG",
      plannedStartAt: "2030-01-01 08:00",
    });
    await lab.db.updateBatchMembers(batch, []);
    expect(lab.rows(`SELECT id FROM processing_batches WHERE id = ?`, [batch])).toEqual([]);
  });
});
