import { test as base, expect, type Page } from "@playwright/test";

/**
 * Stress-suite scaffolding.
 *
 * Two things make this different from `tests/e2e`:
 *
 *  1. **Every test watches the console.** A workflow app can look perfectly
 *     correct while throwing on every render; the functional suite only looks
 *     at what it asserts. Here a page error is a finding.
 *  2. **Every test can read the database.** Most of what goes wrong in a lab
 *     tracker is invisible on screen — an orphaned slide, a rack left open with
 *     nothing in it, a code issued twice, a stage timestamp that moved
 *     backwards. Only a query finds those, so `sql()` runs one against the very
 *     SQLite image the app is using (`window.__SHIM_SELECT__`, test-only).
 */

export type Finding = { where: string; detail: string };

type Fixtures = {
  /** Console errors + uncaught exceptions seen during the test. */
  consoleErrors: string[];
  /** Non-fatal observations to print at the end of the run. */
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
      const text = findings.map((f) => `  · [${f.where}] ${f.detail}`).join("\n");
      console.log(`\nFINDINGS — ${testInfo.title}\n${text}\n`);
      await testInfo.attach("findings", { body: JSON.stringify(findings, null, 2) });
    }
  },
});

export { expect };

/** Run a read-only query against the app's live SQLite image. */
export async function sql<T = Record<string, unknown>>(
  page: Page,
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await page.evaluate(
    ([q, p]) =>
      (
        window as unknown as {
          __SHIM_SELECT__: (s: string, b?: unknown[]) => unknown[];
        }
      ).__SHIM_SELECT__(q as string, p as unknown[]),
    [query, params] as const,
  )) as T[];
}

/** Single-value convenience for COUNT(*)-shaped queries. */
export async function count(page: Page, query: string, params: unknown[] = []): Promise<number> {
  const rows = await sql<{ n: number }>(page, query, params);
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Board geography
// ---------------------------------------------------------------------------

export const column = (page: Page, title: string) =>
  page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });

export const drawer = (page: Page) =>
  page.locator("div.border-l").filter({ has: page.getByRole("heading", { name: "Timeline" }) });

/** Close whatever drawer is open, if one is. */
export async function closeDrawer(page: Page): Promise<void> {
  const panel = drawer(page);
  if (await panel.count()) {
    await panel.locator("button:has(svg.lucide-x)").first().click();
    await expect(panel).toHaveCount(0);
  }
}

/**
 * Open a tile's drawer without the coin-flip.
 *
 * Clicking an already-selected tile toggles the drawer SHUT (#61), so a bare
 * click is only right half the time. This closes first, then opens.
 */
export async function openTile(page: Page, text: string, queue?: string): Promise<void> {
  await closeDrawer(page);
  const scope = queue ? column(page, queue) : page;
  await scope.getByText(text, { exact: true }).first().click();
  await expect(drawer(page)).toHaveCount(1);
}

// dnd-kit PointerSensor: pass the 5px activation threshold, step onto the
// target, settle, release — then wait out the 50ms click suppression.
export async function dragOnto(page: Page, sourceText: string, columnTitle: string): Promise<void> {
  const card = page.getByText(sourceText, { exact: true }).first();
  const header = page.getByRole("heading", { name: columnTitle, exact: true });
  const from = await card.boundingBox();
  const to = await header.boundingBox();
  if (!from || !to) throw new Error(`drag endpoints missing for ${sourceText} → ${columnTitle}`);
  const dropX = to.x + to.width / 2;
  const dropY = to.y + 140;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 4 });
  await page.mouse.move(dropX, dropY, { steps: 10 });
  await page.mouse.move(dropX, dropY + 2, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(120);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

export async function closeSettings(page: Page): Promise<void> {
  await page.getByRole("dialog", { name: "Settings" }).press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
}

export async function addUser(page: Page, name: string): Promise<void> {
  await openSettings(page);
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: /Manage users/ })
    .click();
  await page.getByPlaceholder("Alex Rivera").fill(name);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Signed-in user").locator("option", { hasText: name })).toHaveCount(1);
  await page.keyboard.press("Escape");
  const overlay = page.locator("div.fixed.inset-0.z-50");
  if (await overlay.count()) await overlay.first().click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
}

