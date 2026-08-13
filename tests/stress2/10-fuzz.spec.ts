import {
  test,
  expect,
  sql,
  count,
  callDb,
  boot,
  seed,
  embed,
  checkInvariants,
  rng,
  pick,
  type Finding,
} from "./driver";
import { INVARIANTS } from "./invariants";

/**
 * A seeded random walk over legal actions, with every invariant checked after
 * every step.
 *
 * v1 tested one clean path at a time — intake, then cutting, then staining —
 * which is how a lab is described but not how one runs. Work interleaves: a
 * block is cut while another is being stained, a slide is reassigned in the
 * middle of a protocol, somebody removes glass from a rack that is half-imaged.
 * Those combinations are where state machines break, and no amount of writing
 * scenarios by hand enumerates them.
 *
 * The seed is printed on every run and on every failure, so any state this
 * reaches can be reached again.
 */

type Action = {
  name: string;
  /** Pick arguments from the live database; return null when not applicable. */
  plan: (page: import("@playwright/test").Page, random: () => number) => Promise<{
    fn: string;
    args: unknown[];
  } | null>;
  /** Errors this action is ALLOWED to return — refusals are correct behaviour. */
  refusals?: RegExp[];
};

const ACTIONS: Action[] = [
  {
    name: "cut a block",
    plan: async (page, random) => {
      const blocks = await sql<{ id: number }>(
        page,
        `SELECT id FROM samples WHERE current_stage = 'embedded' AND block_exhausted = 0`,
      );
      const block = pick(random, blocks);
      if (!block) return null;
      const agents = ["H&E", "PAS", "CD31", "Ki-67", "Alcian Blue"];
      const groups: unknown[] = [];
      const n = 1 + Math.floor(random() * 3);
      for (let i = 0; i < n; i += 1) {
        if (random() < 0.4) {
          groups.push({ duplicates: 1 + Math.floor(random() * 2), stains: "" });
        } else {
          const agent = agents[Math.floor(random() * agents.length)];
          groups.push({
            duplicates: 1,
            stains: agent,
            assay_type: agent === "CD31" || agent === "Ki-67" ? "ihc" : "stain",
            assay_name: agent,
          });
        }
      }
      return { fn: "createSectionRequests", args: [block.id, groups] };
    },
    refusals: [/must be embedded/i, /exhausted/i],
  },
  {
    name: "send a queued group to be cut",
    plan: async (page, random) => {
      const groups = await sql<{ id: number }>(
        page,
        `SELECT id FROM section_requests WHERE current_stage = 'needs_sectioning'`,
      );
      const group = pick(random, groups);
      if (!group) return null;
      return { fn: "updateSectionStage", args: [group.id, "sectioned"] };
    },
  },
  {
    name: "start a rack's protocol step",
    plan: async (page, random) => {
      const racks = await sql<{ id: number; assay_type: string }>(
        page,
        `SELECT DISTINCT st.id AS id, sl.assay_type AS assay_type
           FROM slide_stacks st JOIN slides sl ON sl.stack_id = st.id
          WHERE st.kind = 'stain' AND st.closed_at IS NULL AND sl.purpose = 'stain'`,
      );
      const rack = pick(random, racks);
      if (!rack) return null;
      return {
        fn: "syncAssayStackWorkflowStep",
        args: [rack.id, rack.assay_type, random() < 0.7 ? 0 : 1, true],
      };
    },
  },
  {
    name: "untick a rack's protocol step",
    plan: async (page, random) => {
      const racks = await sql<{ id: number; assay_type: string }>(
        page,
        `SELECT DISTINCT st.id AS id, sl.assay_type AS assay_type
           FROM slide_stacks st JOIN slides sl ON sl.stack_id = st.id
          WHERE st.kind = 'stain' AND st.closed_at IS NULL AND sl.purpose = 'stain'
            AND st.stage_stained_at IS NOT NULL`,
      );
      const rack = pick(random, racks);
      if (!rack) return null;
      return { fn: "syncAssayStackWorkflowStep", args: [rack.id, rack.assay_type, 0, false] };
    },
  },
  {
    name: "reassign a slide to another agent",
    plan: async (page, random) => {
      const slides = await sql<{ id: number }>(
        page,
        `SELECT id FROM slides WHERE purpose = 'stain' AND current_stage <> 'removed'`,
      );
      const slide = pick(random, slides);
      if (!slide) return null;
      const agents = ["H&E", "PAS", "CD31", "Alcian Blue"];
      const agent = agents[Math.floor(random() * agents.length)];
      return {
        fn: "reassignSlide",
        args: [slide.id, { assayType: agent === "CD31" ? "ihc" : "stain", assayName: agent }],
      };
    },
    // "not been cut yet" is the 0.13.1 guard: a planned slide is a line in a
    // plan, not glass, and cannot go on a stainer.
    refusals: [/removed/i, /has not been cut yet/i],
  },
  {
    name: "send a slide back to extras",
    plan: async (page, random) => {
      const slides = await sql<{ id: number }>(
        page,
        `SELECT id FROM slides WHERE purpose = 'stain' AND current_stage <> 'removed'`,
      );
      const slide = pick(random, slides);
      if (!slide) return null;
      return { fn: "reassignSlide", args: [slide.id, { extra: true }] };
    },
    refusals: [/removed/i],
  },
  {
    name: "add one more slide to a cut",
    plan: async (page, random) => {
      const groups = await sql<{ id: number }>(page, `SELECT id FROM section_requests`);
      const group = pick(random, groups);
      if (!group) return null;
      return {
        fn: "addSlideToSection",
        args: [
          group.id,
          random() < 0.5 ? { extra: true } : { assayType: "stain", assayName: "H&E" },
        ],
      };
    },
  },
  {
    name: "record images for a slide",
    plan: async (page, random) => {
      const slides = await sql<{ id: number }>(
        page,
        `SELECT id FROM slides WHERE purpose = 'stain' AND current_stage = 'ready_for_imaging'`,
      );
      const slide = pick(random, slides);
      if (!slide) return null;
      return { fn: "setSlidePicturesTaken", args: [slide.id, random() < 0.8] };
    },
    refusals: [/Only stain or IHC slides/i],
  },
  {
    name: "advance a stack",
    plan: async (page, random) => {
      const stacks = await sql<{ id: number; current_stage: string }>(
        page,
        `SELECT id, current_stage FROM slide_stacks WHERE closed_at IS NULL`,
      );
      const stack = pick(random, stacks);
      if (!stack) return null;
      const next: Record<string, string> = {
        stain_requested: "ready_for_imaging",
        ready_for_imaging: "pictures_taken",
        pictures_taken: "analyzed",
      };
      const target = next[stack.current_stage];
      if (!target) return null;
      return { fn: "updateSlideStackStage", args: [stack.id, target] };
    },
    // Refusing to complete imaging while a member has no images is the 0.13.0
    // fix, so it is an expected outcome here, not a failure.
    refusals: [/no images captured yet/i, /Unknown slide-stack stage/i],
  },
  {
    name: "remove a slide with a reason",
    plan: async (page, random) => {
      const slides = await sql<{ id: number }>(
        page,
        `SELECT id FROM slides WHERE current_stage <> 'removed'`,
      );
      const slide = pick(random, slides);
      if (!slide) return null;
      return { fn: "removeSlide", args: [slide.id, "fuzz: broke at the bench"] };
    },
  },
  {
    name: "refile a slide onto another block",
    plan: async (page, random) => {
      const slides = await sql<{ id: number; sample_id: number }>(
        page,
        `SELECT sl.id AS id, sr.sample_id AS sample_id
           FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
          WHERE sl.current_stage <> 'removed'`,
      );
      const slide = pick(random, slides);
      if (!slide) return null;
      const others = await sql<{ id: number }>(
        page,
        `SELECT id FROM samples WHERE id <> ?`,
        [slide.sample_id],
      );
      const target = pick(random, others);
      if (!target) return null;
      return { fn: "relabelSlideToSample", args: [slide.id, target.id, "fuzz: wrong block"] };
    },
    refusals: [/already filed/i, /removed/i, /no longer exists/i],
  },
  {
    name: "ask for a stain on a block",
    plan: async (page, random) => {
      const blocks = await sql<{ id: number }>(page, `SELECT id FROM samples`);
      const block = pick(random, blocks);
      if (!block) return null;
      const agents = ["H&E", "PAS", "CD31"];
      const agent = agents[Math.floor(random() * agents.length)];
      return {
        fn: "requestStainForSample",
        args: [
          { sampleId: block.id, assayType: agent === "CD31" ? "ihc" : "stain", assayName: agent },
        ],
      };
    },
    refusals: [/exhausted/i, /cannot be cut again/i],
  },
  {
    name: "mark a block exhausted",
    plan: async (page, random) => {
      const blocks = await sql<{ id: number }>(
        page,
        `SELECT id FROM samples WHERE block_exhausted = 0`,
      );
      const block = pick(random, blocks);
      if (!block) return null;
      return { fn: "setBlockExhausted", args: [block.id, true] };
    },
  },
];

