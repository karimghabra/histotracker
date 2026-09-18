// A3: every route that can take a cut back out of a group, or put work on glass that was never cut.
//
// Each test walks one route and then reads the record: no live slide may carry a work stamp
// while its cut date is empty. The assertion is against that harm, not against one remedy, so a
// route may refuse the step or keep the record straight, and either passes. (#139 was reached
// by a route the retraction guard did not look at, so the guard alone proves nothing.)
import { afterEach, describe, expect, it } from "vitest";
import { workedButNeverCut } from "./invariants";
import { openLab, type Lab } from "./lab";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

async function attempt(step: () => Promise<unknown>): Promise<string> {
  try {
    await step();
    return "accepted";
  } catch (e) {
    return `refused: ${(e as Error).message}`;
  }
}

function straight(l: Lab, outcome: string): void {
  expect(workedButNeverCut(l).join("; ") || "none", `last step ${outcome.slice(0, 70)}`).toBe("none");
}

async function queuedGroup(l: Lab, description: string, duplicates = 1): Promise<{ block: number; group: number }> {
  const block = await l.sample(description);
  const [group] = await l.db.createSectionRequests(block, [
    { duplicates, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
  ]);
  return { block, group };
}

const STAGES_AFTER_CUT = [
  "sectioned",
  "assignment_required",
  "stain_requested",
  "stained",
  "ihc_complete",
  "refrax_complete",
  "coverslipped",
  "dried",
  "ready_for_imaging",
  "pictures_taken",
  "analyzed",
];

describe("retracting a group to Needs Sectioning, from every stage it can reach", () => {
  // The board lets a group be dragged to any stage from any stage (only Pictures Taken is gated).
  for (const stage of STAGES_AFTER_CUT) {
    it(`straight from Needs Sectioning to ${stage} and back`, async () => {
      lab = await openLab();
      const { group } = await queuedGroup(lab, `to ${stage}`);
      const forward = await attempt(() => lab!.db.updateSectionStage(group, stage));
      straight(lab, forward);
      const back = await attempt(() => lab!.db.revertSectionToStage(group, "needs_sectioning"));
      straight(lab, back);
    });

    it(`by way of Staining, on to ${stage} and back`, async () => {
      lab = await openLab();
      const { group } = await queuedGroup(lab, `via staining to ${stage}`);
      await lab.db.updateSectionStage(group, "sectioned");
      await lab.db.updateSectionStage(group, "stain_requested");
      const forward = await attempt(() => lab!.db.updateSectionStage(group, stage));
      straight(lab, forward);
      const back = await attempt(() => lab!.db.revertSectionToStage(group, "needs_sectioning"));
      straight(lab, back);
    });
  }
});

describe("retracting after the work was recorded on the glass, not the group", () => {
  it("a rack ticked Stained", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "rack ticked");
    await lab.db.updateSectionStage(group, "sectioned");
    await lab.db.updateSectionStage(group, "stain_requested");
    const stack = Number(lab.rows(`SELECT stack_id FROM slides WHERE section_request_id = ?`, [group])[0].stack_id);
    await lab.db.syncAssayStackWorkflowStep(stack, "stain", 0, true);
    straight(lab, await attempt(() => lab!.db.revertSectionToStage(group, "needs_sectioning")));
  });

  it("a slide marked imaged", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "slide imaged");
    await lab.db.updateSectionStage(group, "stain_requested");
    const slide = Number(lab.rows(`SELECT id FROM slides WHERE section_request_id = ?`, [group])[0].id);
    await lab.db.setSlidePicturesTaken(slide, true);
    straight(lab, await attempt(() => lab!.db.revertSectionToStage(group, "needs_sectioning")));
  });

  it("the whole group marked imaged", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "group imaged");
    await lab.db.updateSectionStage(group, "stain_requested");
    await lab.db.completeSectionImaging(group);
    straight(lab, await attempt(() => lab!.db.revertSectionToStage(group, "needs_sectioning")));
  });

  it("a worked slide removed, its sibling still waiting to be retracted", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "one removed", 2);
    await lab.db.updateSectionStage(group, "ready_for_imaging");
    const [first] = lab.rows(`SELECT id FROM slides WHERE section_request_id = ? ORDER BY slide_ordinal`, [group]);
    await lab.db.removeSlide(Number(first.id), "broke at the bench");
    straight(lab, await attempt(() => lab!.db.revertSectionToStage(group, "needs_sectioning")));
  });

  it("a worked slide refiled under another block, then that group retracted", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "source block");
    const other = await lab.sample("target block");
    await lab.db.updateSectionStage(group, "ready_for_imaging");
    const slide = Number(lab.rows(`SELECT id FROM slides WHERE section_request_id = ?`, [group])[0].id);
    await lab.db.relabelSlideToSample(slide, other, "labelled with the wrong block");
    const landed = Number(lab.rows(`SELECT section_request_id AS g FROM slides WHERE id = ?`, [slide])[0].g);
    straight(lab, await attempt(() => lab!.db.revertSectionToStage(landed, "needs_sectioning")));
  });

  it("a worked slide refiled into a group still queued, then that group retracted", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "source block");
    const target = await queuedGroup(lab, "queued target block");
    await lab.db.updateSectionStage(group, "ready_for_imaging");
    const slide = Number(lab.rows(`SELECT id FROM slides WHERE section_request_id = ?`, [group])[0].id);
    await lab.db.relabelSlideToSample(slide, target.block, "labelled with the wrong block");
    const landed = Number(lab.rows(`SELECT section_request_id AS g FROM slides WHERE id = ?`, [slide])[0].g);
    straight(lab, await attempt(() => lab!.db.revertSectionToStage(landed, "needs_sectioning")));
  });
});

describe("putting work on a slide whose group is still waiting to be cut", () => {
  it("marking a planned slide imaged", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "planned, imaged");
    const slide = Number(lab.rows(`SELECT id FROM slides WHERE section_request_id = ?`, [group])[0].id);
    straight(lab, await attempt(() => lab!.db.setSlidePicturesTaken(slide, true)));
  });

  it("marking a queued group imaged", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "queued, group imaged");
    straight(lab, await attempt(() => lab!.db.completeSectionImaging(group)));
  });

  it("staining a planned extra slide", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "planned extra");
    const extra = await lab.db.addSlideToSection(group, { extra: true });
    await lab.db.addAssay({ assay_type: "stain", name: "PAS" }).catch(() => undefined);
    const assigned = await attempt(() => lab!.db.assignExtraSlideToAssay({ slideId: extra, assayType: "stain", assayName: "PAS" }));
    straight(lab, assigned);
    const stack = lab.rows(`SELECT stack_id FROM slides WHERE id = ?`, [extra])[0].stack_id;
    if (stack != null) straight(lab, await attempt(() => lab!.db.syncAssayStackWorkflowStep(Number(stack), "stain", 0, true)));
  });
});
