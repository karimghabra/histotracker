import { expect, type Page } from "@playwright/test";
import { openManage, openNewSample } from "./app";

// Held in a variable so only the page resolves it (a browser-absolute path).
export const DB = "/src/lib/db.ts";

export async function boot(page: Page, user = "Alex Rivera"): Promise<void> {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({ timeout: 20_000 });
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill(user);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Signed-in user").locator("option", { hasText: user })).toHaveCount(1);
  await page.keyboard.press("Escape");
  const overlay = page.locator("div.fixed.inset-0.z-50");
  if (await overlay.count()) await overlay.first().click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
  await page.getByLabel("Signed-in user").selectOption({ label: user });
}

export async function addProject(page: Page, code: string, name: string): Promise<void> {
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill(code);
  await page.locator('input[placeholder="Enthesis Engineering"]').fill(name);
  await page.getByRole("button", { name: "Save Project" }).click();
  await expect(page.getByRole("button", { name: "Save Project" })).toHaveCount(0);
}

export async function addSample(page: Page, description: string, projectCode?: string): Promise<void> {
  await openNewSample(page, projectCode);
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(description);
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByRole("button", { name: /Create Sample/ })).toHaveCount(0);
}

export async function signOutAndBackIn(page: Page, user = "Alex Rivera"): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  const dialog = page.getByRole("dialog", { name: "Signed out" });
  await dialog.getByLabel("Sign back in").selectOption({ label: user });
  await expect(dialog).toHaveCount(0);
}
