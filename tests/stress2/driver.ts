import { test as base, expect, type Page } from "@playwright/test";
import { INVARIANTS } from "./invariants";

/**
 * Harness v2 driver.
 *
 * Three disciplines v1 did not have, each one earned:
 *
 *  · **Sentinels.** `nowTimestamp()` stores minutes (`YYYY-MM-DD HH:MM`), so two
 *    actions in the same minute are indistinguishable in the database. v1 read a
 *    stain date as "kept" when it had been overwritten, purely because both
 *    values landed in the same minute. Nothing here concludes "unchanged" from a
 *    value the action under test could have written; preservation is only ever
 *    checked against a planted sentinel far outside the run.
 *  · **Falsification.** Every finding is re-derived a second way before it is
 *    recorded. All four of v1's false positives were single-source claims.
 *  · **Reproducibility.** The fuzzer's RNG is seeded and the seed is printed, so
 *    a failure is a command line, not a story.
 */

export type Finding = {
  where: string;
  detail: string;
  /** How the claim was checked twice. Absent = a plain observation, not a claim. */
  corroboration?: string;
  severity?: "defect" | "observation";
};

type Fixtures = {
  consoleErrors: string[];
  findings: Finding[];
};

export const test = base.extend<Fixtures>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(`UNCAUGHT: ${e.message}`));
    await use(errors);
  },
  findings: async ({}, use, testInfo) => {
    const findings: Finding[] = [];
    await use(findings);
    if (findings.length) {
      const text = findings
        .map((f) => {
          const tag = f.severity === "defect" ? "DEFECT" : "note";
          const corr = f.corroboration ? `\n      ↳ corroborated: ${f.corroboration}` : "";
          return `  · [${tag}] [${f.where}] ${f.detail}${corr}`;
        })
        .join("\n");
      console.log(`\nFINDINGS — ${testInfo.title}\n${text}\n`);
      await testInfo.attach("findings", { body: JSON.stringify(findings, null, 2) });
    }
  },
});

export { expect };

// ---------------------------------------------------------------------------
// Database access
// ---------------------------------------------------------------------------

export async function sql<T = Record<string, unknown>>(
  page: Page,
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await page.evaluate(
    ([q, p]) =>
      (
        window as unknown as { __SHIM_SELECT__: (s: string, b?: unknown[]) => unknown[] }
      ).__SHIM_SELECT__(q as string, p as unknown[]),
    [query, params] as const,
  )) as T[];
}

export async function count(page: Page, query: string, params: unknown[] = []): Promise<number> {
  const rows = await sql<Record<string, number>>(page, query, params);
  const first = rows[0];
  if (!first) return 0;
  return Number(Object.values(first)[0] ?? 0);
}

/** Write directly to the image — for planting states the app produced earlier. */
export async function write(page: Page, statement: string, params: unknown[] = []): Promise<void> {
  await page.evaluate(
    ([s, p]) =>
      (window as unknown as { __SHIM_SQL__: (q: string, b?: unknown[]) => void }).__SHIM_SQL__(
        s as string,
        p as unknown[],
      ),
    [statement, params] as const,
  );
}

/**
 * Call a `db.ts` export in the page, and report what happened.
 *
 * The fuzzer drives this layer rather than the UI: it reaches far more of the
 * state space per second, and every invariant is checked against the same image
 * the UI is rendering. The UI paths are covered by the other v2 specs and by the
 * whole of v1 — this is the part v1 could not do at all.
 */
