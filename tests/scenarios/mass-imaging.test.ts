// #150: several slides marked imaged in one action. On the real db.ts, on a real SQLite file.
//
// Marking many is a loop over marking one, so each slide must end up recorded as if it had been
// marked alone: its own stamp, its own audit record, and the group's state derived from all of
// its slides. The refusals that guard one slide guard each of these, and a refused slide is left
// exactly as it was while the rest go through.
import { afterEach, describe, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

const REFUSAL = "Sign in before making modifications.";

async function cutGroup(l: Lab, description: string, duplicates: number): Promise<{ group: number; slides: number[] }> {
  const block = await l.sample(description);
  const [group] = await l.db.createSectionRequests(block, [
    { duplicates, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
  ]);
  await l.db.updateSectionStage(group, "sectioned");
  await l.db.updateSectionStage(group, "stain_requested");
  const slides = l.rows(`SELECT id FROM slides WHERE section_request_id = ? ORDER BY id`, [group]).map((r) => Number(r.id));
  return { group, slides };
}

/** A block taken all the way to Ready for Imaging (one cut group per size given), the way the
 *  bench does it: through the stain rack's own checklist, not by poking the section's stage
 *  directly. Finishing the checklist is what SCATTERS the (cross-sample) stain rack into this
 *  sample's own per-sample imaging stack, so this is what gives two different samples two
 *  different racks the board can select between (#124's "cross-sample loading rack"). */
async function rackAtImaging(l: Lab, description: string, groups: number[]): Promise<{ stackId: number; slides: number[]; groups: number[] }> {
  const block = await l.sample(description);
  const made: number[] = await l.db.createSectionRequests(
    block,
    groups.map((duplicates) => ({ duplicates, stains: "H&E", assay_type: "stain", assay_name: "H&E" })),
  );
  for (const group of made) {
    await l.db.updateSectionStage(group, "sectioned");
    await l.db.updateSectionStage(group, "stain_requested");
  }
  const placeholders = made.map(() => "?").join(", ");
  const stainStackId = Number(
    l.rows(`SELECT DISTINCT stack_id FROM slides WHERE section_request_id IN (${placeholders})`, made)[0].stack_id,
  );
  await l.db.syncAssayStackWorkflowStep(stainStackId, "stain", 0, true);
  await l.db.syncAssayStackWorkflowStep(stainStackId, "stain", 1, true);
  const rows = l.rows(`SELECT id, stack_id FROM slides WHERE section_request_id IN (${placeholders}) ORDER BY id`, made);
  return { stackId: Number(rows[0].stack_id), slides: rows.map((r) => Number(r.id)), groups: made };
}

const slideRow = (l: Lab, id: number) =>
  l.rows(`SELECT current_stage, stage_pictures_taken_at FROM slides WHERE id = ?`, [id])[0];
const groupRow = (l: Lab, id: number) =>
  l.rows(`SELECT current_stage, stage_pictures_taken_at FROM section_requests WHERE id = ?`, [id])[0];
const imagingAudit = (l: Lab, slideId: number) =>
  l.rows(
    `SELECT user_id FROM audit_events
      WHERE entity_type = 'slide' AND entity_id = ? AND action = 'update' AND details = 'stage=pictures_taken'`,
    [slideId],
  );

describe("#150: marking many slides as imaged", () => {
  it("gives every slide its own stamp and its own audit record, as marking it alone does", async () => {
    lab = await openLab();
    const user = (await lab.db.getActiveUser()).id;
    const { group, slides } = await cutGroup(lab, "three slides", 3);
    const alone = await cutGroup(lab, "marked one at a time", 1);
    await lab.db.setSlidePicturesTaken(alone.slides[0], true);

    const result = await lab.db.markSlidesImaged(slides);

    expect(result).toEqual({ marked: slides, alreadyImaged: [], refused: [] });
    for (const id of slides) {
      const row = slideRow(lab, id);
      expect(row.current_stage).toBe("pictures_taken");
      expect(row.stage_pictures_taken_at, "its own stamp").toBeTruthy();
      const audit = imagingAudit(lab, id);
      expect(audit, "its own audit record").toHaveLength(1);
      expect(audit[0].user_id, "attributed to the signed-in user").toBe(user);
    }
    // The same end state marking one alone leaves: slide and group at pictures_taken, group stamped.
    expect(slideRow(lab, alone.slides[0]).current_stage).toBe(slideRow(lab, slides[0]).current_stage);
    expect(groupRow(lab, group).current_stage).toBe(groupRow(lab, alone.group).current_stage);
    expect(groupRow(lab, group).stage_pictures_taken_at).toBeTruthy();
  });

  it("derives the group's state from all its slides, not from the last one marked", async () => {
    lab = await openLab();
    const { group, slides } = await cutGroup(lab, "two of three", 3);

    await lab.db.markSlidesImaged(slides.slice(0, 2));

    expect(groupRow(lab, group).current_stage, "one slide still to image").toBe("ready_for_imaging");
    expect(groupRow(lab, group).stage_pictures_taken_at).toBeNull();
    expect(slideRow(lab, slides[2]).stage_pictures_taken_at).toBeNull();

    await lab.db.markSlidesImaged([slides[2]]);
    expect(groupRow(lab, group).current_stage).toBe("pictures_taken");
  });

  it("leaves a slide that was never cut untouched while the rest are marked, and says which", async () => {
    lab = await openLab();
    const cut = await cutGroup(lab, "cut", 2);
    const block = await lab.sample("still a plan");
    const [planned] = await lab.db.createSectionRequests(block, [
      { duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
    ]);
    const [uncut] = lab.rows(`SELECT id, slide_code FROM slides WHERE section_request_id = ?`, [planned]);
    const before = lab.rows(`SELECT * FROM slides WHERE id = ?`, [uncut.id])[0];
    const auditBefore = lab.rows(`SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = ? AND entity_type = 'slide'`, [uncut.id])[0].n;

    const result = await lab.db.markSlidesImaged([cut.slides[0], Number(uncut.id), cut.slides[1]]);

    expect(result.marked).toEqual(cut.slides);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toMatchObject({ slideId: Number(uncut.id), slideCode: uncut.slide_code });
    expect(result.refused[0].message).toMatch(/still waiting to be cut/);
    expect(lab.rows(`SELECT * FROM slides WHERE id = ?`, [uncut.id])[0], "the refused slide is not changed").toEqual(before);
    expect(
      lab.rows(`SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = ? AND entity_type = 'slide'`, [uncut.id])[0].n,
      "and gets no audit record",
    ).toBe(auditBefore);
    expect(groupRow(lab, planned).current_stage).toBe("needs_sectioning");
    for (const id of cut.slides) expect(slideRow(lab, id).current_stage).toBe("pictures_taken");
  });

  it("does not re-stamp a slide that was already imaged, and reports it", async () => {
    lab = await openLab();
    const { slides } = await cutGroup(lab, "one done", 2);
    await lab.db.setSlidePicturesTaken(slides[0], true);
    const stamp = slideRow(lab, slides[0]).stage_pictures_taken_at;
    const audits = imagingAudit(lab, slides[0]).length;
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const result = await lab.db.markSlidesImaged(slides);

    expect(result).toMatchObject({ marked: [slides[1]], alreadyImaged: [slides[0]], refused: [] });
    expect(slideRow(lab, slides[0]).stage_pictures_taken_at, "the real imaging time is kept").toBe(stamp);
    expect(imagingAudit(lab, slides[0])).toHaveLength(audits);
  });

  it("refuses a removed slide and a slide named twice marks it once", async () => {
    lab = await openLab();
    const { slides } = await cutGroup(lab, "removed and repeated", 3);
    await lab.db.removeSlide(slides[2], "broken");

    const result = await lab.db.markSlidesImaged([slides[0], slides[0], slides[2]]);

    expect(result.marked).toEqual([slides[0]]);
    expect(result.refused.map((r) => r.slideId)).toEqual([slides[2]]);
    expect(slideRow(lab, slides[2]).stage_pictures_taken_at).toBeNull();
    expect(imagingAudit(lab, slides[0])).toHaveLength(1);
  });

  it("is refused with nobody signed in, and nothing is written", async () => {
    lab = await openLab();
    const { slides } = await cutGroup(lab, "signed out", 2);
    await lab.db.setActiveUser(null);
    lab.db.setSignedOutReadOnly(true);

    await expect(lab.db.markSlidesImaged(slides)).rejects.toThrow(REFUSAL);

    for (const id of slides) {
      expect(slideRow(lab, id).stage_pictures_taken_at).toBeNull();
      expect(imagingAudit(lab, id)).toHaveLength(0);
    }
  });
});

// #150 follow-up: several RACKS marked imaged in one action, not just several slides ticked
// within one open rack. `listSlidesForStacks` is the new gather this needs — the board can
// select more than one Ready-for-Imaging rack, and the drawer must be able to mark every rack's
// slides in the one call, with the same guarantees markSlidesImaged already gives a single rack.
describe("#150: marking several selected racks as imaged", () => {
  it("gathers every selected rack's slides, none from a rack left out of the selection", async () => {
    lab = await openLab();
    const a = await rackAtImaging(lab, "rack a", [2]);
    const b = await rackAtImaging(lab, "rack b", [3]);
    const c = await rackAtImaging(lab, "rack c, not selected", [1]);
    expect(a.stackId).not.toBe(b.stackId);

    const gathered = await lab.db.listSlidesForStacks([a.stackId, b.stackId]);

    expect(gathered.map((s: { id: number }) => s.id).sort((x: number, y: number) => x - y)).toEqual(
      [...a.slides, ...b.slides].sort((x, y) => x - y),
    );
    expect(gathered.some((s: { id: number }) => c.slides.includes(s.id)), "rack c stayed out").toBe(false);
    expect(await lab.db.listSlidesForStacks([])).toEqual([]);
  });

  it("marks every slide across two gathered racks in one call, leaves a slide neither rack alone could image untouched, and reports it", async () => {
    lab = await openLab();
    const a = await rackAtImaging(lab, "rack a, all fine", [3]);
    // Two cut groups on the same rack (as the single-rack refusal test uses), so patching only
    // the smaller one leaves the rest of rack b fine alongside all of rack a.
    const b = await rackAtImaging(lab, "rack b, one group never cut", [2, 1]);
    const neverCutGroup = b.groups[1];
    const refusedSlide = lab.rows(`SELECT id FROM slides WHERE section_request_id = ?`, [neverCutGroup])[0].id;
    // Plant the same defect the single-rack refusal test plants (#167): put that one group back
    // to waiting to be cut, without the app's own gates in the way, so one slide on an otherwise
    // fine, selected rack cannot be imaged even alone.
    const db = await lab.db.getDb();
    await db.execute(`UPDATE section_requests SET current_stage = 'needs_sectioning' WHERE id = ?`, [neverCutGroup]);

    const gathered = await lab.db.listSlidesForStacks([a.stackId, b.stackId]);
    const expectedIds = [...a.slides, ...b.slides].sort((x, y) => x - y);
    expect(gathered.map((s: { id: number }) => s.id).sort((x: number, y: number) => x - y)).toEqual(expectedIds);

    const result = await lab.db.markSlidesImaged(gathered.map((s: { id: number }) => s.id));

    const fineSlides = b.slides.filter((id) => id !== Number(refusedSlide));
    expect(result.marked.sort((x: number, y: number) => x - y)).toEqual(
      [...a.slides, ...fineSlides].sort((x, y) => x - y),
    );
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toMatchObject({ slideId: Number(refusedSlide) });
    expect(result.refused[0].message).toMatch(/still waiting to be cut/);
    expect(slideRow(lab, Number(refusedSlide)).stage_pictures_taken_at, "the refused slide is untouched").toBeNull();
    for (const id of [...a.slides, ...fineSlides]) {
      expect(slideRow(lab, id).current_stage, "the rest, across both racks, are marked").toBe("pictures_taken");
    }
  });
});
