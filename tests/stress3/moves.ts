import type { Page } from "@playwright/test";
import { sql, callDb } from "../stress2/driver";

/**
 * The move vocabulary.
 *
 * v2's walkers knew twelve moves, all of them inside the slide lifecycle. That
 * is the part of the app the tests were already thinking about, which is exactly
 * why it was the part with fewest bugs left.
 *
 * These add the moves that reach ACROSS it: undo and redo, archiving, renaming a
 * project while its codes are in use, deactivating an agent that open racks
 * depend on, exhausting a block with live work, reverting a block's stage while
 * its slides are downstream. Cross-cutting changes are where assumptions made in
 * one module get invalidated by another, and no per-module test looks there.
 *
 * A move returns null when the state does not permit it, so the walk only ever
 * attempts something plausible.
 */

export type Move = {
  label: string;
  /** Prefer data-layer moves; UI ones set `ui` and are driven by the caller. */
  ui?: boolean;
  plan: (page: Page, random: () => number) => Promise<{ fn: string; args: unknown[] } | "ui" | null>;
};

const AGENTS: Array<[string, string]> = [
  ["stain", "H&E"],
  ["stain", "PAS"],
  ["stain", "Alcian Blue"],
  ["ihc", "CD31"],
  ["ihc", "Ki-67"],
];

/**
 * Pick one candidate row, using the WALKER's seeded generator.
 *
 * Every one of these queries used to end `ORDER BY RANDOM() LIMIT 1` —
 * SQLite's generator, which no seed of ours reaches. So the seed chose which MOVE to make
 * and never which row to make it on, and a run could not be reproduced from its
 * seed at all. The harness advertised reproducibility it did not have, and the
 * first real defect it found could not be re-run to trace it.
 *
 * Queries now end `ORDER BY <stable column>` and the choice is made here, off
 * the same `random()` the walk is driven by.
 */
const one = async <T>(
  page: Page,
  query: string,
  params: unknown[],
  random: () => number,
): Promise<T | null> => {
  const rows = await sql<T>(page, query, params);
  if (rows.length === 0) return null;
  return rows[Math.floor(random() * rows.length)] ?? null;
};

/** The same, for a handful of rows. */
const some = async <T>(
  page: Page,
  query: string,
  params: unknown[],
  random: () => number,
  count: number,
): Promise<T[]> => {
  const rows = await sql<T>(page, query, params);
  const picked: T[] = [];
  const pool = [...rows];
  while (pool.length > 0 && picked.length < count) {
    picked.push(...pool.splice(Math.floor(random() * pool.length), 1));
  }
  return picked;
};

