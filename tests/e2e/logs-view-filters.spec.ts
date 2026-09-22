import { test, expect, type Page } from "../helpers/test";
import { openManage } from "../helpers/app";
import { addProject, addSample, boot, signOutAndBackIn } from "../helpers/lab";
import { readShimTextBySuffix } from "../helpers/shim-fs";

/**
 * The Logs view's project scope and its defaults:
 *   #161 a deactivated project's blocks are not listed (and come back on reactivation),
 *   #160 the sidebar's project selection filters the Logs as it does the Board,
 *   #158 "Show archived" and "Show removed" start ON.
 * Driven through the real UI against the sql.js shim.
 */

const logsNav = (page: Page) => page.locator("nav").getByRole("button", { name: "Logs" });
const boardNav = (page: Page) => page.locator("nav").getByRole("button", { name: "Board" });
const cell = (page: Page, code: string) => page.getByRole("cell", { name: code, exact: true });
const sidebarProject = (page: Page, name: RegExp | string) =>
  page.locator("aside").first().getByRole("button", { name });
const logsProject = (page: Page) => page.getByLabel("Filter the Logs by project");
const logsProjectShown = (page: Page) => logsProject(page).locator("option:checked");

/** Two projects with one block each: EE-1 and ZZ-1. */
async function twoProjects(page: Page) {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addProject(page, "ZZ", "Zebrafish Zone");
  await addSample(page, "enthesis block", "EE");
  await addSample(page, "zebrafish block", "ZZ");
  await sidebarProject(page, "All projects").click();
}

async function setProjectActive(page: Page, name: string, active: boolean) {
  await openManage(page);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  const manage = page.getByRole("dialog", { name: "Manage" });
  const row = manage.locator("div.rounded-lg").filter({ hasText: name });
  await row.getByRole("button", { name: active ? "Reactivate" : "Deactivate", exact: true }).click();
  await expect(row.getByRole("button", { name: active ? "Deactivate" : "Reactivate", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(manage).toHaveCount(0);
}

async function exportedCsv(page: Page): Promise<string> {
  await page.getByRole("button", { name: "CSV", exact: true }).click();
  await expect(page.getByText("Exported.")).toBeVisible();
  const csv = await readShimTextBySuffix(page, ".csv");
  expect(csv).not.toBeNull();
  return csv as string;
}

test("#161: the Logs do not list a deactivated project, and list it again once reactivated", async ({ page }) => {
  await twoProjects(page);
  await logsNav(page).click();
  await expect(cell(page, "EE-1")).toBeVisible();
  await expect(cell(page, "ZZ-1")).toBeVisible();

  await setProjectActive(page, "Zebrafish Zone", false);
  await expect(cell(page, "EE-1")).toBeVisible();
  await expect(cell(page, "ZZ-1")).toHaveCount(0);
  // The export follows the view.
  const whileInactive = await exportedCsv(page);
  expect(whileInactive).toContain("EE-1");
  expect(whileInactive).not.toContain("ZZ-1");

  // Nothing was deleted: reactivating brings the block straight back.
  await setProjectActive(page, "Zebrafish Zone", true);
  await expect(cell(page, "ZZ-1")).toBeVisible();
});

test("#160: the sidebar's project selection filters the Logs, and the export follows it", async ({ page }) => {
  await twoProjects(page);
  await logsNav(page).click();
  await expect(cell(page, "EE-1")).toBeVisible();
  await expect(cell(page, "ZZ-1")).toBeVisible();

  await sidebarProject(page, /Zebrafish/).click();
  await expect(cell(page, "ZZ-1")).toBeVisible();
  await expect(cell(page, "EE-1")).toHaveCount(0);
  const zzOnly = await exportedCsv(page);
  expect(zzOnly).toContain("ZZ-1");
  expect(zzOnly).not.toContain("EE-1");

  await sidebarProject(page, /Enthesis/).click();
  await expect(cell(page, "EE-1")).toBeVisible();
  await expect(cell(page, "ZZ-1")).toHaveCount(0);

  // The same selection is what the Board filters by.
  await boardNav(page).click();
  await expect(page.getByText("EE-1", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("ZZ-1", { exact: true })).toHaveCount(0);

  await sidebarProject(page, "All projects").click();
  await logsNav(page).click();
  await expect(cell(page, "EE-1")).toBeVisible();
  await expect(cell(page, "ZZ-1")).toBeVisible();
});

test("#160: the Logs' project dropdown and the sidebar are one selection, set from either side", async ({ page }) => {
  await twoProjects(page);
  await logsNav(page).click();
  await expect(logsProjectShown(page)).toHaveText("All projects");

  // Sidebar → dropdown.
  await sidebarProject(page, /Zebrafish/).click();
  await expect(logsProjectShown(page)).toHaveText("ZZ");
  await expect(cell(page, "EE-1")).toHaveCount(0);

  // Dropdown → sidebar, and on to the Board.
  await logsProject(page).selectOption({ label: "EE" });
  await expect(sidebarProject(page, /Enthesis/)).toHaveAttribute("aria-current", "true");
  await expect(cell(page, "EE-1")).toBeVisible();
  await expect(cell(page, "ZZ-1")).toHaveCount(0);
  await boardNav(page).click();
  await expect(page.getByText("EE-1", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("ZZ-1", { exact: true })).toHaveCount(0);

  await logsNav(page).click();
  await logsProject(page).selectOption({ label: "All projects" });
  await expect(sidebarProject(page, "All projects")).toHaveAttribute("aria-current", "true");
  await expect(cell(page, "EE-1")).toBeVisible();
  await expect(cell(page, "ZZ-1")).toBeVisible();
});

test("#160 with #140: signing out clears the selection, so the Logs are unfiltered again", async ({ page }) => {
  await twoProjects(page);
  await logsNav(page).click();
  await logsProject(page).selectOption({ label: "ZZ" });
  await expect(cell(page, "EE-1")).toHaveCount(0);

  await signOutAndBackIn(page);
  await logsNav(page).click();
  await expect(logsProjectShown(page)).toHaveText("All projects");
  await expect(sidebarProject(page, "All projects")).toHaveAttribute("aria-current", "true");
  await expect(cell(page, "EE-1")).toBeVisible();
  await expect(cell(page, "ZZ-1")).toBeVisible();
});

test("#158: Show archived and Show removed start on, and a choice made is remembered", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addSample(page, "kept");
  await addSample(page, "to archive");
  await logsNav(page).click();

  // Both toggles are on from the first look at the Logs.
  await expect(page.getByLabel("Show archived")).toBeChecked();
  await expect(page.getByLabel("Show removed")).toBeChecked();

  // An archived block stays in the list, without anyone asking for it.
  await cell(page, "EE-2").click();
  await page.getByRole("button", { name: "Archive EE-2" }).click();
  await expect(cell(page, "EE-2")).toBeVisible();
  await expect(cell(page, "EE-1")).toBeVisible();

  // Turning one off is a choice: it hides the block and survives leaving the view.
  await page.getByLabel("Show archived").uncheck();
  await expect(cell(page, "EE-2")).toHaveCount(0);
  await boardNav(page).click();
  await logsNav(page).click();
  await expect(page.getByLabel("Show archived")).not.toBeChecked();
  await expect(cell(page, "EE-2")).toHaveCount(0);
  await expect(page.getByLabel("Show removed")).toBeChecked();
});
