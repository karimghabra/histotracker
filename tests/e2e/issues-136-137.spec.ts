import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { addStainFromLogs, openBlockDrawer } from "../helpers/stains";
import { settleAfterDrop } from "../helpers/drag";

/**
 * #136 — "when Stains are assigned they do not show up on the log until they
 * have been sectioned … the current fixing TE8-12 samples have SafO assigned but
 * I cannot tell that from the log."
 *
 * #137 — "Embedding Notes. During sample creation add a box for embedding notes."
 *
 * The ask in #136 is CONSISTENCY: the log must say what the main screen says.
 * So every assertion below is made twice — once against what is on screen, once
 * against the exported CSV of that same view — because a log you take off the
 * bench in a spreadsheet is still the log. The export was where the first
 * attempt at this quietly disagreed with itself.
 *
 * Two shapes of block, both from the captain's own bench:
 *   EE-1 — assigned a stain at intake, still in fixative, NO slides at all.
 *   EE-2 — already cut for one agent, with a second still only assigned.
 * The second is the harder one: its rows named every agent except the one owed.
 */

async function boot(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
}

async function newSample(
  page: Page,
  opts: { description: string; embeddingNotes?: string; stains?: string[] },
) {
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(opts.description);
  if (opts.embeddingNotes !== undefined) {
    await page.getByLabel("Embedding Notes").fill(opts.embeddingNotes);
  }
  for (const stain of opts.stains ?? []) {
    // The catalogue rows are labels nested inside the Field's own label, so the
    // outer one matches the text too — take the innermost.
    await page.locator("label").filter({ hasText: stain }).last().getByRole("checkbox").check();
  }
  await page.getByRole("button", { name: /Create Sample/ }).click();
}

async function drag(page: Page, src: string, col: string) {
  const card = page.getByText(src, { exact: true }).first();
  const header = page.getByRole("heading", { name: col, exact: true });
  const f = await card.boundingBox();
  const t = await header.boundingBox();
  if (!f || !t) throw new Error("drag endpoints missing");
  await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2);
  await page.mouse.down();
  await page.mouse.move(f.x + f.width / 2 + 10, f.y + f.height / 2 + 10, { steps: 4 });
  await page.mouse.move(t.x + t.width / 2, t.y + 140, { steps: 10 });
  await page.mouse.move(t.x + t.width / 2, t.y + 142, { steps: 3 });
  await page.mouse.up();
  // dnd-kit swallows every click for 50ms after a drop — wait it out.
  await settleAfterDrop(page);
}

/** Walk a block from intake to Embedded Inventory and cut it for one agent. */
async function cutBlockFor(page: Page, code: string, agent: string) {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click(); // close drawer
  await drag(page, code, "Processor");
  // A background refetch can momentarily blank the active operator and no-op the
  // Start-Batch click, so retry until the batch actually appears.
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await drag(page, "Batch 1", "Needs Embedding");
  await drag(page, code, "Embedded Inventory");

  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Extra (no stain)" }) })
    .first()
    .selectOption(`stain::${agent}`);
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click(); // close drawer
}

/** Export the Logs view as it currently stands and read the bytes back. */
async function exportedLogsCsv(page: Page): Promise<string> {
  await page.getByRole("button", { name: "CSV" }).click();
  await expect(page.getByText("Exported.")).toBeVisible({ timeout: 15000 });
  const csv = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith("histometer-shim-fs:histometer-logs-") && k.endsWith(".csv")) {
        return atob(localStorage.getItem(k) as string);
      }
    }
    return "";
  });
  expect(csv).not.toBe("");
  return csv;
}

/** Split a CSV line on commas that are not inside a quoted cell. */
function cells(line: string): string[] {
  return (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [])
    .map((c) => c.replace(/,$/, ""))
    .slice(0, -1)
    .map((c) => (c.startsWith('"') ? c.slice(1, -1).replace(/""/g, '"') : c));
}

/** The exported rows belonging to one block, as parsed cells. */
function rowsFor(csv: string, code: string): string[][] {
  return csv
    .trim()
    .split("\n")
    .slice(1)
    .map(cells)
    .filter((row) => row[1] === code);
}

