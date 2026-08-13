import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { settleAfterDrop } from "../helpers/drag";

/**
 * #113–#120. The Logs cluster (#117/#118/#119) is one root cause: the phase was
 * a single value derived from "has this stamp been set", so it fired early, went
 * empty, and was exclusive when it needed to be an inventory.
 */

async function signInAndProject(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByLabel("Signed-in user").locator("option", { hasText: "Alex Rivera" }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
}

async function addSample(page: Page, description: string) {
  await page.getByRole("button", { name: "New Sample" }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toBeVisible();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(description);
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toHaveCount(0);
}

async function dragOnto(page: Page, sourceText: string, columnTitle: string) {
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
  await settleAfterDrop(page);
}

async function embed(page: Page, code: string, batchLabel: string) {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await dragOnto(page, code, "Processor");
  await expect(page.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText(batchLabel, { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await dragOnto(page, batchLabel, "Needs Embedding");
  await dragOnto(page, code, "Embedded Inventory");
}

function drawer(page: Page) {
  return page.locator("div.border-l").filter({ has: page.getByRole("heading", { name: "Timeline" }) });
}

function column(page: Page, title: string) {
  return page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

/** Cut a block with one agent assigned, leaving the group in Needs Sectioning. */
async function cutWithAgent(page: Page, code: string): Promise<string> {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: "Send for Cutting" }).click();
  const assay = page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Extra (no stain)" }) })
    .first();
  await assay.selectOption({ index: 1 });
  const agent = (await assay.locator("option:checked").textContent())?.trim() ?? "";
  expect(agent).not.toBe("");
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  return agent;
}

/**
 * Tick a Logs stage filter. It is a <details> popover of checkboxes, not a row
 * of chips, so the summary has to be opened first.
 */
async function stageFilter(page: Page, label: string) {
  const summary = page.locator("summary").filter({ hasText: /^(All stages|\d+ stages?)/ });
  if ((await page.getByRole("checkbox", { name: label, exact: true }).count()) === 0) {
    await summary.click();
  }
  await page.getByRole("checkbox", { name: label, exact: true }).check();
}

async function clearStageFilter(page: Page, label: string) {
  await page.getByRole("checkbox", { name: label, exact: true }).uncheck();
}

// ---------------------------------------------------------------------------
// #118 — "logs incorrectly show a bunch of unsectioned AND sectioned … this is
// occurring because the logs show as 0/1 sectioned as soon as the cutting plan
// is created."
//
// #119 — "once samples are moved to sectioning, they are removed from the
// embedded filter … this is not how inventories work."
// ---------------------------------------------------------------------------
test("#118/#119: a queued block is not Sectioned, and stays in Embedded", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "queued for cutting");
  await embed(page, "EE-1", "Batch 1");

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "EE-1", exact: true }) });
  await expect(row.getByRole("cell", { name: "Embedded", exact: true })).toBeVisible();

  // Send it for cutting. The slides now EXIST, but nobody has cut them.
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  await cutWithAgent(page, "EE-1");
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();

  // #118 — still Embedded, not Sectioned: the plan is not the cut.
  // Let the post-cut refetch land first. Without this the assertions below
  // read the PRE-cut render, where the block is trivially still Embedded —
  // they would hold even if the cut did set the phase wrongly.
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toBeVisible();
  await page.waitForTimeout(750);
  await expect(row.getByRole("cell", { name: "Embedded", exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: "Sectioned", exact: true })).toHaveCount(0);
  // …and no analyzed fraction, because no slide has been cut to analyze.
  await expect(row.getByText(/^\d+\/\d+$/)).toHaveCount(0);

  // #119 — the Embedded filter still holds it, because the block is still in
  // the Embedded Inventory. That is what an inventory means.
  await stageFilter(page, "Embedded");
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toBeVisible();
});

// ---------------------------------------------------------------------------
// #117 — "staining/ihc filter in logs shows no samples".
//
// The phase required `stage_stained_at`, so a slide sitting IN the staining
// column that had not been stained yet matched nothing at all.
// ---------------------------------------------------------------------------
test("#117: the Staining filter finds a block whose slides are in staining", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "in staining");
  await embed(page, "EE-1", "Batch 1");
  const agent = await cutWithAgent(page, "EE-1");

  // Section it — the agent slide splits into a staining rack, unstained.
  await page.getByText("3 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  const close = page.locator("button:has(svg.lucide-x)").first();
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => undefined);
  await expect(column(page, "Staining / IHC").getByText(agent).first()).toBeVisible({
    timeout: 15000,
  });

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await stageFilter(page, "Staining / IHC");
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toBeVisible();
  // And it is STILL in Embedded too — both are true at once (#119).
  await clearStageFilter(page, "Staining / IHC");
  await stageFilter(page, "Embedded");
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toBeVisible();
});

