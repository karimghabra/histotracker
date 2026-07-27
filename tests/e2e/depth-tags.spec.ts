import { test, expect, type Page } from "@playwright/test";

// #69 — select multiple slides in the Logs view and tag them as a depth grouping
// with a note.

async function dragOnto(page: Page, sourceText: string, columnTitle: string) {
  const card = page.getByText(sourceText, { exact: true });
  const header = page.getByRole("heading", { name: columnTitle, exact: true });
  const from = await card.boundingBox();
  const to = await header.boundingBox();
  if (!from || !to) throw new Error("drag endpoints missing");
  const dropX = to.x + to.width / 2;
  const dropY = to.y + 140;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 4 });
  await page.mouse.move(dropX, dropY, { steps: 10 });
  await page.mouse.move(dropX, dropY + 2, { steps: 3 });
  await page.mouse.up();
}

async function seedCutSample(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Signed-in user").locator("option", { hasText: "Alex Rivera" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  const overlay = page.locator("div.fixed.inset-0.z-50");
  if (await overlay.count()) await overlay.first().click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("Depth block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-0001")).toBeVisible();

  // Embed.
  await page.getByText("EE-0001", { exact: true }).first().click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await dragOnto(page, "EE-0001", "Processor");
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await dragOnto(page, "Batch 1", "Needs Embedding");
  await dragOnto(page, "EE-0001", "Embedded Inventory");

  // Cut the default plan (4 extras).
  await page.getByText("EE-0001", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();
}

test("select slides in Logs and tag them at a depth (#69)", async ({ page }) => {
  await seedCutSample(page);

  // Go to Logs and open the sample's slide list.
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-0001", exact: true }).click();

  // Select two slides via their checkboxes.
  await page.getByRole("checkbox", { name: "Select slide EE-0001-A" }).check();
  await page.getByRole("checkbox", { name: "Select slide EE-0001-B" }).check();
  await expect(page.getByText("2 slides selected")).toBeVisible();

  // Tag them at a depth with a note.
  await page.getByRole("button", { name: "Tag depth" }).click();
  await expect(page.getByRole("heading", { name: /Tag 2 slides at a depth/ })).toBeVisible();
  await page.getByLabel("Depth label").fill("100um deep");
  await page.getByLabel("Note (optional)").fill("mid-section");
  await page.getByRole("button", { name: /Apply tag/ }).click();

  // The depth badge now shows on both slides.
  await expect(page.getByText("100um deep")).toHaveCount(2);
});
