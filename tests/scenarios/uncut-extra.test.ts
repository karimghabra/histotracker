// #182 — an extra is glass only once a blade has taken it.
//
// The stress2 fuzzer put a slide in a staining rack that had never been cut
// (seed 20260813, step 132). The extras a stain request may draw on were
// filtered by their cut GROUP's stage, which is only a proxy for "this glass
// exists": a slide keeps its own stamps when it moves between groups, so an
// uncut extra refiled onto another block landed in one of that block's groups
// and inherited that group's answer.
//
// The rule is stated at the three places the record can go wrong, and this walks
// all three on the real db.ts: the refile is refused, so a plan line never joins
// a cut that was already taken and the group's next ordinary move cannot mint a
// cut date for it; and both rack entrances read the slide's own cut stamp.
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";
import { rackedButNeverCut } from "./invariants";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

const cutDateOf = (l: Lab, slide: number) =>
  l.rows(`SELECT stage_cut_at FROM slides WHERE id = ?`, [slide])[0].stage_cut_at;

it("an uncut extra cannot be refiled into a cut that has already been taken", async () => {
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

  // Somebody decides it belongs to the other block. The right block's cut has
  // already been taken, so there is no honest way to file a plan line into it.
  await expect(
    lab.db.relabelSlideToSample(planned.id, right, "mislabelled at the microtome"),
  ).rejects.toThrow(/has not been cut yet/);
  expect(
    lab.rows(`SELECT section_request_id FROM slides WHERE id = ?`, [planned.id])[0]
      .section_request_id,
    "the slide is left in the plan it came from",
  ).toBe(queued);

  // The group it would have joined then moves on as groups do. That move stamps
  // every slide in the group as cut, which is what would have minted a cut date
  // for a slide that was not there when the blade was.
  await lab.db.updateSectionStage(cutGroup, "stained");
  expect(cutDateOf(lab, planned.id), "the plan line still has no cut date").toBeNull();

  const result = await lab.db.requestStainForSample({
    sampleId: right,
    assayType: "stain",
    assayName: "PAS",
  });
  expect(result.target, "an uncut slide is not glass, so the block is flagged for a cut").toBe(
    "block",
  );
  expect(rackedButNeverCut(lab).join("; ") || "none", "the racks hold only real glass").toBe("none");
});

it("both rack entrances refuse an uncut extra whose group reads past the queue", async () => {
  lab = await openLab();
  const block = await lab.sample("a block");
  const [group] = await lab.db.createSectionRequests(block, [{ duplicates: 1, stains: "" }]);
  const planned = lab.rows(`SELECT id, stage_cut_at FROM slides WHERE section_request_id = ?`, [
    group,
  ])[0];
  expect(planned.stage_cut_at, "the queued block's extra has no cut date").toBeNull();

  // The shape an older build could leave behind, and the one the refusal above
  // now prevents: the group reads past the queue while the slide was never cut.
  // Every route that racks a slide reads the slide's own stamp, so each refuses.
  const db = await lab.db.getDb();
  await db.execute(`UPDATE section_requests SET current_stage = 'stain_requested' WHERE id = ?`, [
    group,
  ]);

  const inventory = (await lab.db.listExtraSlides()) as Array<{ id: number }>;
  expect(
    inventory.some((slide) => slide.id === planned.id),
    "the extras inventory does not list an uncut slide",
  ).toBe(false);

  expect(
    (
      await lab.db.requestStainForSample({
        sampleId: block,
        assayType: "stain",
        assayName: "PAS",
      })
    ).target,
    "a stain request flags the block for a cut rather than taking it",
  ).toBe("block");

  await lab.db.addAssay({ assay_type: "stain", name: "PAS" }).catch(() => undefined);
  await expect(
    lab.db.assignExtraSlideToAssay({
      slideId: planned.id,
      assayType: "stain",
      assayName: "PAS",
    }),
  ).rejects.toThrow(/no cut date/);

  const after = lab.rows(`SELECT stack_id, purpose, stage_cut_at FROM slides WHERE id = ?`, [
    planned.id,
  ])[0];
  expect(after.stack_id, "the uncut slide never joins a staining rack").toBeNull();
  expect(after.purpose, "and is not re-purposed as a stain slide").toBe("extra");
  expect(after.stage_cut_at, "and is still uncut").toBeNull();
  expect(rackedButNeverCut(lab).join("; ") || "none", "the racks hold only real glass").toBe("none");
});
