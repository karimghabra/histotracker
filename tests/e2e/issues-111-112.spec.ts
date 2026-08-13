import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { settleAfterDrop } from "../helpers/drag";
import { addStainFromLogsAndReturn, openBlockDrawer } from "../helpers/stains";

/**
 * #111 (Needs Sectioning filter + sort) and #112 (the needs-cut flag must clear
 * once the cut exists, and outstanding requests can be withdrawn).
 */

async function signIn(page: Page) {
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
}

async function addProject(page: Page, code: string, name: string) {
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill(code);
  await page.locator('input[placeholder="Enthesis Engineering"]').fill(name);
  await page.getByRole("button", { name: "Save Project" }).click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toHaveCount(0);
}

async function signInAndProject(page: Page) {
  await signIn(page);
  await addProject(page, "EE", "Enthesis Engineering");
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

/** Send a block for cutting with one agent assigned to a slide. */
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

// ---------------------------------------------------------------------------
// #112 — "a sample which is awaiting cut (i.e., already in needs sectioning) and
// has a stain requested does not lose the needs stain flag".
//
// Two independent leaks fed it. A saved plan flagged the block off a timeline
// event that is never cleared, so one saved plan flagged it for ever; and the
// request trim skipped groups with no assay_type. Both had to go.
// ---------------------------------------------------------------------------
test("#112: the needs-cut flag clears once the block has been cut", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "flag clears");
  await embed(page, "EE-1", "Batch 1");

  const inventory = column(page, "Embedded Inventory");
  await expect(inventory.getByText("⚑ needs cut")).toHaveCount(0);

  // Deliberately save a plan → flagged.
  await inventory.getByText("EE-1", { exact: true }).click();
  await page.getByRole("button", { name: "Send for Cutting" }).click();
  const dialog = page.getByRole("dialog", { name: /Send for Cutting/ });
  await dialog.getByRole("button", { name: /Add slide/i }).click();
  await dialog.getByRole("button", { name: /^Save Plan/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(inventory.getByText("⚑ needs cut")).toHaveCount(1);

  // Now actually cut it. The drawer is still open — clicking the tile again
  // would toggle it shut (#61) — so go straight back into the dialog.
  await page.getByRole("button", { name: "Send for Cutting" }).click();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();

  await expect(column(page, "Needs Sectioning").getByText("EE-1", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(inventory.getByText("⚑ needs cut")).toHaveCount(0);
});

// #112 — the other leak: a request the cut fulfilled must stop being listed as
// outstanding, or the drawer shows the slide AND the request side by side —
// which is exactly the pair in the report.
//
// This drives the ORDINARY path, where the request carries a type. The typeless
// plan that defeated the old trim cannot be produced through the UI, so that
// half is covered by the harness gate issue(112, "…even with no assay type").
test("#112: a cut clears the request it fulfilled", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "request cleared");
  await embed(page, "EE-1", "Batch 1");

  // Ask for an agent → outstanding, and the block is flagged. From the Logs:
  // #113 took the control out of the Embedded Inventory drawer, but the drawer
  // still LISTS what is outstanding, which is what this test is about.
  await addStainFromLogsAndReturn(page, "EE-1", "stain::H&E");
  await openBlockDrawer(page, "EE-1");
  const panel = drawer(page);
  await expect(panel.getByText("Requested")).toBeVisible({ timeout: 15000 });
  await expect(column(page, "Embedded Inventory").getByText("⚑ needs cut")).toHaveCount(1);

  // Cut it — the plan is prefilled with the outstanding agent.
  await page.getByRole("button", { name: "Send for Cutting" }).click();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await expect(column(page, "Needs Sectioning").getByText("EE-1", { exact: true })).toBeVisible({
    timeout: 15000,
  });

  // The slide exists; the request must NOT still be listed beside it.
  await column(page, "Embedded Inventory").getByText("EE-1", { exact: true }).click();
  const list = drawer(page).locator("ul").filter({ hasText: "H&E" });
  await expect(list.locator("li").filter({ hasText: "H&E" })).toHaveCount(1);
  await expect(drawer(page).getByText("Requested")).toHaveCount(0);
  await expect(column(page, "Embedded Inventory").getByText("⚑ needs cut")).toHaveCount(0);
});

// #112 — "perhaps we should be able to manage requested stains?" A request that
// drifts out of step with the slides had no cure from inside the app.
test("#112: an outstanding stain request can be withdrawn by hand", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "withdraw me");
  await embed(page, "EE-1", "Batch 1");

  await addStainFromLogsAndReturn(page, "EE-1", "stain::H&E");
  await openBlockDrawer(page, "EE-1");
  const panel = drawer(page);
  await expect(panel.getByText("Requested")).toBeVisible({ timeout: 15000 });
  await expect(column(page, "Embedded Inventory").getByText("⚑ needs cut")).toHaveCount(1);

  await panel.getByRole("button", { name: "Withdraw H&E request" }).click();

  // The request goes, and so does the flag it was raising.
  await expect(panel.getByText("Requested")).toHaveCount(0, { timeout: 15000 });
  await expect(column(page, "Embedded Inventory").getByText("⚑ needs cut")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// #111 — Needs Sectioning gets the filter + sort every other busy column has.
// ---------------------------------------------------------------------------
test("#111: Needs Sectioning can be filtered by project and sorted", async ({ page }) => {
  await signInAndProject(page);
  await addProject(page, "ZZ", "Zebrafish Zone");

  await page.locator("aside").first().getByRole("button", { name: /Enthesis/ }).click();
  await addSample(page, "enthesis block");
  await embed(page, "EE-1", "Batch 1");
  await cutWithAgent(page, "EE-1");

  await page.locator("aside").first().getByRole("button", { name: /Zebrafish/ }).click();
  await addSample(page, "zebrafish block");
  await embed(page, "ZZ-1", "Batch 2");
  await cutWithAgent(page, "ZZ-1");

  const col = column(page, "Needs Sectioning");
  await expect(col.getByText("EE-1", { exact: true })).toBeVisible();
  await expect(col.getByText("ZZ-1", { exact: true })).toBeVisible();

  const filter = page.getByLabel("Filter needs sectioning by project");
  await expect(filter).toBeVisible();
  await filter.selectOption({ label: "EE" });
  await expect(col.getByText("EE-1", { exact: true })).toBeVisible();
  await expect(col.getByText("ZZ-1", { exact: true })).toHaveCount(0);

  // Clear it, then prove the sort control is wired to something.
  await filter.selectOption("all");
  const sort = page.getByLabel("Sort needs sectioning");
  await expect(sort).toBeVisible();
  await sort.selectOption("sample_id");
  await expect(col.getByText("EE-1", { exact: true })).toBeVisible();
  await expect(col.getByText("ZZ-1", { exact: true })).toBeVisible();
});