test("fuzz: a seeded random walk, with every invariant checked after every step", async ({
  page,
  consoleErrors,
  findings,
}) => {
  // Fixed by default so a run is reproducible and comparable; override with
  // STRESS_SEED to explore elsewhere.
  const seedValue = Number(process.env.STRESS_SEED ?? 20260813);
  const steps = Number(process.env.STRESS_STEPS ?? 220);
  const random = rng(seedValue);
  console.log(`\nfuzz seed=${seedValue} steps=${steps}  (STRESS_SEED=… to change)\n`);

  await boot(page);
  await seed(page, { projects: 2, samplesPerProject: 4 });

  const blocks = await sql<{ id: number }>(page, `SELECT id FROM samples ORDER BY id`);
  for (const block of blocks) await embed(page, block.id);

  const before = await checkInvariants(page, findings, "before the walk");
  expect(before, "the seeded board must start clean").toBe(0);

  const tally = new Map<string, { ok: number; refused: number; failed: number }>();
  const unexpected: string[] = [];
  // A violation is attributed to the step that introduced it, which is the whole
  // value of checking after EVERY action rather than at the end.
  const firstViolation: Array<{ step: number; action: string; findings: Finding[] }> = [];

  for (let step = 1; step <= steps; step += 1) {
    const action = ACTIONS[Math.floor(random() * ACTIONS.length)];
    const planned = await action.plan(page, random);
    if (!planned) continue;

    const stat = tally.get(action.name) ?? { ok: 0, refused: 0, failed: 0 };
    const result = await callDb(page, planned.fn, planned.args);

    if (result.ok) {
      stat.ok += 1;
    } else if ((action.refusals ?? []).some((re) => re.test(result.error))) {
      stat.refused += 1;
    } else {
      stat.failed += 1;
      if (unexpected.length < 8) {
        unexpected.push(`${action.name} → ${planned.fn}: ${result.error}`);
      }
    }
    tally.set(action.name, stat);

    const stepFindings: Finding[] = [];
    const broken = await checkInvariants(page, stepFindings, `step ${step} (${action.name})`);
    if (broken > 0 && firstViolation.length < 3) {
      firstViolation.push({ step, action: action.name, findings: stepFindings });
      findings.push(...stepFindings);
    }
    if (broken > 0) break;
  }

  const summary = [...tally.entries()]
    .map(([name, s]) => `${name}: ${s.ok} ok/${s.refused} refused/${s.failed} failed`)
    .join("; ");
  findings.push({ where: "fuzz", severity: "observation", detail: `seed ${seedValue} — ${summary}` });

  if (unexpected.length > 0) {
    findings.push({
      where: "fuzz",
      severity: "defect",
      detail: `actions failed with errors that are not documented refusals: ${JSON.stringify(unexpected)}`,
      corroboration:
        "Each string is the message db.ts threw. An action that is legal in the state " +
        "the fuzzer found it in should either succeed or refuse for a stated reason.",
    });
  }

  const final = await sql<{ n: number }>(
    page,
    `SELECT (SELECT COUNT(*) FROM slides) AS n`,
  );
  findings.push({
    where: "fuzz",
    severity: "observation",
    detail: `ended with ${final[0]?.n ?? 0} slides across ${await count(
      page,
      `SELECT COUNT(*) FROM section_requests`,
    )} cut groups and ${await count(page, `SELECT COUNT(*) FROM slide_stacks`)} stacks`,
  });

  expect(
    firstViolation,
    firstViolation.length
      ? `invariant broken at step ${firstViolation[0].step} by "${firstViolation[0].action}" — rerun with STRESS_SEED=${seedValue}`
      : "",
  ).toEqual([]);
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("fuzz: the invariant catalogue can actually fail", async ({ page, findings }) => {
  // v1's fifteen invariants never fired once across twenty-one tests, and I had
  // no way to tell "the app is correct" from "the probes are blind". So: plant a
  // violation of each invariant and insist the catalogue notices. An invariant
  // that cannot fail is not a test, it is a comment.
  await boot(page);
  await seed(page, { projects: 1, samplesPerProject: 2 });
  const blocks = await sql<{ id: number }>(page, `SELECT id FROM samples ORDER BY id`);
  for (const block of blocks) await embed(page, block.id);
  await callDb(page, "createSectionRequests", [
    blocks[0].id,
    [{ duplicates: 2, stains: "H&E", assay_type: "stain", assay_name: "H&E" }],
  ]);
  // Send the group so its slides land in a rack. Without this, the fixture has
  // no slide with a stack_id and the `removed-slide-holds-no-place` poison
  // silently updates nothing — which the self-check caught as a blind
  // invariant, and which was really an untested probe.
  const groups = await sql<{ id: number }>(page, `SELECT id FROM section_requests ORDER BY id`);
  // `stain_requested` is the stage that attaches slides to their agents' racks
  // (attachSectionStainSlidesToRacks); `sectioned` alone leaves them loose.
  for (const group of groups) {
    await callDb(page, "updateSectionStage", [group.id, "sectioned"]);
    await callDb(page, "updateSectionStage", [group.id, "stain_requested"]);
  }
  expect(
    await count(page, `SELECT COUNT(*) FROM slides WHERE stack_id IS NOT NULL`),
    "the fixture must have slides in racks for the rack poisons to mean anything",
  ).toBeGreaterThan(0);

  const clean = await checkInvariants(page, [], "baseline");
  expect(clean, "the fixture starts clean").toBe(0);

  // Each poison is a single UPDATE that should trip exactly one invariant.
  const poisons: Array<{ id: string; sql: string }> = [
    {
      id: "analyzed-implies-imaged",
      sql: `UPDATE slides SET stage_analyzed_at = '2019-07-02 03:11',
                              stage_pictures_taken_at = NULL
             WHERE id = (SELECT MIN(id) FROM slides)`,
    },
    {
      id: "stained-implies-cut",
      sql: `UPDATE slides SET stage_stained_at = '2019-07-02 03:11', stage_cut_at = NULL
             WHERE id = (SELECT MIN(id) FROM slides)`,
    },
    {
      id: "stage-order-monotone",
      sql: `UPDATE slides SET stage_cut_at = '2020-01-01 10:00',
                              stage_stained_at = '2019-01-01 10:00'
             WHERE id = (SELECT MIN(id) FROM slides)`,
    },
    // NOTE: `slide-code-unique` is deliberately absent from this list. Trying to
    // plant it fails with `UNIQUE constraint failed: slides.slide_code` — the
    // schema (0004) enforces it, so the invariant can never fire and is a
    // belt-and-braces read rather than a live check. Worth keeping, worth
    // knowing it is structural.
    {
      id: "request-is-immutable",
      sql: `UPDATE slides SET requested_assay_name = '' WHERE purpose = 'stain'`,
    },
    {
      id: "removed-slide-holds-no-place",
      sql: `UPDATE slides SET current_stage = 'removed'
             WHERE id = (SELECT MIN(id) FROM slides WHERE stack_id IS NOT NULL)`,
    },
    {
      id: "extra-claims-no-agent",
      sql: `UPDATE slides SET purpose = 'extra', assay_name = 'H&E'
             WHERE id = (SELECT MIN(id) FROM slides)`,
    },
    {
      id: "stain-slide-names-its-agent",
      sql: `UPDATE slides SET assay_name = '' WHERE purpose = 'stain'`,
    },
  ];

  const blind: string[] = [];
  for (const poison of poisons) {
    // Snapshot, poison, check, restore — so each probe is tested alone.
    const snapshot = await sql<Record<string, unknown>>(page, `SELECT * FROM slides`);
    await page.evaluate(
      ([statement]) =>
        (window as unknown as { __SHIM_SQL__: (q: string) => void }).__SHIM_SQL__(statement as string),
      [poison.sql] as const,
    );
    const caught: Finding[] = [];
    await checkInvariants(page, caught, "poisoned");
    const noticed = caught.some((f) => f.detail.includes(poison.id));
    if (!noticed) blind.push(poison.id);

    // Put it back.
    await page.evaluate(
      ([rows]) => {
        const w = window as unknown as { __SHIM_SQL__: (q: string, b?: unknown[]) => void };
        w.__SHIM_SQL__("DELETE FROM slides");
        for (const row of rows as Array<Record<string, unknown>>) {
          const cols = Object.keys(row);
          w.__SHIM_SQL__(
            `INSERT INTO slides (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
            cols.map((c) => row[c]),
          );
        }
      },
      [snapshot] as const,
    );
    const restored = await checkInvariants(page, [], "restored");
    expect(restored, `restoring after ${poison.id} must return to clean`).toBe(0);
  }

  findings.push({
    where: "self-check",
    severity: blind.length ? "defect" : "observation",
    detail: blind.length
      ? `${blind.length} invariant(s) did not notice a planted violation: ${blind.join(", ")}`
      : `all ${poisons.length} planted violations were caught — the catalogue can fail`,
    corroboration: `${INVARIANTS.length} invariants in the catalogue`,
  });
  expect(blind, "an invariant that cannot fail is a comment, not a test").toEqual([]);
});
