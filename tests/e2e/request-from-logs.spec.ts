import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";

// #64 — a stain request can be raised from the Logs view with the sample already
// filled in (no typing the sample code).

async function boot(page: Page) {
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
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("Loggable block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-1")).toBeVisible();
}

test("ask for a stain from the Logs view with the sample pre-filled (#64/#114)", async ({
  page,
}) => {
  await boot(page);

  // Go to Logs and expand the sample row.
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();

  // #64's property, under #114's mechanism: the control is already scoped to the
  // row's sample — its label names the block, there is no sample chooser to fill
  // in, and no code to type. The label carries the DISPLAY form (#87) while the
  // stored code is still the padded "EE-0001".
  const add = page.getByLabel("Add a stain to EE-1");
  await expect(add).toBeVisible();
  await expect(page.getByLabel("Sample")).toHaveCount(0);

  // #114: it adds, rather than filing a sync request with this same workstation.
  await expect(page.getByRole("button", { name: /Request stain for EE-1/ })).toHaveCount(0);
  await add.selectOption("stain::H&E");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Request a stain" })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(/H&E/, { timeout: 15000 });
});
