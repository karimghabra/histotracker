import { test, expect, boot, seedLarge, checkInvariantsFast, write, sql } from "../stress2/driver";

/**
 * Poison the database and insist the catalogue notices.
 *
 * An invariant that has never failed is indistinguishable from an invariant that
 * cannot fail. Five landed with 0.14 to cover racks-as-physical-objects, and a
 * green run proves nothing about them until each has been seen to bite.
 *
 * Every violation below is planted with `write()` — straight into the image,
 * bypassing db.ts — precisely because the app is supposed to make these states
 * unreachable. The point is not that the app can produce them; it is that if it
 * ever does, something says so.
 *
 * It has already earned its keep. A sixth invariant, "two open racks for one
 * agent never share a number", could not be poisoned: the number is defined as
 * "how many racks for this agent have an id at or below mine", which is
 * injective over distinct ids, so no state can violate it. It was a tautology
 * that read like a check, and it is gone — see the note in `invariants.ts`.
 */

type Poison = {
  id: string;
  what: string;
  plant: (page: Parameters<typeof write>[0]) => Promise<void>;
};

const POISONS: Poison[] = [
  {
    id: "rack-within-capacity",
    what: "a rack holding more slides than the ceiling allows",
    plant: async (page) => {
      await write(page, `UPDATE app_settings SET value = '1' WHERE key = 'max_stain_rack_slides'`);
      await write(
        page,
        `INSERT INTO app_settings (key, value) VALUES ('max_stain_rack_slides', '1')
           ON CONFLICT(key) DO UPDATE SET value = '1'`,
      );
      // Two live slides into one open rack, with the ceiling at one.
      const rack = (
        await sql<{ id: number }>(
          page,
          `SELECT id FROM slide_stacks WHERE kind = 'stain' AND closed_at IS NULL ORDER BY id LIMIT 1`,
        )
      )[0];
      const spare = await sql<{ id: number }>(
        page,
        `SELECT id FROM slides WHERE purpose = 'stain' AND current_stage <> 'removed'
          ORDER BY id LIMIT 2`,
      );
      for (const slide of spare) {
        await write(page, `UPDATE slides SET stack_id = ? WHERE id = ?`, [rack.id, slide.id]);
      }
    },
  },
  {
    id: "rack-holds-one-agent",
    what: "a PAS slide sitting in the H&E rack",
    plant: async (page) => {
      const rack = (
        await sql<{ id: number; assay_name: string }>(
          page,
          `SELECT id, assay_name FROM slide_stacks
            WHERE kind = 'stain' AND closed_at IS NULL ORDER BY id LIMIT 1`,
        )
      )[0];
      const slide = (
        await sql<{ id: number }>(
          page,
          `SELECT id FROM slides WHERE stack_id = ? AND purpose = 'stain' ORDER BY id LIMIT 1`,
          [rack.id],
        )
      )[0];
      await write(page, `UPDATE slides SET assay_name = 'Not The Rack Agent' WHERE id = ?`, [
        slide.id,
      ]);
    },
  },
  {
    id: "racked-slide-was-cut",
    what: "an uncut slide sitting in a staining rack",
    plant: async (page) => {
      const slide = (
        await sql<{ id: number }>(
          page,
          `SELECT sl.id FROM slides sl JOIN slide_stacks ss ON ss.id = sl.stack_id
            WHERE ss.kind = 'stain' AND sl.purpose = 'stain'
              AND sl.current_stage <> 'removed' ORDER BY sl.id LIMIT 1`,
        )
      )[0];
      await write(page, `UPDATE slides SET stage_cut_at = NULL WHERE id = ?`, [slide.id]);
    },
  },
  {
    id: "removed-slide-keeps-its-record",
    what: "a removed slide stained but with its cut date wiped",
    plant: async (page) => {
      const slide = (
        await sql<{ id: number }>(
          page,
          `SELECT id FROM slides WHERE purpose = 'stain' ORDER BY id LIMIT 1`,
        )
      )[0];
      await write(
        page,
        `UPDATE slides SET current_stage = 'removed', stage_stained_at = '2019-07-02 03:11',
                stage_cut_at = NULL WHERE id = ?`,
        [slide.id],
      );
    },
  },
];

test("self-check: every 0.14 rack invariant can actually fail", async ({ page, findings }) => {
  test.setTimeout(900_000);

  let caught = 0;
  const missed: string[] = [];

  for (const poison of POISONS) {
    // A fresh board per poison, so one planted violation cannot mask another and
    // the catalogue is answering about exactly one thing.
    await boot(page);
    await seedLarge(page, { projects: 2, samplesPerProject: 6, cutFraction: 1, seed: 99 });

    const clean: typeof findings = [];
    const before = await checkInvariantsFast(page, clean, "before");
    expect(before, `the board is clean before planting "${poison.what}"`).toBe(0);

    await poison.plant(page);

    const after: typeof findings = [];
    await checkInvariantsFast(page, after, "after");
    const noticed = after.some((f) => f.detail.includes(`INVARIANT ${poison.id}`));
    if (noticed) caught += 1;
    else missed.push(`${poison.id} — planted ${poison.what}, nothing complained`);
  }

  for (const gap of missed) {
    findings.push({
      where: "self-check",
      severity: "defect",
      detail: `INVARIANT NEVER BITES: ${gap}`,
      corroboration:
        "the violation was written straight into the image, so the state definitely existed",
    });
  }
  console.log(`self-check: ${caught}/${POISONS.length} invariants bit when poisoned`);
  expect(missed, "every invariant must be able to fail").toEqual([]);
});
