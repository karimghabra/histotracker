import { expect, test } from "@playwright/test";
import { openManage } from "../helpers/app";

test("#136 + #137: intake stains and embedding notes appear before sectioning", async ({ page }) => {
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

  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("Pre-sectioned block");
  await page.getByRole("checkbox", { name: "Safranin O stain", exact: true }).check();
  await page.getByLabel("Embedding Notes").fill("Embed cartilage surface facing down");
  await page.getByRole("button", { name: /Create Sample/ }).click();

  // #137 — the new intake value survives the write and is visible on the block.
  await page.getByText("EE-1", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Embedding Notes" })).toBeVisible();
  await expect(page.getByText("Embed cartilage surface facing down")).toBeVisible();
  await page.locator("button:has(svg.lucide-x)").first().click();

  // #136 — no slide exists yet, but the assigned stain is already in the Log
  // and behaves like every other stain in its filters.
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  const sampleCell = page.getByRole("cell", { name: "EE-1", exact: true });
  await expect(sampleCell).toBeVisible();
  await expect(page.getByRole("cell", { name: "Safranin O", exact: true })).toBeVisible();

  const stainFilter = page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Any stain / IHC" }) });
  await stainFilter.selectOption("Safranin O");
  await expect(sampleCell).toBeVisible();
  await stainFilter.selectOption("PAS");
  await expect(page.getByText("No samples match")).toBeVisible();

  await stainFilter.selectOption("Any stain / IHC");
  const typeFilter = page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Any type" }) });
  await typeFilter.selectOption("stain");
  await expect(sampleCell).toBeVisible();
  await typeFilter.selectOption("ihc");
  await expect(page.getByText("No samples match")).toBeVisible();
});
