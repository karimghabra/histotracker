import { test, expect, type Page } from "@playwright/test";

// #84 — the active project drives which project a new sample lands in, so it has
// to be obvious at a glance. Three projects, so "which one is selected?" is a
// real question; screenshots in both light and dark for a human to judge.

async function boot(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByLabel("Signed-in user").locator("option", { hasText: "Alex Rivera" }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
}

async function addProject(page: Page, code: string, name: string) {
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill(code);
  await page.locator('input[placeholder="Enthesis Engineering"]').fill(name);
  await page.getByRole("button", { name: "Save Project" }).click();
}

test("#84: the selected project stands out against its neighbours", async ({ page }) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addProject(page, "CART", "Cartilage Repair");
  await addProject(page, "TEND", "Tendon Healing");

  const sidebar = page.locator("aside");
  const active = sidebar.locator('button[aria-current="true"]');

  // Exactly one project is marked, and it carries an explicit ACTIVE badge.
  await expect(active).toHaveCount(1);
  await expect(active.getByText("Active", { exact: true })).toBeVisible();

  // Select a different project — the marker follows the click.
  await sidebar.getByText("Cartilage Repair").click();
  await expect(active).toHaveCount(1);
  await expect(active).toContainText("Cartilage Repair");
  await expect(active).toContainText("CART");

  await sidebar.screenshot({ path: "test-results/84-sidebar-light.png" });

  await page.getByLabel("Visual theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await sidebar.screenshot({ path: "test-results/84-sidebar-dark.png" });

  await page.getByLabel("Visual theme").selectOption("matcha");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "matcha");
  await sidebar.screenshot({ path: "test-results/84-sidebar-matcha.png" });
});
