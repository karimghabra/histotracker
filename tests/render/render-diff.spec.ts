/**
 * Render diff: the screenshot comparison, without a screenshot and without a
 * baseline (pnpm verify's layer 2, run by scripts/verify.mjs).
 *
 * Two builds of the app are served side by side in the same run on the same
 * machine (RENDER_DIFF_BUILDS='{"base":"http://localhost:5701","head":"http://localhost:5702"}').
 * Each gets the same lab, built the same way, under the same frozen clock, and
 * every surface in SURFACES is read two ways:
 *
 *  - its ARIA snapshot (what a screen reader, and so a user, can find on it), and
 *  - `auditInPage` (clipped controls, unreadable truncation, contrast, selection
 *    prominence) at two widths.
 *
 * Nothing is compared with a stored file. The base render is made in this run, so a
 * font or runner difference moves both sides equally and cancels out.
 *
 * Policy: a structural (ARIA) difference is reported, because an update is supposed
 * to change something; a NEW audit line on head that base does not have fails the
 * test, because no update is supposed to cut off a control or make text unreadable.
 */
import { test, expect, type Page, type Browser } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditInPage, normalise } from "./ui-audit";
import { auditLines, newFindings } from "./audit-compare";

const BUILDS = JSON.parse(process.env.RENDER_DIFF_BUILDS ?? "{}") as Record<string, string>;
const OUT = process.env.RENDER_DIFF_OUT ?? "test-results/render-diff-out";
const WIDTHS = [1280, 1024];
const HEIGHT = 800;
const CLOCK = new Date("2026-09-01T09:30:00");

type Surface = { name: string; open: (page: Page) => Promise<void>; scope?: string; theme?: string };

async function signIn(page: Page, user = "Alex Rivera") {
  const select = page.getByLabel("Signed-in user");
  if ((await select.count()) > 0) await select.selectOption({ label: user }).catch(() => {});
}

async function db(page: Page, fn: string, args: unknown[]) {
  const r = await page.evaluate(
    async ([name, params]) => {
      try {
        // A path that exists only inside the page, where Vite serves it. Held in a
        // variable so the Node-side typecheck does not try to resolve it.
        const dbModule = "/src/lib/db.ts";
        const mod = (await import(/* @vite-ignore */ dbModule)) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
        return { ok: true, value: await mod[name as string](...(params as unknown[])) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [fn, args] as const,
  );
  if (!r.ok) throw new Error(`${fn}: ${(r as { error: string }).error}`);
  return (r as { value: unknown }).value;
}

async function sql<T>(page: Page, query: string): Promise<T[]> {
  return (await page.evaluate(
    (q) => (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }).__SHIM_SELECT__(q),
    query,
  )) as T[];
}

/** The same small lab on every build: a user, two projects, six blocks across the pipeline, one removed. */
async function buildLab(page: Page) {
  await page.clock.setFixedTime(CLOCK);
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: /Manage users/ }).click();
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Signed-in user").locator("option", { hasText: "Alex Rivera" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  const overlay = page.locator("div.fixed.inset-0.z-50");
  if (await overlay.count()) await overlay.first().click({ position: { x: 5, y: 5 } });
  await signIn(page);

  for (const code of ["EE", "CART"]) {
    await db(page, "addProject", [
      { code, name: code === "EE" ? "Enthesis Engineering" : "Cartilage Repair", team_lead: "", is_active: true, lead_user_id: 0 },
    ]);
  }
  const projects = await sql<{ id: number; code: string }>(page, "SELECT id, code FROM projects ORDER BY id");
  for (const p of projects) {
    for (let i = 0; i < 3; i += 1) {
      await db(page, "addSample", [
        {
          project_id: p.id,
          sample_description: `${p.code} block ${i + 1}`,
          processing_type: i % 2 ? "Long" : "Short",
          fixative_agent: "Z-Fix",
          needs_decalcification: false,
          cut_notes: "",
          slide_notes: "",
          embedding_notes: i === 0 ? "Orient cut face down" : "",
          stains: "",
          preselected_stains: [],
          overall_notes: "",
        },
        p.code,
      ]);
    }
  }
  const samples = await sql<{ id: number }>(page, "SELECT id FROM samples ORDER BY id");
  for (const stage of ["in_fixative", "fixative_removed", "in_ethanol"]) await db(page, "updateSampleStage", [samples[1].id, stage]);
  for (const stage of ["in_fixative", "fixative_removed", "in_ethanol", "processing_started", "processed", "picked_up", "needs_embedding", "embedded"]) {
    await db(page, "updateSampleStage", [samples[2].id, stage]);
  }
  await db(page, "removeSample", [samples[5].id, "Rendered for the diff"]);
  // A remount, as the app does on launch, so React Query reads the store afresh.
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });
  await signIn(page);
}

async function setTheme(page: Page, value: string) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Visual theme").selectOption(value);
  await page.getByRole("dialog", { name: "Settings" }).press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
}