test("#136/#137: the log — on screen AND exported — says what the main screen says", async ({
  page,
}) => {
  await boot(page);

  // EE-1 is the captain's example: assigned a stain at intake, never cut. It
  // also carries the #137 note, so both issues are exercised on one block.
  await newSample(page, {
    description: "TE8-12 fixing sample",
    embeddingNotes: "cut face down, proximal end left",
    stains: ["Safranin O"],
  });
  await expect(page.getByText("EE-1")).toBeVisible();

  // EE-2 gets cut for Alcian Blue, then asked for Safranin O afterwards — a
  // block with real glass AND an outstanding request.
  await newSample(page, { description: "cut but still owing a stain" });
  await expect(page.getByText("EE-2")).toBeVisible();
  await cutBlockFor(page, "EE-2", "Alcian Blue");
  await expect(await addStainFromLogs(page, "EE-2", "stain::Safranin O")).toContain("Safranin O");

  // ---- THE MAIN SCREEN ----------------------------------------------------
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  await openBlockDrawer(page, "EE-1");
  // What the captain can see today, and could not see in the log.
  await expect(page.getByText(/Safranin O/).first()).toBeVisible();
  // #137 — the note he typed at intake, shown where the block is read.
  await expect(page.getByRole("heading", { name: "Embedding Notes" })).toBeVisible();
  await expect(page.getByText("cut face down, proximal end left")).toBeVisible();
  await page.locator("button:has(svg.lucide-x)").first().click();

  // ---- THE LOG, ON SCREEN -------------------------------------------------
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  const stainsCell = (code: string) =>
    page.getByRole("row").filter({ has: page.getByRole("cell", { name: code, exact: true }) });
  // EE-1 has no slides at all and still names its assigned stain — this is the
  // literal sentence in #136.
  await expect(stainsCell("EE-1")).toContainText("Safranin O");
  await expect(stainsCell("EE-1")).toContainText("(assigned)");
  // EE-2 names BOTH the agent on its glass and the one still owed.
  await expect(stainsCell("EE-2")).toContainText("Alcian Blue");
  await expect(stainsCell("EE-2")).toContainText("Safranin O");

  // The stain filter reads the same list, so filtering by an assigned-but-uncut
  // stain finds the blocks that owe it rather than reporting nothing.
  const stainSelect = page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Any stain" }) });
  await stainSelect.selectOption("Safranin O");
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "EE-2", exact: true })).toBeVisible();
  await stainSelect.selectOption("PAS");
  await expect(page.getByText("No samples match")).toBeVisible();
  await stainSelect.selectOption("Any stain / IHC");

  // ---- THE LOG, EXPORTED --------------------------------------------------
  // Same view, same information. Before the fix the export loop only ever read
  // physical slides, so EE-1 exported with an empty stain column and EE-2
  // exported three slide rows with no mention of Safranin O anywhere.
  const csv = await exportedLogsCsv(page);
  const header = cells(csv.trim().split("\n")[0]);
  const col = (row: string[], name: string) => row[header.indexOf(name)];

  const one = rowsFor(csv, "EE-1");
  expect(one).toHaveLength(1);
  expect(col(one[0], "Stain / IHC")).toBe("Safranin O");
  expect(col(one[0], "Slide")).toBe(""); // no glass — the row says so
  expect(col(one[0], "Slide Stage")).toBe("requested (not cut)");
  // #137 — and the embedding note rides along with it.
  expect(col(one[0], "Embedding Notes")).toBe("cut face down, proximal end left");

  const two = rowsFor(csv, "EE-2");
  expect(two.some((r) => col(r, "Stain / IHC") === "Alcian Blue")).toBe(true);
  const owed = two.filter((r) => col(r, "Stain / IHC") === "Safranin O");
  expect(owed).toHaveLength(1);
  expect(col(owed[0], "Slide")).toBe("");
  expect(col(owed[0], "Slide Stage")).toBe("requested (not cut)");

  // The export honours the filter it was taken under, so a filtered log is
  // still consistent with the screen it came from.
  await stainSelect.selectOption("Safranin O");
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toBeVisible();
  const filtered = await exportedLogsCsv(page);
  expect(rowsFor(filtered, "EE-1")).toHaveLength(1);

  await page.screenshot({ path: "test-results/issues-136-137-logs.png", fullPage: true });
});

test("#136: the expanded Logs row explains a stain with no slide", async ({ page }) => {
  await boot(page);
  await newSample(page, { description: "fixing block", stains: ["Safranin O", "CD68"] });
  await expect(page.getByText("EE-1")).toBeVisible();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  // Nothing is cut, so the block owes every agent it names — said once for the
  // whole list rather than after each name, which pushed the last one out of the
  // cell. "all", because a trailing "(assigned)" after a comma list reads as
  // belonging only to the name in front of it.
  await expect(
    page.getByRole("row").filter({ has: page.getByRole("cell", { name: "EE-1", exact: true }) }),
  ).toContainText("(all assigned)");
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();

  // The drill-down used to list slides only, so a row whose Stains cell named an
  // agent opened onto "No slides cut yet" and no explanation of where the agent
  // had come from. Same wording as the board drawer: Requested.
  await expect(page.getByText("Assigned — not cut yet (2)")).toBeVisible();
  const owed = page.getByRole("listitem").filter({ hasText: "Requested" });
  await expect(owed).toHaveCount(2);
  await expect(owed.filter({ hasText: "Safranin O" })).toHaveCount(1);
  await expect(owed.filter({ hasText: "CD68" })).toHaveCount(1);
});

test("#137: a block created without embedding notes says nothing about them", async ({ page }) => {
  await boot(page);
  await newSample(page, { description: "plain block" });
  await expect(page.getByText("EE-1")).toBeVisible();

  // An empty optional note must not leave an empty heading behind on either
  // surface that shows it.
  await openBlockDrawer(page, "EE-1");
  await expect(page.getByRole("heading", { name: "Embedding Notes" })).toHaveCount(0);
  await page.locator("button:has(svg.lucide-x)").first().click();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();
  await expect(page.getByText("Sample timeline")).toBeVisible();
  await expect(page.getByText("Embedding notes")).toHaveCount(0);
});
