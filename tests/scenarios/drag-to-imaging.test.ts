// A group waiting in Needs Sectioning cannot be dragged straight to Ready for Imaging.
//
// The drag skipped cutting: the group's slides were stamped cut and ready for imaging
// with nothing done at the bench. Once #167 stopped such a group being retracted, the
// glass could not be put back either. The captain's ruling is to deny the drag.
import { afterEach, describe, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

async function queuedGroup(l: Lab, description: string): Promise<number> {
  const block = await l.sample(description);
  const [group] = await l.db.createSectionRequests(block, [
    { duplicates: 2, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
  ]);
  return group;
}

const groupStage = (l: Lab, group: number) =>
  String(l.rows(`SELECT current_stage FROM section_requests WHERE id = ?`, [group])[0].current_stage);

describe("Needs Sectioning straight to Ready for Imaging", () => {
  it("is refused at the data layer, saying the group must be cut first, and changes nothing", async () => {
    lab = await openLab();
    const group = await queuedGroup(lab, "skips the cut");
    const before = lab.rows(`SELECT id, current_stage, stage_cut_at, stage_ready_for_imaging_at FROM slides WHERE section_request_id = ?`, [group]);

    await expect(lab.db.updateSectionStage(group, "ready_for_imaging")).rejects.toThrow(/must be cut first/i);

    expect(groupStage(lab, group)).toBe("needs_sectioning");
    expect(lab.rows(`SELECT id, current_stage, stage_cut_at, stage_ready_for_imaging_at FROM slides WHERE section_request_id = ?`, [group])).toEqual(before);
  });
});

describe("every other move still works", () => {
  const forward: Array<[string, string[]]> = [
    ["Needs Sectioning to Sectioned", ["sectioned"]],
    ["Needs Sectioning to Slide Assignment Required", ["assignment_required"]],
    ["Needs Sectioning to Needs Stains", ["stain_requested"]],
    ["Sectioned to Needs Stains", ["sectioned", "stain_requested"]],
    ["Needs Stains on to Stained", ["stain_requested", "stained"]],
    ["Needs Stains to Ready for Imaging", ["stain_requested", "ready_for_imaging"]],
    ["Ready for Imaging on to Pictures Taken", ["stain_requested", "ready_for_imaging", "pictures_taken"]],
    ["Pictures Taken on to Analyzed", ["stain_requested", "ready_for_imaging", "pictures_taken", "analyzed"]],
  ];
  for (const [label, path] of forward) {
    it(label, async () => {
      lab = await openLab();
      const group = await queuedGroup(lab, label);
      for (const stage of path) await lab.db.updateSectionStage(group, stage);
      expect(groupStage(lab, group)).toBe(path[path.length - 1]);
    });
  }

  it("a group cut and sent to staining can still go back to Needs Sectioning while nothing was done to it", async () => {
    lab = await openLab();
    const group = await queuedGroup(lab, "back again");
    await lab.db.updateSectionStage(group, "sectioned");
    await lab.db.revertSectionToStage(group, "needs_sectioning");
    expect(groupStage(lab, group)).toBe("needs_sectioning");
  });
});
