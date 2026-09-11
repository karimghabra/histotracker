import { expect, type Page } from "@playwright/test";
import { settleAfterDrop } from "./drag";

async function drag(page: Page, src: string, col: string): Promise<void> {
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
  await settleAfterDrop(page);
}

/**
 * Walk a block from intake to Embedded Inventory and CUT it: one slide, carrying
 * `agent`, off the microtome and into its staining rack.
 *
 * Cut means cut. Three specs used to stop at "Send for Cutting", which leaves
 * the group queued in Needs Sectioning with no glass yet, and called that a cut
 * block. The distinction stopped being academic with #125: a stain requested
 * while the cut is still queued joins that cut as one more planned slide, so a
 * spec that wanted "real glass plus an outstanding request" got two planned
 * slides and no request at all, or passed without testing what it said it did.
 *
 * The plan is exactly one slide, so no spare extra exists afterwards for a later
 * request to consume instead of flagging the block.
 */
export async function cutBlockFor(page: Page, code: string, agent: string): Promise<void> {
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

  // The plan: one slide, for `agent`.
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  const plan = page.getByRole("dialog").filter({ hasText: "How many slides to cut" });
  const rows = plan.locator(".max-h-64 > div");
  await expect(rows.first()).toBeVisible();
  while ((await rows.count()) > 1) await rows.last().getByRole("button").click();
  await rows.first().locator("select").selectOption(`stain::${agent}`);
  await expect(plan.getByText("1 slide · 1 stained · 0 extra")).toBeVisible();
  await plan.getByRole("button", { name: /Send for Cutting/ }).click();
  await expect(plan).toHaveCount(0);
  await page.locator("button:has(svg.lucide-x)").first().click(); // close drawer

  // The cut itself.
  const sectioning = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Needs Sectioning", exact: true }) });
  await sectioning.getByText(/^1 slide · /).first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  await page.locator("button:has(svg.lucide-x)").first().click(); // close drawer
  const staining = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Staining / IHC", exact: true }) });
  await expect(staining.getByText(agent).first()).toBeVisible();
}
