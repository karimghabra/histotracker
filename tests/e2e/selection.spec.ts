import { test, expect, type Page } from "@playwright/test";

// #61 — a tile can be de-selected by clicking it again (or its checkbox), and
// de-selecting must NOT re-open the right-hand detail panel.

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
  await expect(page.getByRole("heading", { name: /New Sample/ })).toBeVisible();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("Selectable block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-0001")).toBeVisible();
}

// The detail drawer always renders a "Timeline" section — use it as the
// open/closed signal.
const drawerOpen = (page: Page) => page.getByRole("heading", { name: "Timeline" });

test("clicking a tile again de-selects it and closes the panel (#61)", async ({ page }) => {
  await boot(page);
  const tile = page.getByText("EE-0001", { exact: true }).first();

  // First click opens the detail panel.
  await tile.click();
  await expect(drawerOpen(page)).toBeVisible();

  // Second click on the same tile closes it (de-select) — not re-open.
  await tile.click();
  await expect(drawerOpen(page)).toHaveCount(0);

  // And it can be re-opened again (state is truly toggled, not stuck).
  await tile.click();
  await expect(drawerOpen(page)).toBeVisible();
});

test("un-ticking a tile's checkbox closes the panel; ticking opens it (#61)", async ({ page }) => {
  await boot(page);
  const checkbox = page.getByRole("checkbox", { name: "Select EE-0001" }).first();

  await checkbox.check();
  await expect(drawerOpen(page)).toBeVisible();

  await checkbox.uncheck();
  await expect(drawerOpen(page)).toHaveCount(0);
});