export async function callDb<T = unknown>(
  page: Page,
  fn: string,
  args: unknown[],
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return (await page.evaluate(
    async ([name, params]) => {
      try {
        const mod = (await import("/src/lib/db.ts")) as unknown as Record<
          string,
          (...a: unknown[]) => Promise<unknown>
        >;
        const target = mod[name as string];
        if (typeof target !== "function") {
          return { ok: false as const, error: `db.ts has no export named ${name}` };
        }
        const value = await target(...(params as unknown[]));
        return { ok: true as const, value };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [fn, args] as const,
  )) as { ok: true; value: T } | { ok: false; error: string };
}

// ---------------------------------------------------------------------------
// Sentinels — the v1 lesson
// ---------------------------------------------------------------------------

/**
 * A timestamp the code under test could not possibly have written.
 *
 * Preservation is only meaningful against one of these. `nowTimestamp()` writes
 * `YYYY-MM-DD HH:MM`, so anything stamped during a test run shares a minute with
 * everything else in that run — "before === after" proves nothing at all. A date
 * in 2019 does.
 */
export function sentinelTime(nth = 0): string {
  const day = String(2 + (nth % 26)).padStart(2, "0");
  const hour = String(3 + (nth % 17)).padStart(2, "0");
  return `2019-07-${day} ${hour}:11`;
}

/** True when a value is one of ours, i.e. survived rather than being rewritten. */
export function isSentinel(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("2019-07-");
}

// ---------------------------------------------------------------------------
// Falsification — the other v1 lesson
// ---------------------------------------------------------------------------

/**
 * Record a finding only after trying to disprove it.
 *
 * `claim` is what appears to be wrong. `disprove` re-checks it by a DIFFERENT
 * route — a second query, the UI instead of the database, or the inverse
 * question. If the second route disagrees, nothing is recorded except a note
 * that the two disagreed, which is itself worth knowing and is exactly what v1
 * had no way to say.
 */
export async function claim(
  findings: Finding[],
  where: string,
  detail: string,
  disprove: () => Promise<{ holds: boolean; how: string }>,
): Promise<boolean> {
  const second = await disprove();
  if (!second.holds) {
    findings.push({
      where,
      severity: "observation",
      detail: `NOT REPORTED — "${detail}" did not survive a second check`,
      corroboration: second.how,
    });
    return false;
  }
  findings.push({ where, severity: "defect", detail, corroboration: second.how });
  return true;
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

export async function checkInvariants(
  page: Page,
  findings: Finding[],
  where: string,
): Promise<number> {
  let broken = 0;
  for (const inv of INVARIANTS) {
    const rows = await sql(page, inv.query);
    if (rows.length > 0) {
      broken += 1;
      findings.push({
        where,
        severity: "defect",
        detail: `INVARIANT ${inv.id} — ${inv.claim}. ${rows.length} violation(s): ${JSON.stringify(
          rows.slice(0, 4),
        )}`,
        corroboration: inv.because,
      });
    }
  }
  return broken;
}

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/** mulberry32 — small, fast, and identical across runs for a given seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, items: T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(random() * items.length)];
}

// ---------------------------------------------------------------------------
// Setup — the smallest path to a board with work on it
// ---------------------------------------------------------------------------

export async function boot(page: Page, user = "Alex Rivera"): Promise<void> {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: /Manage users/ })
    .click();
  await page.getByPlaceholder("Alex Rivera").fill(user);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Signed-in user").locator("option", { hasText: user })).toHaveCount(1);
  await page.keyboard.press("Escape");
  const overlay = page.locator("div.fixed.inset-0.z-50");
  if (await overlay.count()) await overlay.first().click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
  await page.getByLabel("Signed-in user").selectOption({ label: user });
}

/**
 * Build a board at the data layer.
 *
 * Deliberately not through the UI: v1 spent most of its wall-clock dragging
 * cards to reach states, which capped how much state it could explore. The UI
 * paths are what v1 and `tests/e2e` are for; this exists so v2 can spend its
 * time on the states themselves.
 */
export async function seed(
  page: Page,
  opts: { projects?: number; samplesPerProject?: number } = {},
): Promise<void> {
  const projects = opts.projects ?? 2;
  const per = opts.samplesPerProject ?? 4;
  const codes = ["AA", "BB", "CC", "DD"];
  for (let p = 0; p < projects; p += 1) {
    const created = await callDb<number>(page, "addProject", [
      { code: codes[p], name: `Project ${codes[p]}`, team_lead: "", is_active: true, lead_user_id: 0 },
    ]);
    if (!created.ok) throw new Error(`could not seed project: ${created.error}`);
  }
  const projectRows = await sql<{ id: number; code: string }>(
    page,
    `SELECT id, code FROM projects ORDER BY id`,
  );
  for (const project of projectRows) {
    for (let i = 0; i < per; i += 1) {
      const made = await callDb(page, "addSample", [
        {
          project_id: project.id,
          sample_description: `${project.code} block ${i + 1}`,
          // Capitalised: the column has a CHECK constraint on exactly these.
          processing_type: i % 2 ? "Long" : "Short",
          fixative_agent: "Z-Fix",
          needs_decalcification: 0,
          cut_notes: "",
          slide_notes: "",
          embedding_notes: "",
          stains: "",
          preselected_stains: [],
          overall_notes: "",
        },
        project.code,
      ]);
      if (!made.ok) throw new Error(`could not seed sample: ${made.error}`);
    }
  }
}

/** Drive a block to Embedded Inventory at the data layer. */
export async function embed(page: Page, sampleId: number): Promise<void> {
  for (const stage of [
    "in_fixative",
    "fixative_removed",
    "in_ethanol",
    "processing_started",
    "processed",
    "picked_up",
    "needs_embedding",
    "embedded",
  ]) {
    const moved = await callDb(page, "updateSampleStage", [sampleId, stage]);
    if (!moved.ok && stage === "embedded") throw new Error(`could not embed: ${moved.error}`);
  }
}

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

/**
 * Run every invariant in ONE round trip.
 *
 * The per-invariant version costs 19 `page.evaluate` calls per check, which is
 * fine for a spec that checks a handful of times and ruinous for a swarm that
 * checks after every round of every walker. Same queries, same meaning, one
 * crossing of the process boundary.
 */
export async function checkInvariantsFast(
  page: Page,
  findings: Finding[],
  where: string,
): Promise<number> {
  const results = (await page.evaluate((invs) => {
    const select = (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] })
      .__SHIM_SELECT__;
    return (invs as Array<{ id: string; query: string }>).map((inv) => {
      try {
        const rows = select(inv.query);
        return { id: inv.id, rows: rows.slice(0, 4), n: rows.length };
      } catch (e) {
        return { id: inv.id, error: e instanceof Error ? e.message : String(e), n: -1 };
      }
    });
  }, INVARIANTS.map((i) => ({ id: i.id, query: i.query })))) as Array<{
    id: string;
    rows?: unknown[];
    n: number;
    error?: string;
  }>;

  let broken = 0;
  for (const result of results) {
    if (result.n === 0) continue;
    const inv = INVARIANTS.find((i) => i.id === result.id);
    broken += 1;
    findings.push({
      where,
      severity: "defect",
      detail:
        result.n < 0
          ? `INVARIANT ${result.id} could not run: ${result.error}`
          : `INVARIANT ${result.id} — ${inv?.claim}. ${result.n} violation(s): ${JSON.stringify(
              result.rows,
            )}`,
      corroboration: inv?.because,
    });
  }
  return broken;
}

/**
 * Build a LARGE board in one round trip.
 *
 * Seeding 150 blocks a call at a time is ~1,300 crossings of the process
 * boundary and most of the run's wall clock. The whole loop runs inside the
 * page instead — still every real `db.ts` function, still every guard, just not
 * paying for a round trip per step.
 */
export async function seedLarge(
  page: Page,
  opts: { projects: number; samplesPerProject: number; cutFraction?: number; seed?: number },
): Promise<{ samples: number; slides: number; ms: number }> {
  return (await page.evaluate(async (o) => {
    const started = performance.now();
    // The BOARD has to be seeded too, not just the walk.
    //
    // This used Math.random to decide which blocks get cut, so every run walked
    // a different board while the harness advertised itself as reproducible —
    // and a failure could not be re-run from its seed, which is the whole point
    // of having one. mulberry32 again, same as the walker's rng().
    let seedState = (o.seed ?? 20260101) >>> 0;
    const random = () => {
      seedState = (seedState + 0x6d2b79f5) >>> 0;
      let x = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const mod = (await import("/src/lib/db.ts")) as unknown as Record<string, Function>;
    const codes = ["AA", "BB", "CC", "DD", "EE", "FF", "GG", "HH"];
    const agents: Array<[string, string]> = [
      ["stain", "H&E"],
      ["stain", "PAS"],
      ["stain", "Alcian Blue"],
      ["ihc", "CD31"],
      ["ihc", "Ki-67"],
    ];
    const stages = [
      "in_fixative",
      "fixative_removed",
      "in_ethanol",
      "processing_started",
      "processed",
      "picked_up",
      "needs_embedding",
      "embedded",
    ];

    for (let p = 0; p < o.projects; p += 1) {
      await mod.addProject({
        code: codes[p % codes.length] + (p >= codes.length ? String(p) : ""),
        name: `Project ${p + 1}`,
        team_lead: "",
        is_active: true,
        lead_user_id: 0,
      });
    }
    const projects = (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] })
      .__SHIM_SELECT__("SELECT id, code FROM projects ORDER BY id") as Array<{
      id: number;
      code: string;
    }>;

    let n = 0;
    for (const project of projects) {
      for (let i = 0; i < o.samplesPerProject; i += 1) {
        const id = (await mod.addSample(
          {
            project_id: project.id,
            sample_description: `${project.code} block ${i + 1}`,
            processing_type: i % 2 ? "Long" : "Short",
            fixative_agent: "Z-Fix",
            needs_decalcification: 0,
            cut_notes: "",
            slide_notes: "",
            embedding_notes: "",
            stains: "",
            preselected_stains: [],
            overall_notes: "",
          },
          project.code,
        )) as number;
        for (const stage of stages) await mod.updateSampleStage(id, stage);

        // Most blocks get cut, so the board has real work at every stage rather
        // than a thousand identical embedded blocks.
        if (random() < (o.cutFraction ?? 0.7)) {
          const groups: unknown[] = [];
          const count = 1 + (n % 3);
          for (let g = 0; g <= count; g += 1) {
            if ((n + g) % 3 === 0) {
              groups.push({ duplicates: 1 + (g % 2), stains: "" });
            } else {
              const [type, name] = agents[(n + g) % agents.length];
              groups.push({ duplicates: 1, stains: name, assay_type: type, assay_name: name });
            }
          }
          const sections = (await mod.createSectionRequests(id, groups)) as number[];
          // Send roughly half of them, so Needs Sectioning is populated too.
          if (n % 2 === 0) {
            for (const section of sections) {
              await mod.updateSectionStage(section, "sectioned");
              await mod.updateSectionStage(section, "stain_requested");
            }
          }
        }
        n += 1;
      }
    }

    const select = (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] })
      .__SHIM_SELECT__;
    const samples = (select("SELECT COUNT(*) AS n FROM samples") as Array<{ n: number }>)[0].n;
    const slides = (select("SELECT COUNT(*) AS n FROM slides") as Array<{ n: number }>)[0].n;
    return { samples, slides, ms: Math.round(performance.now() - started) };
  }, opts)) as { samples: number; slides: number; ms: number };
}
