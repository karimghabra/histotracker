import { test, expect, type Locator, type Page } from "@playwright/test";
import { boot, addProject, addSample } from "../helpers/lab";
import { settleAfterDrop } from "../helpers/drag";

/**
 * A group waiting in Needs Sectioning cannot be dragged straight to Ready for
 * Imaging: the slides would read as cut and imaged with nothing done at the bench.
 * The captain's ruling is to deny it; every other drag keeps working.
 */

async function dragTo(page: Page, card: Locator, columnTitle: string) {
  const header = page.getByRole("heading", { name: columnTitle, exact: true });
  const from = await card.boundingBox();
  const to = await header.boundingBox();
  if (!from || !to) throw new Error(`drag endpoints missing for ${columnTitle}`);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + 140, { steps: 10 });
  await page.mouse.move(to.x + to.width / 2, to.y + 142, { steps: 3 });
  await page.mouse.up();
  await settleAfterDrop(page);
}

function column(page: Page, title: string) {
  return page.locator("div.rounded-lg").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

/** Take a block to Embedded Inventory through the board. */
async function embed(page: Page, code: string) {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await dragTo(page, page.getByText(code, { exact: true }).first(), "Processor");
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await dragTo(page, page.getByText("Batch 1", { exact: true }).first(), "Needs Embedding");
  await dragTo(page, page.getByText(code, { exact: true }).first(), "Embedded Inventory");
}

/** Send the block for cutting with one H&E slide, leaving the group in Needs Sectioning. */
async function queueOneSlide(page: Page, code: string) {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  const plan = page.getByRole("dialog").filter({ hasText: "How many slides to cut" });
  const rows = plan.locator(".max-h-64 > div");
  await expect(rows.first()).toBeVisible();
  while ((await rows.count()) > 1) await rows.last().getByRole("button").click();
  await rows.first().locator("select").selectOption("stain::H&E");
  await plan.getByRole("button", { name: /Send for Cutting/ }).click();
  await expect(plan).toHaveCount(0);
  await page.locator("button:has(svg.lucide-x)").first().click();
}

test("a group in Needs Sectioning cannot be dragged to Ready for Imaging, and can still be cut", async ({ page }) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addSample(page, "skips the cut");
  await embed(page, "EE-1");
  await queueOneSlide(page, "EE-1");

  const waiting = column(page, "Needs Sectioning").getByText(/^1 slide · /).first();
  await expect(waiting).toBeVisible();

  await dragTo(page, waiting, "Ready for Imaging");
  await expect(page.getByText(/must be cut first/i)).toBeVisible();
  // Nothing moved: the group is still waiting to be cut, and Ready for Imaging is empty.
  await expect(column(page, "Needs Sectioning").getByText(/^1 slide · /).first()).toBeVisible();
  await expect(column(page, "Ready for Imaging").getByText(/^1 slide · /)).toHaveCount(0);

  // The ordinary way still works: cut it, and it moves on to staining.
  await column(page, "Needs Sectioning").getByText(/^1 slide · /).first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await expect(column(page, "Staining / IHC").getByText("H&E").first()).toBeVisible();
});
