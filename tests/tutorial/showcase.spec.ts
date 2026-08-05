import { test, expect, type Page } from "@playwright/test";
import { settleAfterDrop } from "../helpers/drag";

// Walks the whole Histometer pipeline and captures screenshots for the tutorial
// (docs/tutorial/README.md). Not part of the CI e2e suite — run on demand:
//   npx playwright test --config playwright.showcase.config.ts
//
// Each shot() writes docs/tutorial/img/<name>.png. The flow is sequential: one
// sample (EE-0001) is carried from intake all the way to imaging, then the Logs,
// depth-tagging, requests, exports and backups features are shown.

const IMG = "docs/tutorial/img";
async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForTimeout(250); // let any re-render settle
  await page.screenshot({ path: `${IMG}/${name}.png`, fullPage });
}

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
  // dnd-kit swallows every click for 50ms after a drop — wait it out.
  await settleAfterDrop(page);
}
const closeDrawer = (page: Page) => page.locator("button:has(svg.lucide-x)").first().click();

test("Histometer feature walkthrough → tutorial screenshots", async ({ page }) => {
  test.setTimeout(180_000);

  // ---- Intake: users, project, sample -------------------------------------
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await shot(page, "01-board-empty");

  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Signed-in user").locator("option", { hasText: "Alex Rivera" })).toHaveCount(1);
  await shot(page, "02-manage");
  await page.keyboard.press("Escape");
  const overlay = page.locator("div.fixed.inset-0.z-50");
  if (await overlay.count()) await overlay.first().click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });

  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await shot(page, "03-add-project");
  await page.getByRole("button", { name: "Save Project" }).click();

  await page.getByRole("button", { name: "New Sample" }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toBeVisible();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("2 week stretch, PLA scaffold");
  await shot(page, "04-new-sample");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-0001")).toBeVisible();
  await shot(page, "05-board-intake");

  // ---- Sample drawer: preprocessing, project, request a stain -------------
  await page.getByText("EE-0001", { exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await shot(page, "06-sample-drawer");
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await closeDrawer(page);

  // ---- Processing run ------------------------------------------------------
  await dragOnto(page, "EE-0001", "Processor");
  await expect(page.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await shot(page, "07-processing-batch");
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await shot(page, "08-processor-running");
  await dragOnto(page, "Batch 1", "Needs Embedding");
  await dragOnto(page, "EE-0001", "Embedded Inventory");
  await shot(page, "09-embedded");

  // ---- Send for Cutting ----------------------------------------------------
  await page.getByText("EE-0001", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await expect(page.getByText(/How many slides to cut/i)).toBeVisible();
  // Make slide #1 an H&E stain to show the mixed plan.
  await page.locator(".max-h-64 select").first().selectOption({ label: "H&E" });
  await shot(page, "10-send-for-cutting");
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await closeDrawer(page);
  await shot(page, "11-needs-sectioning");

  // ---- Mark sectioned → staining rack + protocol --------------------------
  const col = (title: string) =>
    page.locator("div.rounded-lg").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await page.getByText(/slides$/).first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  await closeDrawer(page);
  await col("Staining / IHC").getByText("H&E").first().click();
  await expect(page.getByText(/Stain workflow/i)).toBeVisible();
  await page.getByLabel("Active operator").fill("Alex");
  await shot(page, "12-staining-protocol");

  // Run the protocol to scatter into Ready for Imaging.
  for (const step of ["Stained", "Coverslipped"]) {
    await page.getByRole("button", { name: step, exact: true }).click();
  }
  await expect(col("Ready for Imaging").getByText("EE-0001").first()).toBeVisible({ timeout: 15000 });
  await shot(page, "13-ready-for-imaging");

  // ---- Logs view -----------------------------------------------------------
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await expect(page.getByRole("cell", { name: "EE-0001", exact: true })).toBeVisible();
  await shot(page, "14-logs", true);

  // Drill in, select slides, tag a depth.
  await page.getByRole("cell", { name: "EE-0001", exact: true }).click();
  const boxes = page.getByRole("checkbox", { name: /Select slide/ });
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await shot(page, "15-logs-slides-selected", true);
  await page.getByRole("button", { name: "Create Tag" }).click();
  await expect(page.getByRole("heading", { name: /Tag 2 slides at a depth/ })).toBeVisible();
  await page.getByLabel("Depth label").fill("100µm deep");
  await page.getByLabel("Note (optional)").fill("mid-section pair");
  await shot(page, "16-depth-tag-dialog");
  await page.getByRole("button", { name: /Apply tag/ }).click();
  await expect(page.getByText("100µm deep").first()).toBeVisible();
  await shot(page, "17-depth-tag-applied", true);

  // Request a stain from the Logs row.
  await page.getByRole("button", { name: /Request stain for EE-0001/ }).click();
  await expect(page.getByRole("heading", { name: "Request a stain" })).toBeVisible();
  await page.getByLabel("Requested stain / IHC").selectOption({ label: "CD3 (ihc)" });
  await shot(page, "18-request-stain");
  await page.keyboard.press("Escape");

  // ---- Exports + Backups ---------------------------------------------------
  await page.getByRole("button", { name: "Export" }).click();
  await shot(page, "19-export-menu");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Backups" }).click();
  await expect(page.getByRole("heading", { name: "Database backups" })).toBeVisible();
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByText("Manual").first()).toBeVisible({ timeout: 10000 });
  await shot(page, "20-backups");
});
