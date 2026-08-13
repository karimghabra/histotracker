import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { settleAfterDrop } from "../helpers/drag";

/**
 * #109 (bulk stain requests) and #110 (the Embedded Inventory flag + bulk plan
 * saving).
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

/** Take one block all the way to Embedded Inventory. */
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

/** Tick a block's checkbox in the Embedded Inventory (its dense card). */
async function select(page: Page, code: string, queue = "Embedded Inventory") {
  await column(page, queue)
    .getByRole("checkbox", { name: `Select ${code}` })
    .check();
}

// ---------------------------------------------------------------------------
// #109 — "selecting multiple samples, then using the drop down to request a
// stain only requests one of the selected samples."
// ---------------------------------------------------------------------------
// Driven in Pre-processing, not the Embedded Inventory: #113 removed the
// control from the embedded drawer, where a request could quietly consume an
// extra cut for something else. The multi-target behaviour this issue is about
// is unchanged — the control still acts on the WHOLE selection wherever it is
// shown — so the test follows it to a stage that still has it.
test("#109: adding a stain applies to every selected block", async ({ page }) => {
  await signInAndProject(page);
  for (const description of ["first block", "second block", "third block"]) {
    await addSample(page, description);
  }

  // Select all three.
  await select(page, "EE-1", "Pre-processing");
  await select(page, "EE-2", "Pre-processing");
  await select(page, "EE-3", "Pre-processing");

  const panel = drawer(page);
  await expect(panel).toBeVisible();
  // The panel says how many blocks it is about to act on.
  await expect(panel.getByText("3 selected blocks").first()).toBeVisible();

  await panel.locator("select").first().selectOption("stain::H&E");
  await panel.getByRole("button", { name: "Add", exact: true }).click();

  // All three, not one — the flash counts them.
  await expect(panel.getByText(/3 flagged on the block/)).toBeVisible({ timeout: 15000 });
});

// ---------------------------------------------------------------------------
// #110 — "instead of needs stain, should be needs cut. saved cutting plans …
// should add a needs cutting flag".
// ---------------------------------------------------------------------------
test("#110: the flag reads needs cut, and a saved plan raises it", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "planned block");
  await addSample(page, "untouched block");
  await embed(page, "EE-1", "Batch 1");
  await embed(page, "EE-2", "Batch 2");

  const inventory = column(page, "Embedded Inventory");
  // Both blocks were auto-seeded a cutting plan at embedding, so neither is
  // flagged — that is exactly why "has a plan" cannot be the signal.
  await expect(inventory.getByText("⚑ needs cut")).toHaveCount(0);
  await expect(inventory.getByText("⚑ needs stain")).toHaveCount(0);

  // Deliberately save a plan for EE-1.
  await inventory.getByText("EE-1", { exact: true }).click();
  await page.getByRole("button", { name: "Send for Cutting" }).click();
  const dialog = page.getByRole("dialog", { name: /Send for Cutting/ });
  await expect(dialog).toBeVisible();
  // Change the plan so the save is a real change, then save it as a draft.
  await dialog.getByRole("button", { name: /Add slide/i }).click();
  await dialog.getByRole("button", { name: /^Save Plan/ }).click();
  await expect(dialog).toHaveCount(0);

  // Only the planned block is flagged, and it says "needs cut".
  await expect(inventory.getByText("⚑ needs cut")).toHaveCount(1);
  const flagged = inventory
    .locator("div.group")
    .filter({ hasText: "⚑ needs cut" });
  await expect(flagged).toContainText("EE-1");
});

// ---------------------------------------------------------------------------
// #110, the parenthetical — cutting plans "are not possible to modify / save in
// bulk". Save Plan was hidden whenever more than one block was selected.
// ---------------------------------------------------------------------------
test("#110: a cutting plan can be saved for a whole selection", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "bulk plan one");
  await addSample(page, "bulk plan two");
  await embed(page, "EE-1", "Batch 1");
  await embed(page, "EE-2", "Batch 2");

  await select(page, "EE-1");
  await select(page, "EE-2");
  await drawer(page).getByRole("button", { name: "Send for Cutting" }).click();

  const dialog = page.getByRole("dialog", { name: /Send for Cutting · 2 blocks/ });
  await expect(dialog).toBeVisible();
  // The control exists at all for a batch — it used to be hidden — and says so.
  const save = dialog.getByRole("button", { name: /^Save Plan · 2 blocks/ });
  await expect(save).toBeVisible();
  await dialog.getByRole("button", { name: /Add slide/i }).click();
  await dialog.getByRole("button", { name: /Copy to all blocks/ }).click();
  await save.click();
  await expect(dialog).toHaveCount(0);

  // BOTH blocks were planned, not just the one on screen.
  const inventory = column(page, "Embedded Inventory");
  await expect(inventory.getByText("⚑ needs cut")).toHaveCount(2, { timeout: 15000 });
});