export async function signIn(page: Page, name: string): Promise<void> {
  await page.getByLabel("Signed-in user").selectOption({ label: name });
}

export async function boot(page: Page, user = "Alex Rivera"): Promise<void> {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 30_000,
  });
  await addUser(page, user);
  await signIn(page, user);
}

export async function addProject(page: Page, code: string, name: string): Promise<void> {
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill(code);
  await page.locator('input[placeholder="Enthesis Engineering"]').fill(name);
  await page.getByRole("button", { name: "Save Project" }).click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toHaveCount(0);
}

export async function selectProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

/**
 * Create `quantity` samples in the selected project.
 *
 * `descriptions` fills the per-sample rows that appear for quantity > 1; a
 * single string goes in the one Description field.
 */
export async function newSamples(
  page: Page,
  opts: {
    quantity?: number;
    description?: string;
    descriptions?: string[];
    processing?: "short" | "long";
    stains?: string[];
  } = {},
): Promise<void> {
  const quantity = opts.quantity ?? 1;
  await page.getByRole("button", { name: "New Sample" }).click();
  const dialog = page.getByRole("dialog", { name: /New Sample/ });
  await expect(dialog).toBeVisible();
  if (quantity > 1) await dialog.getByLabel("Quantity").fill(String(quantity));
  if (opts.description) {
    await dialog.getByPlaceholder("e.g. 2 week Stretch PLA").fill(opts.description);
  }
  if (opts.descriptions?.length) {
    await dialog.getByLabel("Paste one description per line").fill(opts.descriptions.join("\n"));
  }
  if (opts.processing === "long") {
    await dialog.locator("select").filter({ hasText: "Long" }).first().selectOption(/long/i);
  }
  for (const stain of opts.stains ?? []) {
    await dialog.getByRole("button", { name: stain, exact: true }).click();
  }
  await dialog.getByRole("button", { name: /^Create \d* ?Samples?$/ }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Walk a block's pre-processing checklist to in_ethanol. */
export async function preprocess(page: Page, code: string): Promise<void> {
  await openTile(page, code);
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await closeDrawer(page);
}

/**
 * Run one processing batch over `codes`, ending with every block in Embedded
 * Inventory. The first code is dragged in; the rest are added to the same run
 * from the batch drawer's candidate list.
 */
export async function runBatch(page: Page, codes: string[], batchLabel: string): Promise<void> {
  for (const code of codes) await preprocess(page, code);
  // Tick them all, then drag one: the board carries the whole selection, which
  // is how a technician loads a processor with a dozen cassettes at once.
  await closeDrawer(page);
  for (const code of codes) {
    await column(page, "Pre-processing").getByRole("checkbox", { name: `Select ${code}` }).check();
  }
  await dragOnto(page, codes[0], "Processor");
  await expect(page.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText(batchLabel, { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await dragOnto(page, batchLabel, "Needs Embedding");
  await clearSelection(page);
  // Embed via the drawer's own button rather than a drag. Both routes exist and
  // both are exercised — the drag path has its own test — but a fill of this
  // size cannot afford a drop that lands a pixel wide of a column.
  for (const code of codes) {
    await openTile(page, code, "Needs Embedding");
    await page.getByRole("button", { name: /Mark Embedded/ }).click();
    await closeDrawer(page);
    await expect(column(page, "Embedded Inventory").getByText(code, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  }
}

/** Untick every selected card. Board selection survives drags and view changes. */
export async function clearSelection(page: Page): Promise<void> {
  const boxes = page.getByRole("checkbox", { name: /^Select / });
  for (let i = 0; i < (await boxes.count()); i += 1) {
    const box = boxes.nth(i);
    if (await box.isChecked().catch(() => false)) await box.uncheck();
  }
}

/**
 * Send a block for cutting.
 *
 * `plan` is one entry per slide: "extra", or `stain::H&E` / `ihc::CD31`.
 * `save` stops at Save Plan instead of sending.
 */
export async function sendForCutting(
  page: Page,
  code: string,
  plan: string[],
  opts: { save?: boolean } = {},
): Promise<void> {
  await openTile(page, code, "Embedded Inventory");
  await page.getByRole("button", { name: "Send for Cutting" }).click();
  const dialog = page.getByRole("dialog", { name: /Send for Cutting/ });
  await expect(dialog).toBeVisible();

  const rows = () => dialog.locator(".max-h-64 select");
  while ((await rows().count()) > plan.length) {
    await dialog.locator(".max-h-64 button:has(svg.lucide-x)").last().click();
  }
  while ((await rows().count()) < plan.length) {
    await dialog.getByRole("button", { name: /Add Slide/i }).click();
  }
  for (let i = 0; i < plan.length; i += 1) await rows().nth(i).selectOption(plan[i]);

  await dialog.getByRole("button", { name: opts.save ? /^Save Plan/ : /Send for Cutting/ }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await closeDrawer(page);
}

/** Open a Needs Sectioning card and mark it cut. */
export async function markSectioned(page: Page, cardText: string): Promise<void> {
  await closeDrawer(page);
  await column(page, "Needs Sectioning").getByText(cardText, { exact: true }).first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  await closeDrawer(page);
}

/**
 * Tick every outstanding step of whatever protocol the open drawer shows.
 *
 * Deliberately generic: a stain rack's steps are "Stained → Coverslipped" but
 * an IHC rack's first step is "IHC stained", and a completed step's button
 * carries the operator's name, so naming the steps in the test means the test
 * silently skips half the racks. A step is done iff its button holds a tick.
 * Returns how many steps it completed.
 */
export async function runProtocolSteps(page: Page, operator = "Alex"): Promise<number> {
  const operatorField = page.getByLabel("Active operator");
  if (await operatorField.count()) await operatorField.fill(operator);
  let done = 0;
  for (let guard = 0; guard < 12; guard += 1) {
    const pending = drawer(page).locator("ol li button:not(:has(svg.lucide-check))");
    if ((await pending.count()) === 0) break;
    await pending.first().click();
    done += 1;
    await page.waitForTimeout(60);
  }
  return done;
}

// ---------------------------------------------------------------------------
// Integrity checks — run after any big burst of work.
// ---------------------------------------------------------------------------

export type IntegrityProbe = { name: string; query: string; expect: number };

/**
 * Things that must be true of the database no matter what route the UI took.
 * Each probe returns a count that has to be zero.
 */
export const INTEGRITY_PROBES: IntegrityProbe[] = [
  {
    name: "every slide belongs to a cut group that exists",
    query: `SELECT COUNT(*) AS n FROM slides sl
              LEFT JOIN section_requests sr ON sr.id = sl.section_request_id
             WHERE sr.id IS NULL`,
    expect: 0,
  },
  {
    name: "every cut group belongs to a sample that exists",
    query: `SELECT COUNT(*) AS n FROM section_requests sr
              LEFT JOIN samples s ON s.id = sr.sample_id
             WHERE s.id IS NULL`,
    expect: 0,
  },
  {
    name: "no slide code is issued twice",
    query: `SELECT COUNT(*) AS n FROM (
              SELECT slide_code FROM slides WHERE slide_code IS NOT NULL AND slide_code <> ''
               GROUP BY slide_code HAVING COUNT(*) > 1)`,
    expect: 0,
  },
  {
    name: "no sample code is issued twice",
    query: `SELECT COUNT(*) AS n FROM (
              SELECT sample_code FROM samples GROUP BY sample_code HAVING COUNT(*) > 1)`,
    expect: 0,
  },
  {
    name: "no slide points at a stack that no longer exists",
    query: `SELECT COUNT(*) AS n FROM slides sl
              LEFT JOIN slide_stacks st ON st.id = sl.stack_id
             WHERE sl.stack_id IS NOT NULL AND st.id IS NULL`,
    expect: 0,
  },
  {
    name: "no open stack is empty",
    query: `SELECT COUNT(*) AS n FROM slide_stacks st
             WHERE st.closed_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM slides sl WHERE sl.stack_id = st.id)`,
    expect: 0,
  },
  {
    // A stack is CLOSED when its work is finished — reaching `analyzed` retires
    // it with its slides still attached, which is the record, not a leak. What
    // must never happen is a slide with work left to do sitting in a retired
    // rack, because nothing on the board would ever show it again.
    name: "no slide still in play sits in a closed stack",
    query: `SELECT COUNT(*) AS n FROM slides sl
              JOIN slide_stacks st ON st.id = sl.stack_id
             WHERE st.closed_at IS NOT NULL
               AND sl.current_stage NOT IN ('analyzed','removed')`,
    expect: 0,
  },
  {
    name: "a removed slide holds no rack place",
    query: `SELECT COUNT(*) AS n FROM slides
             WHERE current_stage = 'removed' AND stack_id IS NOT NULL`,
    expect: 0,
  },
  {
    name: "a stain slide names its agent",
    query: `SELECT COUNT(*) AS n FROM slides
             WHERE purpose = 'stain' AND current_stage <> 'removed'
               AND (assay_name IS NULL OR TRIM(assay_name) = '')`,
    expect: 0,
  },
  {
    name: "an extra slide names no agent",
    query: `SELECT COUNT(*) AS n FROM slides
             WHERE purpose = 'extra' AND assay_name IS NOT NULL AND TRIM(assay_name) <> ''`,
    expect: 0,
  },
  {
    name: "a batch member points at a batch that exists",
    query: `SELECT COUNT(*) AS n FROM processing_batch_members bs
              LEFT JOIN processing_batches b ON b.id = bs.batch_id
             WHERE b.id IS NULL`,
    expect: 0,
  },
  {
    name: "no sample sits in two open batches",
    query: `SELECT COUNT(*) AS n FROM (
              SELECT bs.sample_id FROM processing_batch_members bs
                JOIN processing_batches b ON b.id = bs.batch_id
               WHERE b.status IN ('planned','processing')
               GROUP BY bs.sample_id HAVING COUNT(*) > 1)`,
    expect: 0,
  },
  {
    name: "an analyzed slide was imaged first",
    query: `SELECT COUNT(*) AS n FROM slides
             WHERE stage_analyzed_at IS NOT NULL AND stage_pictures_taken_at IS NULL`,
    expect: 0,
  },
  {
    name: "a stained slide was cut first",
    query: `SELECT COUNT(*) AS n FROM slides
             WHERE stage_stained_at IS NOT NULL AND stage_cut_at IS NULL`,
    expect: 0,
  },
  {
    name: "every timeline event points at a sample that exists",
    query: `SELECT COUNT(*) AS n FROM sample_timeline_events e
              LEFT JOIN samples s ON s.id = e.sample_id
             WHERE s.id IS NULL`,
    expect: 0,
  },
];

/**
 * Run every probe. Anything non-zero is recorded as a finding rather than
 * thrown, so one broken invariant does not hide the other fourteen.
 */
export async function checkIntegrity(
  page: Page,
  findings: Finding[],
  where: string,
): Promise<number> {
  let broken = 0;
  for (const probe of INTEGRITY_PROBES) {
    const n = await count(page, probe.query);
    if (n !== probe.expect) {
      broken += 1;
      findings.push({ where, detail: `INTEGRITY: ${probe.name} — got ${n}, expected ${probe.expect}` });
    }
  }
  return broken;
}

/** Snapshot of the whole database, for before/after comparisons. */
export async function tally(page: Page): Promise<Record<string, number>> {
  const tables = [
    "projects",
    "samples",
    "section_requests",
    "slides",
    "slide_stacks",
    "processing_batches",
    "processing_batch_members",
    "sample_timeline_events",
    "audit_events",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    out[t] = await count(page, `SELECT COUNT(*) AS n FROM ${t}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/**
 * The STORED form of a code shown on screen.
 *
 * The display drops the leading zeros (#87) while the database keeps them, so
 * a test that reads "MX-1-A" off the page and looks it up verbatim finds
 * nothing — and, worse, silently reports whatever `undefined` implies.
 * "MX-1-A" → "MX-0001-A"; "MX-12" → "MX-0012".
 */
export function storedCode(display: string): string {
  const m = /^([A-Za-z]+)-(\d+)(-.*)?$/.exec(display.trim());
  if (!m) return display.trim();
  return `${m[1].toUpperCase()}-${m[2].padStart(4, "0")}${m[3] ?? ""}`;
}

/** Look a slide up by the code the UI showed. */
export async function slideByDisplayCode(
  page: Page,
  display: string,
): Promise<Record<string, unknown> | null> {
  const rows = await sql(page, `SELECT * FROM slides WHERE slide_code = ?`, [storedCode(display)]);
  return rows[0] ?? null;
}
