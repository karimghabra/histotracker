import { test, expect, type Page } from "@playwright/test";
import { settleAfterDrop } from "../helpers/drag";

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

async function seedAndEmbed(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("Cut block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-1")).toBeVisible();

  await page.getByText("EE-1", { exact: true }).click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await drag(page, "EE-1", "Processor");
  // A background refetch can momentarily blank the active operator and no-op the
  // Start-Batch click, so retry until the batch actually appears.
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await drag(page, "Batch 1", "Needs Embedding");
  await drag(page, "EE-1", "Embedded Inventory");
}

test("re-opening Send for Cutting after a cut starts a fresh plan", async ({ page }) => {
  await seedAndEmbed(page);

  // First cut: fresh embedded block → default 4 extras, 0 stained. Add a stain.
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await expect(page.getByText(/0 stained/)).toBeVisible();
  await page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Extra (no stain)" }) })
    .first()
    .selectOption({ index: 1 });
  await expect(page.getByText(/1 stained/)).toBeVisible();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click(); // close drawer

  // Re-open → the just-cut plan was archived + cleared, so the plan is FRESH
  // (back to 0 stained), not the 1-stain plan we just sent.
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await expect(page.getByText(/0 stained/)).toBeVisible();
  await expect(page.getByText(/1 stained/)).toHaveCount(0);
});
