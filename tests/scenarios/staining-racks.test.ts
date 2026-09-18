// The staining-rack model test:staining claims to protect, asserted on the real db.ts:
// slides entering staining join the ONE open rack for their agent, across samples.
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

it("two blocks' SafO slides load into one cross-sample rack", async () => {
  lab = await openLab();
  for (const description of ["tendon A", "tendon B"]) {
    const block = await lab.sample(description);
    const [group] = await lab.db.createSectionRequests(block, [
      { duplicates: 1, stains: "SafO", assay_type: "stain", assay_name: "SafO" },
    ]);
    await lab.db.updateSectionStage(group, "sectioned");
    await lab.db.updateSectionStage(group, "stain_requested");
  }
  const racks = lab
    .rows(`SELECT DISTINCT stack_id FROM slides WHERE assay_name = 'SafO' AND current_stage = 'stain_requested'`)
    .map((r) => String(r.stack_id));
  expect(racks.join(",") || "no rack", "SafO racks holding the two blocks' slides").toMatch(/^\d+$/);
});
