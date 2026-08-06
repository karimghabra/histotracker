import { test, expect, type Page } from "@playwright/test";
import { openBackups, openManage } from "../helpers/app";

// End-to-end backup + revert against the real snapshot/restore rails (sql.js
// shim). Proves: a manual backup is written and listed, and reverting to it
// restores the exact database state — a later change is rolled back.

async function seedSample(page: Page, description: string) {
  await page.getByRole("button", { name: "New Sample" }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toBeVisible();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(description);
  await page.getByRole("button", { name: /Create Sample/ }).click();
}

async function firstSample(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
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
  await seedSample(page, "First block");
  await expect(page.getByText("EE-1")).toBeVisible();
}

test("manual backup captures state; revert rolls back a later change", async ({ page }) => {
  // Auto-accept the revert/confirm dialogs.
  page.on("dialog", (d) => void d.accept());

  await firstSample(page); // EE-1 exists

  // Take a manual backup of the current state (only EE-1 present).
  await openBackups(page);
  await expect(page.getByRole("heading", { name: "Database backups" })).toBeVisible();
  await page.getByRole("button", { name: "Back up now" }).click();
  // The new backup row appears (reason "Manual").
  await expect(page.getByText("Manual").first()).toBeVisible({ timeout: 10000 });
  // Close the dialog (Modal closes on Escape).
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Database backups" })).toHaveCount(0);

  // Make a change the backup does NOT contain: add EE-2.
  await seedSample(page, "Second block");
  await expect(page.getByText("EE-2")).toBeVisible();

  // Revert to the backup → EE-2 must disappear, EE-1 remains.
  await openBackups(page);
  await expect(page.getByRole("heading", { name: "Database backups" })).toBeVisible();
  await page.getByRole("button", { name: "Revert" }).first().click();

  // Board is back to just EE-1.
  await expect(page.getByText("EE-2")).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByText("EE-1").first()).toBeVisible();
});
