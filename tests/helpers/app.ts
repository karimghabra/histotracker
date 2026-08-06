import { expect, type Page } from "@playwright/test";

/**
 * Open the Manage dialog.
 *
 * It used to be a button in the header; #94 moved it (with Backups and the
 * theme picker) into the settings dialogue reached from the cog at the foot of
 * the left panel. Every spec that adds a user goes through here, so the route is
 * defined once — 23 specs hard-coding a two-step click path is 23 chances for a
 * later move to look like 23 unrelated failures.
 *
 * `exact` on "Settings": the sync pill's cog is titled "Sync settings", which a
 * substring match would also hit.
 */
export async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

export async function openManage(page: Page): Promise<void> {
  await openSettings(page);
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: /Manage users/ })
    .click();
}

/** Pick a theme. The picker moved from the header into Settings (#94). */
export async function setTheme(page: Page, value: string): Promise<void> {
  await openSettings(page);
  await page.getByLabel("Visual theme").selectOption(value);
  await page.getByRole("dialog", { name: "Settings" }).press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
}

export async function openBackups(page: Page): Promise<void> {
  await openSettings(page);
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: /Backups/ })
    .click();
}
