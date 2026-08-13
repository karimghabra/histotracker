import { expect, type Page } from "@playwright/test";

/**
 * Ask for a stain on a block, from the Logs.
 *
 * #113 removed the Add-a-Stain control from the Embedded Inventory drawer — a
 * block sitting there has no glass, so the control could only consume a free
 * extra from an earlier cut, which reads in the log as "this block was stained".
 * The Logs row is the entry point that survives, and #114 made it add directly
 * instead of filing a sync request with the workstation the user is sitting at.
 *
 * The BEHAVIOUR the older specs assert — outstanding requests, the needs-cut
 * flag, prefilled cutting plans, refusals — is unchanged; only the control that
 * triggers it moved. This helper is that move, in one place.
 *
 * `value` is the select's option value, e.g. `stain::H&E` or `ihc::Ki-67`.
 * Returns the flash text, which is where a refusal (#70) is reported.
 */
export async function addStainFromLogs(page: Page, code: string, value: string): Promise<string> {
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();

  const select = page.getByLabel(`Add a stain to ${code}`);
  // Clicking an already-expanded row collapses it, so only open what is shut.
  if (!(await select.isVisible().catch(() => false))) {
    await page.getByRole("cell", { name: code, exact: true }).click();
  }
  await expect(select).toBeVisible({ timeout: 15000 });
  await select.selectOption(value);

  // Only one row is expanded at a time, so the controls are unambiguous.
  //
  // Read the flash through count() first: textContent() on a locator matching
  // NOTHING waits with no timeout of its own, so before the first add — when
  // there is no status element yet — it hangs until the whole test times out.
  const flash = page.getByRole("status");
  const read = async () => ((await flash.count()) ? ((await flash.first().textContent()) ?? "") : "");
  const before = await read();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(async () => {
    const now = await read();
    expect(now).not.toBe(before);
    expect(now.trim()).not.toBe("");
  }).toPass({ timeout: 15000 });
  return (await read()).trim();
}

/**
 * Open a block's drawer, if the trip through the Logs closed it.
 *
 * Never click blind: clicking an already-selected tile toggles the drawer SHUT
 * (#61), so a bare click is a coin flip on whether the panel ends up open.
 */
export async function openBlockDrawer(page: Page, code: string): Promise<void> {
  const timeline = page.getByRole("heading", { name: "Timeline" });
  if (await timeline.isVisible().catch(() => false)) return;
  await page.getByText(code, { exact: true }).first().click();
  await expect(timeline).toBeVisible({ timeout: 15000 });
}

/** …then go back to the board, which is where most of these specs assert. */
export async function addStainFromLogsAndReturn(
  page: Page,
  code: string,
  value: string,
): Promise<string> {
  const flash = await addStainFromLogs(page, code, value);
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  return flash;
}
