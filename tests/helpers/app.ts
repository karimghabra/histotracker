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

/**
 * Reveal removed blocks and slides in the Logs.
 *
 * They are hidden by default from 0.10.0 (#105), the same as archived ones, so
 * any spec that asserts a removal is still in the record has to ask for it —
 * which is also the honest thing for those specs to be checking.
 */
export async function showRemoved(page: Page): Promise<void> {
  const toggle = page.getByLabel("Show removed");
  await expect(toggle).toBeVisible();
  if (!(await toggle.isChecked())) await toggle.check();
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

/**
 * Open the New Sample dialog and answer its project picker (#132).
 *
 * The project used to be inherited from the sidebar, so a spec could select a
 * project and then create samples without naming one again. #132 makes the
 * dialog ask, which is the point of the issue and also breaks every spec that
 * relied on the old coupling — eleven of them.
 *
 * Defined once rather than fixed eleven times: the next change to this dialog
 * should be one edit, not eleven chances to look like eleven unrelated failures.
 * That is the same reason `helpers/rack.ts` exists.
 *
 * `projectCode` is required whenever the lab has more than one project. With a
 * single project the dialog answers itself, and the argument may be omitted.
 */
export async function openNewSample(page: Page, projectCode?: string): Promise<void> {
  await page.getByRole("button", { name: "New Sample" }).click();
  const picker = page.getByLabel("Project for these samples");
  await expect(picker).toBeVisible();
  if (!projectCode) {
    // Nothing to choose between, so the dialog has already chosen. If it has
    // not, the caller genuinely needed to say which project, and saying so here
    // beats a sixty-second wait on a Create button that will never enable.
    await expect(
      picker,
      "more than one project exists — openNewSample needs a project code",
    ).not.toHaveValue("");
    return;
  }
  const value = await picker
    .locator("option")
    .filter({ hasText: new RegExp(`^${projectCode} \u00b7`) })
    .first()
    .getAttribute("value");
  expect(value, `no project named ${projectCode} in the picker`).toBeTruthy();
  await picker.selectOption(value!);
}
