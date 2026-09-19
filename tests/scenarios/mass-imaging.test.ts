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
