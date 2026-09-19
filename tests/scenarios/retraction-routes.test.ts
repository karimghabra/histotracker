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

// Needs Sectioning to Ready for Imaging is refused (drag-to-imaging.test.ts), so worked glass is reached by way of Staining.
async function sendToImaging(l: Lab, group: number): Promise<void> {
  await l.db.updateSectionStage(group, "stain_requested");
  await l.db.updateSectionStage(group, "ready_for_imaging");
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
  // The board lets a group be dragged to any stage from any stage (Pictures Taken is gated, and Needs Sectioning straight to Ready for Imaging is refused).
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
    await sendToImaging(lab, group);
    const [first] = lab.rows(`SELECT id FROM slides WHERE section_request_id = ? ORDER BY slide_ordinal`, [group]);
    await lab.db.removeSlide(Number(first.id), "broke at the bench");
    straight(lab, await attempt(() => lab!.db.revertSectionToStage(group, "needs_sectioning")));
  });

  it("a worked slide refiled under another block, then that group retracted", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "source block");
    const other = await lab.sample("target block");
    await sendToImaging(lab, group);
    const slide = Number(lab.rows(`SELECT id FROM slides WHERE section_request_id = ?`, [group])[0].id);
    await lab.db.relabelSlideToSample(slide, other, "labelled with the wrong block");
    const landed = Number(lab.rows(`SELECT section_request_id AS g FROM slides WHERE id = ?`, [slide])[0].g);
    straight(lab, await attempt(() => lab!.db.revertSectionToStage(landed, "needs_sectioning")));
  });

  it("a worked slide refiled into a group still queued, then that group retracted", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "source block");
    const target = await queuedGroup(lab, "queued target block");
    await sendToImaging(lab, group);
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

describe("adding a slide to a group is stamped cut only because glass in it was cut", () => {
  const cutStamps = (l: Lab, slide: number) =>
    l.rows(`SELECT stage_cut_at, current_stage FROM slides WHERE id = ?`, [slide])[0];

  it("a removed sibling that was once cut does not make the new slide cut, after a retraction", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "retracted, removed sibling", 2);
    await lab.db.updateSectionStage(group, "sectioned");
    const [gone] = lab.rows(`SELECT id FROM slides WHERE section_request_id = ? ORDER BY slide_ordinal, id`, [group]);
    await lab.db.removeSlide(Number(gone.id), "broke at the bench");
    await lab.db.revertSectionToStage(group, "needs_sectioning");
    // The removed slide keeps the stamp it earned; the retraction is what leaves it beside a queued group.
    expect(cutStamps(lab, Number(gone.id)).stage_cut_at).not.toBeNull();

    const added = await lab.db.addSlideToSection(group, { assayType: "stain", assayName: "H&E" });
    expect(cutStamps(lab, added).stage_cut_at, "nothing was cut, so the new slide has no cut date").toBeNull();
    expect(cutStamps(lab, added).current_stage).toBe("assigned");
    const extra = await lab.db.addSlideToSection(group, { extra: true });
    expect(cutStamps(lab, extra).stage_cut_at).toBeNull();
  });

  it("a live sibling that really was cut still makes the new slide cut", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "cut group, slide added", 2);
    await lab.db.updateSectionStage(group, "sectioned");
    const added = await lab.db.addSlideToSection(group, { assayType: "stain", assayName: "H&E" });
    expect(cutStamps(lab, added).stage_cut_at).not.toBeNull();
    expect(cutStamps(lab, added).current_stage).toBe("stain_requested");
    const extra = await lab.db.addSlideToSection(group, { extra: true });
    expect(cutStamps(lab, extra).stage_cut_at).not.toBeNull();
  });

  it("a removed sibling does not hide the cut of a live one", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "cut group, one removed", 2);
    await lab.db.updateSectionStage(group, "sectioned");
    const [gone] = lab.rows(`SELECT id FROM slides WHERE section_request_id = ? ORDER BY slide_ordinal, id`, [group]);
    await lab.db.removeSlide(Number(gone.id), "broke at the bench");
    const added = await lab.db.addSlideToSection(group, { assayType: "stain", assayName: "H&E" });
    expect(cutStamps(lab, added).stage_cut_at).not.toBeNull();
  });

  it("a group still past Needs Sectioning with every slide removed was cut, so the new slide is cut", async () => {
    lab = await openLab();
    const { group } = await queuedGroup(lab, "cut group, all removed", 2);
    await lab.db.updateSectionStage(group, "sectioned");
    for (const { id } of lab.rows(`SELECT id FROM slides WHERE section_request_id = ?`, [group])) {
      await lab.db.removeSlide(Number(id), "broke at the bench");
    }
    expect(lab.rows(`SELECT current_stage FROM section_requests WHERE id = ?`, [group])[0].current_stage).toBe("sectioned");

    const added = await lab.db.addSlideToSection(group, { assayType: "stain", assayName: "H&E" });
    expect(cutStamps(lab, added).stage_cut_at, "the blade did touch this block").not.toBeNull();
    expect(cutStamps(lab, added).current_stage).toBe("stain_requested");
    const extra = await lab.db.addSlideToSection(group, { extra: true });
    expect(cutStamps(lab, extra).stage_cut_at).not.toBeNull();
  });
});
