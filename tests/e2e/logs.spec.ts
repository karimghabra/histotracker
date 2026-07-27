import { test, expect, type Page } from "@playwright/test";

async function seedSampleWithSlides(page: Page) {
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
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("Logs block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-0001")).toBeVisible();

  // Pre-processing → processor → embed.
  await page.getByText("EE-0001", { exact: true }).click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await drag(page, "EE-0001", "Processor");
  // A background refetch can momentarily blank the active operator and no-op the
  // Start-Batch click, so retry until the batch actually appears.
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await drag(page, "Batch 1", "Needs Embedding");
  await drag(page, "EE-0001", "Embedded Inventory");

  // Send for cutting with one stained slide (index 1 = first catalog stain).
  await page.getByText("EE-0001", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Extra (no stain)" }) })
    .first()
    .selectOption({ index: 1 });
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click(); // close drawer
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
}

test("Logs: table, drill-down, and stain filter", async ({ page }) => {
  await seedSampleWithSlides(page);

  // Go to the Logs view (scope to the sidebar nav).
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await expect(page.getByRole("columnheader", { name: /Sample ID/ })).toBeVisible();
  const sampleCell = page.getByRole("cell", { name: "EE-0001", exact: true });
  await expect(sampleCell).toBeVisible();
  // The stains summary shows the stain we cut.
  await expect(page.getByRole("cell", { name: /Alcian Blue/ }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/logs-table.png", fullPage: true });

  // Filter by that stain → the sample stays; filter by an unused one → it drops.
  const stainSelect = page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Any stain" }) });
  await stainSelect.selectOption("Alcian Blue");
  await expect(sampleCell).toBeVisible();
  await stainSelect.selectOption("PAS");
  await expect(page.getByText("No samples match")).toBeVisible();
  await stainSelect.selectOption("Any stain / IHC");

  // Expand the sample → sample timeline + its slides drill in.
  await sampleCell.click();
  await expect(page.getByText("Sample timeline")).toBeVisible();
  const slideRow = page.getByRole("button", { name: /EE-0001-A/ });
  await expect(slideRow).toBeVisible();
  // Sample notes persist through a refetch.
  const sampleNotes = page.getByPlaceholder("Notes about this sample…");
  await sampleNotes.fill("Block looks good");
  await sampleNotes.blur();
  await expect(sampleNotes).toHaveValue("Block looks good");

  // Expand the slide → its own (separate) timeline, starting at Cut.
  await slideRow.click();
  await expect(page.getByText(/Cut/).first()).toBeVisible();

  // Slide notes persist too.
  const slideNotes = page.getByPlaceholder("Notes about this slide…");
  await slideNotes.fill("Faint staining");
  await slideNotes.blur();
  await expect(slideNotes).toHaveValue("Faint staining");

  // Collapse + re-expand the sample: both notes survive (read back from the DB).
  await sampleCell.click();
  await sampleCell.click();
  await expect(page.getByPlaceholder("Notes about this sample…")).toHaveValue("Block looks good");
  // The slide stayed expanded, so its notes are read straight back from the DB.
  await expect(page.getByPlaceholder("Notes about this slide…")).toHaveValue("Faint staining");
  await page.screenshot({ path: "test-results/logs-expanded.png", fullPage: true });

  // Sorting: clicking a header keeps the sample listed.
  await page.getByRole("columnheader", { name: /Slides/ }).click();
  await expect(sampleCell).toBeVisible();
});