export const MOVES: Move[] = [
  // ---------------------------------------------------------------- lifecycle
  {
    label: "cut a block",
    plan: async (page, random) => {
      const row = await one<{ id: number }>(
        page,
        `SELECT id FROM samples WHERE current_stage = 'embedded' AND block_exhausted = 0
          ORDER BY id`, [], random);
      if (!row) return null;
      const [type, name] = AGENTS[Math.floor(random() * AGENTS.length)];
      return {
        fn: "createSectionRequests",
        args: [
          row.id,
          [
            { duplicates: 1 + Math.floor(random() * 2), stains: "" },
            { duplicates: 1, stains: name, assay_type: type, assay_name: name },
          ],
        ],
      };
    },
  },
  {
    label: "send a group onward",
    plan: async (page, random) => {
      const row = await one<{ id: number }>(
        page,
        `SELECT id FROM section_requests WHERE current_stage = 'needs_sectioning'
          ORDER BY id`, [], random);
      if (!row) return null;
      return {
        fn: "updateSectionStage",
        args: [row.id, random() < 0.5 ? "sectioned" : "stain_requested"],
      };
    },
  },
  {
    label: "revert a group backwards",
    plan: async (page, random) => {
      const row = await one<{ id: number }>(
        page,
        `SELECT id FROM section_requests
          WHERE current_stage NOT IN ('needs_sectioning', 'removed') ORDER BY id`, [], random);
      if (!row) return null;
      // Going backwards is a real feature, and it is where downstream state gets
      // stranded if anything forgot to unwind.
      return { fn: "revertSectionToStage", args: [row.id, "needs_sectioning"] };
    },
  },
  {
    label: "tick or untick a rack step",
    plan: async (page, random) => {
      const row = await one<{ id: number; assay_type: string }>(
        page,
        `SELECT DISTINCT st.id AS id, sl.assay_type AS assay_type
           FROM slide_stacks st JOIN slides sl ON sl.stack_id = st.id
          WHERE st.kind = 'stain' AND st.closed_at IS NULL AND sl.purpose = 'stain'
          ORDER BY id`, [], random);
      if (!row) return null;
      return {
        fn: "syncAssayStackWorkflowStep",
        args: [row.id, row.assay_type, random() < 0.7 ? 0 : 1, random() < 0.8],
      };
    },
  },
  {
    label: "record or unrecord images",
    plan: async (page, random) => {
      const row = await one<{ id: number }>(
        page,
        `SELECT id FROM slides WHERE purpose = 'stain'
            AND current_stage IN ('ready_for_imaging', 'pictures_taken')
          ORDER BY id`, [], random);
      if (!row) return null;
      return { fn: "setSlidePicturesTaken", args: [row.id, random() < 0.8] };
    },
  },
  {
    label: "advance a stack",
    plan: async (page, random) => {
      const row = await one<{ id: number; current_stage: string }>(
        page,
        `SELECT id, current_stage FROM slide_stacks WHERE closed_at IS NULL ORDER BY id`, [], random);
      if (!row) return null;
      const next: Record<string, string> = {
        stain_requested: "ready_for_imaging",
        ready_for_imaging: "pictures_taken",
        pictures_taken: "analyzed",
      };
      const target = next[row.current_stage];
      if (!target) return null;
      return { fn: "updateSlideStackStage", args: [row.id, target] };
    },
  },
  {
    label: "reassign or return a slide",
    plan: async (page, random) => {
      const row = await one<{ id: number }>(
        page,
        `SELECT id FROM slides WHERE purpose = 'stain' AND current_stage <> 'removed'
            AND stage_cut_at IS NOT NULL AND stage_pictures_taken_at IS NULL
          ORDER BY id`, [], random);
      if (!row) return null;
      const [type, name] = AGENTS[Math.floor(random() * AGENTS.length)];
      return {
        fn: "reassignSlide",
        args: [row.id, random() < 0.7 ? { assayType: type, assayName: name } : { extra: true }],
      };
    },
  },
  {
    label: "add one more slide",
    plan: async (page, random) => {
      const row = await one<{ id: number }>(
        page,
        `SELECT id FROM section_requests WHERE current_stage <> 'removed' ORDER BY id`, [], random);
      if (!row) return null;
      const [type, name] = AGENTS[Math.floor(random() * AGENTS.length)];
      return {
        fn: "addSlideToSection",
        args: [row.id, random() < 0.5 ? { extra: true } : { assayType: type, assayName: name }],
      };
    },
  },
  {
    label: "refile onto another block",
    plan: async (page, random) => {
      const row = await one<{ id: number; sample_id: number }>(
        page,
        `SELECT sl.id AS id, sr.sample_id AS sample_id
           FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
          WHERE sl.current_stage <> 'removed' ORDER BY id`, [], random);
      if (!row) return null;
      const other = await one<{ id: number }>(
        page,
        `SELECT id FROM samples WHERE id <> ? ORDER BY id`,
        [row.sample_id], random);
      if (!other) return null;
      return { fn: "relabelSlideToSample", args: [row.id, other.id, "explorer"] };
    },
  },
  {
    label: "remove a slide",
    plan: async (page, random) => {
      const row = await one<{ id: number }>(
        page,
        `SELECT id FROM slides WHERE current_stage <> 'removed' ORDER BY id`, [], random);
      if (!row) return null;
      return { fn: "removeSlide", args: [row.id, "explorer: broke"] };
    },
  },
  {
    label: "ask for a stain",
    plan: async (page, random) => {
      const row = await one<{ id: number }>(
        page, `SELECT id FROM samples ORDER BY id`, [], random);
      if (!row) return null;
      const [type, name] = AGENTS[Math.floor(random() * AGENTS.length)];
      return { fn: "requestStainForSample", args: [{ sampleId: row.id, assayType: type, assayName: name }] };
    },
  },
  {
    label: "withdraw a stain request",
    plan: async (page, random) => {
      const row = await one<{ id: number; pending: string }>(
        page,
        `SELECT id, preselected_stains AS pending FROM samples
          WHERE TRIM(preselected_stains) <> '' AND preselected_stains <> '[]'
          ORDER BY id`, [], random);
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.pending) as Array<{ assay_type?: string; assay_name?: string }>;
        const first = parsed[0];
        if (!first?.assay_name) return null;
        return {
          fn: "withdrawStainRequest",
          args: [row.id, first.assay_type ?? "stain", first.assay_name],
        };
      } catch {
        return null;
      }
    },
  },

  // ------------------------------------------------------------- 0.14 racks
  // Split, merge, bulk reassign and the capacity ceiling shipped with unit and
  // e2e coverage and no fuzzing at all. They move glass between physical
  // holders, which is where the app's worst bugs have always lived.
  {
    label: "split slides into a new rack",
    plan: async (page, random) => {
      // A rack with at least two live slides, since splitting the whole rack is
      // (correctly) refused.
      const rack = await one<{ id: number; held: number }>(
        page,
        `SELECT ss.id AS id, COUNT(sl.id) AS held
           FROM slide_stacks ss
           JOIN slides sl ON sl.stack_id = ss.id AND sl.current_stage <> 'removed'
          WHERE ss.kind = 'stain' AND ss.closed_at IS NULL
          GROUP BY ss.id HAVING held >= 2
          ORDER BY id`,
        [],
        random,
      );
      if (!rack) return null;
      const members = await sql<{ id: number }>(
        page,
        `SELECT id FROM slides
          WHERE stack_id = ? AND current_stage <> 'removed' ORDER BY id`,
        [rack.id],
      );
      // Leave at least one behind — the interesting cases are the legal ones.
      const take = 1 + Math.floor(random() * Math.max(1, members.length - 1));
      return {
        fn: "splitSlidesIntoNewRack",
        args: [members.slice(0, take).map((row) => row.id)],
      };
    },
  },
  {
    label: "merge two racks",
    plan: async (page, random) => {
      // Two open racks for the SAME agent. The data layer refuses the rest, and
      // a move that is always refused exercises nothing.
      const pair = await one<{ a: number; b: number }>(
        page,
        `SELECT a.id AS a, b.id AS b
           FROM slide_stacks a JOIN slide_stacks b
             ON b.kind = 'stain' AND b.id > a.id
            AND b.assay_type = a.assay_type AND b.assay_name = a.assay_name
          WHERE a.kind = 'stain' AND a.closed_at IS NULL AND b.closed_at IS NULL
          ORDER BY a.id`,
        [],
        random,
      );
      if (!pair) return null;
      return { fn: "mergeSlideStacks", args: [[pair.a, pair.b]] };
    },
  },
  {
    label: "move a selection to another agent",
    plan: async (page, random) => {
      const rack = await one<{ id: number }>(
        page,
        `SELECT DISTINCT ss.id AS id FROM slide_stacks ss
           JOIN slides sl ON sl.stack_id = ss.id AND sl.current_stage <> 'removed'
          WHERE ss.kind = 'stain' AND ss.closed_at IS NULL
          ORDER BY id`,
        [],
        random,
      );
      if (!rack) return null;
      const members = await some<{ id: number }>(
        page,
        `SELECT id FROM slides
          WHERE stack_id = ? AND current_stage <> 'removed' AND stage_cut_at IS NOT NULL
          ORDER BY id`,
        [rack.id],
        random,
        1 + Math.floor(random() * 3),
      );
      if (members.length === 0) return null;
      const [type, name] = AGENTS[Math.floor(random() * AGENTS.length)];
      // reassignSlides is the hook's bulk wrapper; the data layer's own loop is
      // reassignSlide, so the fuzz drives that directly, one call per slide.
      return {
        fn: "reassignSlide",
        args: [members[0].id, random() < 0.8 ? { assayType: type, assayName: name } : { extra: true }],
      };
    },
  },
  {
    label: "change the rack ceiling",
    plan: async (page, random) => {
      const settings = await callDb(page, "getAppSettings", []);
      if (!settings.ok) return null;
      const current = settings.value as Record<string, number>;

      // Never BELOW what the board already holds.
      //
      // A lab lowering its ceiling under a rack that is already full is a real
      // thing, and the app deliberately does not retroactively split that rack —
      // so it would leave an over-capacity rack that is not a defect, and the
      // capacity invariant would fire on it every round afterwards. That is a
      // guaranteed false positive, which costs more than the coverage is worth.
      // The ceiling still varies; it just cannot be used to manufacture a
      // violation of the rule it defines.
      const biggest = await one<{ n: number }>(
        page,
        `SELECT COALESCE(MAX(held), 0) AS n FROM (
           SELECT COUNT(sl.id) AS held FROM slide_stacks ss
             JOIN slides sl ON sl.stack_id = ss.id AND sl.current_stage <> 'removed'
            WHERE ss.kind = 'stain' AND ss.closed_at IS NULL
            GROUP BY ss.id)`,
        [],
        () => 0,
      );
      const floor = Math.max(1, Number(biggest?.n ?? 1));
      return {
        fn: "saveAppSettings",
        args: [
          {
            ...current,
            maxStainRackSlides: floor + Math.floor(random() * 6),
            maxIhcRackSlides: floor + Math.floor(random() * 6),
          },
        ],
      };
    },
  },

  // ------------------------------------------------------------ cross-cutting
  // These are the point of v3. Each one changes something OTHER code has already
  // read and is relying on.
  {
    label: "archive or restore a block",
    plan: async (page, random) => {
      const archive = random() < 0.6;
      const row = await one<{ id: number }>(
        page,
        archive
          ? `SELECT id FROM samples WHERE archived_at IS NULL ORDER BY id`
          : `SELECT id FROM samples WHERE archived_at IS NOT NULL ORDER BY id`, [], random);
      if (!row) return null;
      return { fn: "setSampleArchived", args: [row.id, archive] };
    },
  },
  {
    label: "exhaust or un-exhaust a block",
    plan: async (page, random) => {
      const row = await one<{ id: number }>(
        page, `SELECT id FROM samples ORDER BY id`, [], random);
      if (!row) return null;
      return { fn: "setBlockExhausted", args: [row.id, random() < 0.7] };
    },
  },
  {
    label: "rename a project under live work",
    plan: async (page, random) => {
      const row = await one<{ id: number; code: string; name: string }>(
        page,
        `SELECT id, code, name FROM projects ORDER BY id`, [], random);
      if (!row) return null;
      // A new two-letter code that nothing else is using; renaming rewrites every
      // sample and slide code the project owns (#106).
      const letters = "QRSTUVWXYZ";
      const code =
        letters[Math.floor(random() * letters.length)] + letters[Math.floor(random() * letters.length)];
      const clash = await one<{ n: number }>(
        page,
        `SELECT COUNT(*) AS n FROM projects WHERE code = ? AND id <> ?`,
        [code, row.id], random);
      if (Number(clash?.n ?? 0) > 0) return null;
      return {
        fn: "updateProject",
        args: [row.id, { code, name: row.name, team_lead: "", lead_user_id: 0 }],
      };
    },
  },
  {
    label: "deactivate or reactivate a project",
    plan: async (page, random) => {
      const row = await one<{ id: number }>(
        page, `SELECT id FROM projects ORDER BY id`, [], random);
      if (!row) return null;
      return { fn: "setProjectActive", args: [row.id, random() < 0.5] };
    },
  },
  {
    label: "retire or restore an assay agent",
    plan: async (page, random) => {
      const row = await one<{ id: number }>(
        page,
        `SELECT id FROM assay_catalog ORDER BY id`, [], random);
      if (!row) return null;
      // Racks and slides reference agents by NAME, so deactivating one that open
      // racks depend on is exactly the kind of change nothing downstream expects.
      return { fn: "setAssayActive", args: [row.id, random() < 0.5] };
    },
  },
  {
    label: "revert a block's stage",
    plan: async (page, random) => {
      const row = await one<{ id: number }>(
        page,
        `SELECT id FROM samples WHERE current_stage = 'embedded' ORDER BY id`, [], random);
      if (!row) return null;
      // Backwards, while its slides may be downstream in racks.
      return { fn: "revertToStage", args: [row.id, "needs_embedding"] };
    },
  },
  {
    label: "edit a description",
    plan: async (page, random) => {
      const row = await one<{ id: number }>(
        page, `SELECT id FROM samples ORDER BY id`, [], random);
      if (!row) return null;
      const texts = ["re-labelled at the bench", "α-SMA · 切片 · 🧫", "  ", "x".repeat(400)];
      return {
        fn: "setSampleDescription",
        args: [row.id, texts[Math.floor(random() * texts.length)]],
      };
    },
  },
  {
    label: "tag slides at a depth",
    plan: async (page, random) => {
      const rows = await some<{ id: number }>(
        page,
        `SELECT id FROM slides WHERE current_stage <> 'removed' ORDER BY id`,
        [],
        random,
        3,
      );
      if (rows.length === 0) return null;
      return {
        fn: "setSlidesDepthTag",
        args: [rows.map((r) => r.id), `d${Math.floor(random() * 900)}`, "explorer"],
      };
    },
  },
];

/** Moves driven through the real UI, because that is the only honest route. */
export const UI_MOVES = ["undo", "redo"] as const;

export async function runUiMove(page: Page, which: (typeof UI_MOVES)[number]): Promise<string> {
  // Undo lives in React state, not in the data layer, so there is no function to
  // call — and that is the point: this exercises the button a user presses, and
  // the whole-database-image restore behind it.
  const title = which === "undo" ? "Undo (Ctrl+Z)" : "Redo (Ctrl+Y)";
  const button = page.getByTitle(title);
  if ((await button.count()) === 0) return "no control";
  if (await button.isDisabled().catch(() => true)) return "nothing to " + which;
  await button.click({ force: true });
  await page.waitForTimeout(220);
  return "ok";
}

export async function callMove(
  page: Page,
  planned: { fn: string; args: unknown[] },
): Promise<string> {
  const result = await callDb(page, planned.fn, planned.args);
  return result.ok ? "ok" : result.error;
}
