// #182 — an extra is glass only once a blade has taken it.
//
// The stress2 fuzzer put a slide in a staining rack that had never been cut
// (seed 20260813, step 132). The route is here, on the real db.ts: the extras a
// stain request may draw on were filtered by their cut GROUP's stage, which is
// only a proxy for "this glass exists". A slide keeps its own stamps when it
// moves between groups, so an uncut extra refiled onto another block lands in
// one of that block's groups and inherits that group's answer.
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";
import { rackedButNeverCut } from "./invariants";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

it("a stain request refuses an uncut extra refiled onto the block", async () => {
  lab = await openLab();
  const left = await lab.sample("left tendon");
  const right = await lab.sample("right tendon");

  // The right block is cut for real, and its one extra is taken by a first
  // request — so its group is past Needs Sectioning with nothing free in it.
  const [cutGroup] = await lab.db.createSectionRequests(right, [{ duplicates: 1, stains: "" }]);
  await lab.db.updateSectionStage(cutGroup, "sectioned");
  await lab.db.updateSectionStage(cutGroup, "stain_requested");
  expect(
    (await lab.db.requestStainForSample({ sampleId: right, assayType: "stain", assayName: "SafO" }))
      .target,
    "the right block's own cut extra fulfils the first request",
  ).toBe("extra");

  // The left block's cut is still queued, so its extra is a line in a plan.
  const [queued] = await lab.db.createSectionRequests(left, [{ duplicates: 1, stains: "" }]);
  const planned = lab.rows(`SELECT id, stage_cut_at FROM slides WHERE section_request_id = ?`, [
    queued,
  ])[0];
  expect(planned.stage_cut_at, "the queued block's extra has no cut date").toBeNull();

  // Somebody notices it belongs to the other block and refiles it. It lands in
  // the right block's group, which HAS been cut.
  await lab.db.relabelSlideToSample(planned.id, right, "mislabelled at the microtome");
  expect(
    lab.rows(
      `SELECT sr.current_stage AS stage FROM slides sl
         JOIN section_requests sr ON sr.id = sl.section_request_id WHERE sl.id = ?`,
      [planned.id],
    )[0].stage,
    "the refiled slide now sits in a group past Needs Sectioning",
  ).not.toMatch(/^(needs_sectioning|sectioned|assignment_required)$/);

  const result = await lab.db.requestStainForSample({
    sampleId: right,
    assayType: "stain",
    assayName: "PAS",
  });
  expect(result.target, "an uncut slide is not glass, so the block is flagged for a cut").toBe(
    "block",
  );
  const after = lab.rows(`SELECT stack_id, purpose, stage_cut_at FROM slides WHERE id = ?`, [
    planned.id,
  ])[0];
  expect(after.stack_id, "the uncut slide never joins a staining rack").toBeNull();
  expect(after.purpose, "and is not re-purposed as a stain slide").toBe("extra");
  expect(after.stage_cut_at, "and is still uncut").toBeNull();
  expect(rackedButNeverCut(lab).join("; ") || "none", "the racks hold only real glass").toBe("none");

  // Nor is it offered as glass on the bench.
  const inventory = (await lab.db.listExtraSlides()) as Array<{ id: number }>;
  expect(
    inventory.some((slide) => slide.id === planned.id),
    "the extras inventory does not list an uncut slide",
  ).toBe(false);
});