const nav = (name: string) => async (page: Page) => {
  await page.locator("nav").getByRole("button", { name }).click();
};
const board = async (page: Page) => {
  await nav("Board")(page);
  const all = page.locator("aside").getByRole("button", { name: "All projects", exact: true });
  if ((await all.count()) && (await all.getAttribute("aria-current")) !== "true") await all.click();
  await expect(page.getByRole("heading", { name: "Pre-processing", exact: true })).toBeVisible();
};
const logs = async (page: Page) => {
  await nav("Logs")(page);
  await expect(page.getByPlaceholder(/Search code/)).toBeVisible();
  const removed = page.getByLabel("Show removed");
  if ((await removed.count()) && !(await removed.isChecked())) await removed.check();
};

const SURFACES: Surface[] = [
  { name: "board", open: board },
  { name: "board-project", open: async (p) => { await board(p); await p.locator("aside").getByText("Cartilage Repair").first().click(); } },
  { name: "logs", open: logs },
  { name: "logs-row", open: async (p) => { await logs(p); await p.getByRole("cell", { name: "EE-1", exact: true }).click(); await expect(p.getByText("Sample timeline")).toBeVisible(); } },
  { name: "logs-dark", theme: "dark", open: async (p) => { await logs(p); } },
  { name: "sidebar-dark", theme: "dark", scope: "aside", open: board },
  { name: "settings", scope: "[role=dialog]", open: async (p) => { await p.getByRole("button", { name: "Settings", exact: true }).click(); } },
  { name: "new-sample", scope: "[role=dialog]", open: async (p) => { await p.getByRole("button", { name: "New Sample" }).click(); await expect(p.getByLabel("Project for these samples")).toBeVisible(); } },
];

async function readSurface(page: Page, s: Surface): Promise<string> {
  const out: string[] = [];
  try {
    if (s.theme) await setTheme(page, s.theme);
    await s.open(page);
    await page.waitForTimeout(300); // let a transition finish; nothing is timed against it
    const aria = await page.locator(s.scope ?? "body").first().ariaSnapshot();
    out.push(`## aria`, normalise(aria));
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: HEIGHT });
      await page.waitForTimeout(150);
      out.push(`## audit @${w}`, ...(await page.evaluate(auditInPage)));
    }
  } catch (e) {
    out.push(`surface-unavailable ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
  }
  await page.setViewportSize({ width: WIDTHS[0], height: HEIGHT });
  await page.keyboard.press("Escape").catch(() => {});
  if (s.theme) await setTheme(page, "light").catch(() => {});
  return out.join("\n") + "\n";
}

async function renderBuild(browser: Browser, name: string, url: string): Promise<Map<string, string>> {
  const context = await browser.newContext({ baseURL: url, viewport: { width: WIDTHS[0], height: HEIGHT } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await buildLab(page);
  const result = new Map<string, string>();
  mkdirSync(join(OUT, name), { recursive: true });
  for (const s of SURFACES) {
    const text = await readSurface(page, s);
    result.set(s.name, text);
    writeFileSync(join(OUT, name, `${s.name}.txt`), text);
  }
  result.set("page-errors", errors.map((e) => `pageerror ${e}`).join("\n"));
  await context.close();
  return result;
}

/** Line diff (LCS). Surfaces are a few hundred lines, so the quadratic table is fine. */
function diffLines(a: string[], b: string[]): string[] {
  const n = a.length, m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++; }
    else if (j < m && (i === n || t[i][j + 1] >= t[i + 1][j])) out.push(`+ ${b[j++]}`);
    else out.push(`- ${a[i++]}`);
  }
  return out;
}

test("render diff: base and head, same lab, same run", async ({ browser }) => {
  test.setTimeout(600_000);
  const names = Object.keys(BUILDS);
  expect(names, "RENDER_DIFF_BUILDS must name exactly base and head").toEqual(["base", "head"]);
  const base = await renderBuild(browser, "base", BUILDS.base);
  const head = await renderBuild(browser, "head", BUILDS.head);

  const report: string[] = [];
  const regressions: string[] = [];
  let identical = 0;
  for (const name of [...SURFACES.map((s) => s.name), "page-errors"]) {
    const d = diffLines((base.get(name) ?? "").split("\n"), (head.get(name) ?? "").split("\n"));
    if (d.length === 0) { identical += 1; continue; }
    report.push(`[${name}] ${d.length} changed line(s)`, ...d.slice(0, 20).map((l) => `  ${l}`));
    if (d.length > 20) report.push(`  ... ${d.length - 20} more in ${OUT}/diff.txt`);
    // A finding head has and base does not is a regression. The same finding on more or
    // fewer elements is not: that is what an update adding content looks like (audit-compare.ts).
    for (const f of newFindings(auditLines(base.get(name) ?? ""), auditLines(head.get(name) ?? ""))) regressions.push(`[${name}] ${f}`);
  }
  const summary = `render-diff: ${SURFACES.length} surfaces x ${WIDTHS.length} widths, ${identical} of ${SURFACES.length + 1} identical, ${regressions.length} new problem(s)`;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "diff.txt"), [summary, ...report].join("\n") + "\n");
  console.log([summary, ...report].join("\n"));
  expect(regressions, `new layout, contrast or error findings on head:\n${regressions.join("\n")}`).toEqual([]);
});