// ---------------------------------------------------------------------------
// #114 — "requesting stain from logs on workstation uses syncing feature … the
// stain request should just be an added stain."
// ---------------------------------------------------------------------------
test("#114: the Logs add a stain directly, with no sync request", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "direct add");
  await embed(page, "EE-1", "Batch 1");

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();

  // The old sync dialog must not appear at all.
  await expect(page.getByRole("button", { name: /Request stain for/ })).toHaveCount(0);
  await page.getByLabel("Add a stain to EE-1").selectOption("stain::H&E");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect(page.getByRole("dialog", { name: /Request a stain/ })).toHaveCount(0);
  await expect(page.getByText(/needs a cut|pulled from an extra/)).toBeVisible({ timeout: 15000 });

  // It landed on the block: the board flags it.
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  await expect(column(page, "Embedded Inventory").getByText("⚑ needs cut")).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// #113 — the Embedded Inventory drawer offers cutting plans only.
// ---------------------------------------------------------------------------
test("#113: no Add a Stain in the embedded-inventory drawer", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "no adding here");

  // Pre-processing still offers it — the concern is the embedded stage, where
  // the control silently consumes a free extra.
  await page.getByText("EE-1", { exact: true }).first().click();
  await expect(drawer(page).getByRole("heading", { name: "Add a Stain" })).toBeVisible();
  await drawer(page).locator("button:has(svg.lucide-x)").first().click();

  await embed(page, "EE-1", "Batch 1");
  await page.getByText("EE-1", { exact: true }).first().click();
  await expect(drawer(page).getByRole("heading", { name: "Add a Stain" })).toHaveCount(0);
  // …and the cutting plan is still right there.
  await expect(drawer(page).getByRole("button", { name: "Send for Cutting" })).toBeVisible();
});

// ---------------------------------------------------------------------------
// #116 — a plan already sent for cutting is editable until it is cut.
// ---------------------------------------------------------------------------
test("#116: an active cutting plan can be reopened from the block drawer", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "editable plan");
  await embed(page, "EE-1", "Batch 1");
  await cutWithAgent(page, "EE-1");

  await column(page, "Embedded Inventory").getByText("EE-1", { exact: true }).click();
  // Assigning one agent splits the cut into TWO groups — one carrying the agent,
  // one of extras — so the drawer lists a row per group, not one of three.
  const edits = drawer(page).getByRole("button", { name: /Awaiting cut ·/ });
  await expect(edits).toHaveCount(2);
  await edits.first().click();

  // The drawer swaps to the cut group, where each slide's purpose is editable.
  await expect(page.getByRole("heading", { name: /EE-1 · ×/ })).toBeVisible();
  await expect(page.getByLabel(/^Purpose for EE-1-/).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// #115 — reassign a slide after it has reached staining.
// ---------------------------------------------------------------------------
test("#115: a slide in staining can be moved to another agent", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "reassign me");
  await embed(page, "EE-1", "Batch 1");
  const agent = await cutWithAgent(page, "EE-1");

  await page.getByText("3 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  const close = page.locator("button:has(svg.lucide-x)").first();
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => undefined);

  const staining = column(page, "Staining / IHC");
  await expect(staining.getByText(agent).first()).toBeVisible({ timeout: 15000 });
  await staining.getByText(agent).first().click();

  // Move the slide onto a different agent; it leaves this rack for that one.
  await page.getByLabel(/^Reassign EE-1-/).first().selectOption("ihc:CD31");
  await expect(staining.getByText("CD31").first()).toBeVisible({ timeout: 15000 });
  await expect(staining.getByText(agent)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// #120 — "Typing in OG-11 does not return sample OG-11."
// ---------------------------------------------------------------------------
test("#120: the Extras search finds a block by its short code", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "smart search");
  await embed(page, "EE-1", "Batch 1");
  await cutWithAgent(page, "EE-1");

  // Section it so its extras reach the inventory.
  await page.getByText("3 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  const close = page.locator("button:has(svg.lucide-x)").first();
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => undefined);

  const extras = column(page, "Extras");
  await expect(extras.getByText("EE-1", { exact: true })).toBeVisible({ timeout: 15000 });

  const search = extras.getByPlaceholder("Find sample or extra slide...");
  // The SHORT spelling, against a code stored padded as EE-0001 (#87).
  await search.fill("EE-1");
  await expect(extras.getByText("EE-1", { exact: true })).toBeVisible();
  // Multiple terms, in an order they do not appear in adjacent.
  await search.fill("smart EE-1");
  await expect(extras.getByText("EE-1", { exact: true })).toBeVisible();
  // And a term that genuinely does not match still filters it out.
  await search.fill("EE-1 nonsense");
  await expect(extras.getByText("EE-1", { exact: true })).toHaveCount(0);
});
