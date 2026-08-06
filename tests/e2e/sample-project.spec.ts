import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";

// #60 — a sample's project can be changed after creation; it is re-numbered
// under the new project.

async function addProject(page: Page, code: string, name: string) {
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill(code);
  await page.locator('input[placeholder="Enthesis Engineering"]').fill(name);
  await page.getByRole("button", { name: "Save Project" }).click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toHaveCount(0);
}

test("a sample can be moved to a different project and is re-numbered (#60)", async ({ page }) => {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Signed-in user").locator("option", { hasText: "Alex Rivera" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  const overlay = page.locator("div.fixed.inset-0.z-50");
  if (await overlay.count()) await overlay.first().click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });

  await addProject(page, "EE", "Enthesis Engineering");
  await addProject(page, "BB", "Bone Biology");

  // Create the sample under EE (the first project is selected by default).
  await page.locator("aside").getByText("Enthesis Engineering").click();
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("Misfiled block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-1")).toBeVisible();

  // Open it and move it to project BB via the Project dropdown.
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByLabel("Sample project").selectOption({ label: "Bone Biology (BB)" });

  // It is re-numbered under BB, and the old EE code is gone.
  await expect(page.getByText("BB-1").first()).toBeVisible();
  await expect(page.getByText("EE-1")).toHaveCount(0);
});
