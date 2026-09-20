// Open issue #144 (and #139 and #148, fixed and now hard checks), each as a scenario on the real db.ts.
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
      // Needs Sectioning straight to Ready for Imaging is refused, so that stage is reached by way of Staining.
      if (reached === "ready_for_imaging") await lab.db.updateSectionStage(group, "stain_requested");
      await lab.db.updateSectionStage(group, reached);
      // The board allows a straight drag to the later stages; whether the data layer refuses the retraction is the fix's call.
      let refusal = "accepted";
      await lab.db.revertSectionToStage(group, "needs_sectioning").catch((e: Error) => (refusal = `refused: ${e.message}`));
      expect(workedButNeverCut(lab).join("; ") || "none", `retraction ${refusal.slice(0, 60)}`).toBe("none");
    });
  }
});

describe("#144: a stain request never plans glass on a block with no tissue left", () => {
  // OPEN ISSUE #144: remove `.fails` in the pull request that fixes it.
  it.fails("an exhausted block with a cut still waiting in Needs Sectioning", async () => {
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
    const before = planned();

    let exhausted = true;
    await lab.db.setBlockExhausted(block, true).catch(() => (exhausted = false));
    if (!exhausted) {
      // A fix may refuse to exhaust a block with a cut queued; then the harm cannot arise.
      expect(lab.rows(`SELECT block_exhausted FROM samples WHERE id = ?`, [block])[0].block_exhausted).toBe(0);
      return;
    }
    let outcome = "accepted";
    await lab.db
      .requestStainForSample({ sampleId: block, assayType: "stain", assayName: "PAS" })
      .catch((e: Error) => (outcome = `refused: ${e.message}`));
    expect(planned(), `planned slides on the exhausted block's waiting cut; request ${outcome.slice(0, 60)}`).toBe(before);
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
