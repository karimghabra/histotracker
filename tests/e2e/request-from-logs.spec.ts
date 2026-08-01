import { test, expect, type Page } from "@playwright/test";

// #64 — a stain request can be raised from the Logs view with the sample already
// filled in (no typing the sample code).

async function boot(page: Page) {
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
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("Loggable block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-1")).toBeVisible();
}

test("request a stain from the Logs view with the sample pre-filled (#64)", async ({ page }) => {
  await boot(page);

  // Go to Logs and expand the sample row.
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();

  // The row exposes a one-click "Request stain for EE-1" — no typing.
  await page.getByRole("button", { name: /Request stain for EE-1/ }).click();
  await expect(page.getByRole("heading", { name: "Request a stain" })).toBeVisible();

  // The sample is already selected in the dialog.
  await expect(page.getByLabel("Sample")).toHaveValue("EE-1");

  // Pick an agent and send.
  await page.getByLabel("Requested stain / IHC").selectOption({ label: "H&E (stain)" });
  await page.getByRole("button", { name: /Send request/ }).click();
  await expect(page.getByText(/Requested H&E for EE-1/)).toBeVisible();
});
