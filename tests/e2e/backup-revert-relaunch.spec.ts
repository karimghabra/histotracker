import { test, expect, type Page } from "@playwright/test";
import { openBackups, openManage } from "../helpers/app";
import { MIGRATIONS, NEWEST, fromANewerVersion, preMigrationImage } from "../helpers/images";

// Reverting to a backup, then closing the app and opening it again.
//
// The app runs its numbered migrations when it launches, and records each one
// inside the database file (`_sqlx_migrations`). A revert swaps a whole image in
// mid-session, so a backup older than the newest migration arrives with a record
// that lacks it. getDb() then adds the missing columns, which kept the session
// working, but the record still said the migrations had never run: at the next
// launch the migrator ran them again on top of those columns, stopped on
// "duplicate column name", and the app would not open its database at all.
//
// Everything here goes through the Backups dialog, and "relaunch" is a new page
// load: the shim runs the migrator on the first open of each page, as the
// plugin does on the first open of each process (src/test/browser-sql-shim.ts).

const LIVE = "histometer-shim-fs:histometer-shim.db";
const BACKUPS = "histometer-shim-fs:backups/";
const OLD_BACKUP = "histometer-backup-20250301-091500-scheduled.db";

async function plantBackup(page: Page, name: string, b64: string): Promise<void> {
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [BACKUPS + name, b64]);
}

async function readBackup(page: Page, name: string): Promise<string> {
  return page.evaluate((key) => window.localStorage.getItem(key) as string, BACKUPS + name);
}

async function select<T>(page: Page, sql: string): Promise<T[]> {
  return page.evaluate(
    (q) => (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }).__SHIM_SELECT__(q),
    sql,
  ) as Promise<T[]>;
}

async function ledger(page: Page): Promise<number[]> {
  const rows = await select<{ version: number }>(page, "SELECT version FROM _sqlx_migrations ORDER BY version");
  return rows.map((r) => Number(r.version));
}

/** Every row of every workflow table: the lab's data, without the live session a revert keeps (#1). */
async function workflowData(page: Page): Promise<Record<string, unknown[]>> {
  const tables = await select<{ name: string }>(
    page,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       AND name NOT IN ('users', 'app_settings') ORDER BY name`,
  );
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) out[name] = await select(page, `SELECT * FROM "${name}" ORDER BY rowid`);
  return out;
}

/** Close the app and open it again: a new page load, so the migrator runs. */
async function relaunch(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({ timeout: 20_000 });
}

function backupRow(page: Page, name: string) {
  return page.getByRole("dialog", { name: "Database backups" }).getByRole("listitem").filter({ hasText: name });
}

async function revertTo(page: Page, name: string): Promise<void> {
  await openBackups(page);
  await backupRow(page, name).getByRole("button", { name: "Revert" }).click();
}

/** A new install on this build, with one lab user, one project and one block. */
async function freshLab(page: Page): Promise<void> {
  await page.goto("/?freshdb=1"); // clears the shim's whole virtual disk, backups included
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Signed-in user").locator("option", { hasText: "Alex Rivera" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill("NB");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("New Build");
  await page.getByRole("button", { name: "Save Project" }).click();
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("made on this build");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("NB-1")).toBeVisible();
}

let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });
  // Accept the revert confirmation.
  page.on("dialog", (d) => void d.accept());
});

test("a backup from before the newest migration: revert, relaunch, relaunch again", async ({ page }) => {
  await freshLab(page);
  expect(await ledger(page)).toEqual(MIGRATIONS.map((m) => m.version));

  await plantBackup(page, OLD_BACKUP, preMigrationImage());
  await revertTo(page, OLD_BACKUP);
  // The backup's own lab is what the board shows now.
  await expect(page.locator("aside").getByText("Enthesis Engineering")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("aside").getByText("New Build")).toHaveCount(0);

  // The revert left a record that says what the file now holds.
  expect(await ledger(page)).toEqual(MIGRATIONS.map((m) => m.version));

  // Close the app and open it again, twice: each launch runs the migrator.
  for (const launch of ["the next launch", "the launch after that"]) {
    await relaunch(page);
    await expect(page.locator("aside").getByText("Enthesis Engineering"), launch).toBeVisible();
    await page.locator("nav").getByRole("button", { name: "Logs" }).click();
    for (const code of ["EE-1", "EE-2", "EE-3"]) {
      await expect(page.getByRole("cell", { name: code, exact: true }), launch).toBeVisible();
    }
    expect(await ledger(page), launch).toEqual(MIGRATIONS.map((m) => m.version));
  }
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);

  // Migration 24 really ran on it, backfill and all: every stain slide the
  // backup held now says what it was asked for.
  const unrecorded = await select(
    page,
    `SELECT id FROM slides WHERE purpose = 'stain' AND requested_assay_name <> COALESCE(assay_name, '')`,
  );
  expect(unrecorded).toEqual([]);
});

test("a backup this build took reverts exactly as before", async ({ page }) => {
  await freshLab(page);
  await openBackups(page);
  await page.getByRole("button", { name: "Back up now" }).click();
  const dialog = page.getByRole("dialog", { name: "Database backups" });
  await expect(dialog.getByText("Manual").first()).toBeVisible({ timeout: 10_000 });
  const name = (await dialog.getByRole("listitem").first().innerText()).match(/histometer-backup-[\w-]+\.db/)![0];
  const atBackup = await workflowData(page);
  const image = await readBackup(page, name);
  await page.keyboard.press("Escape");

  await page.evaluate((q) => (window as unknown as { __SHIM_SQL__: (s: string) => void }).__SHIM_SQL__(q),
    `UPDATE samples SET sample_description = 'changed after the backup'`);

  await revertTo(page, name);
  await expect(page.getByRole("dialog", { name: "Database backups" }).locator("p.text-red-700")).toHaveCount(0);
  await expect.poll(() => workflowData(page)).toEqual(atBackup);
  // Nothing needed bringing up to date, so nothing was: the backup file itself is untouched too.
  expect(await readBackup(page, name)).toBe(image);

  for (let i = 0; i < 2; i += 1) {
    await relaunch(page);
    expect(await workflowData(page)).toEqual(atBackup);
  }
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

for (const [what, damage, refusal] of [
  [
    "a file that is not a database at all",
    () => Buffer.from("these are not the bytes of a database ".repeat(40)).toString("base64"),
    /This backup cannot be restored: it is not a database file\. The current database has not been changed\./,
  ],
  [
    "a backup made by a newer version",
    fromANewerVersion,
    new RegExp(
      `This backup cannot be restored: it was made by a newer version of Histometer \\(it has database migration ${NEWEST + 1}, ` +
        `which this version does not have\\)\\. Only that version or a later one can restore it\\. ` +
        `The current database has not been changed\\.`,
    ),
  ],
] as const) {
  test(`${what} is refused out loud, and the lab's database is left as it was`, async ({ page }) => {
    await freshLab(page);
    await openBackups(page);
    await page.getByRole("button", { name: "Back up now" }).click();
    const dialog = page.getByRole("dialog", { name: "Database backups" });
    await expect(dialog.getByText("Manual").first()).toBeVisible({ timeout: 10_000 });
    const good = (await dialog.getByRole("listitem").first().innerText()).match(/histometer-backup-[\w-]+\.db/)![0];
    const bad = "histometer-backup-20250301-091500-scheduled.db";
    await plantBackup(page, bad, damage(await readBackup(page, good)));
    await page.keyboard.press("Escape");
    const before = await workflowData(page);
    const liveBefore = await page.evaluate((key) => window.localStorage.getItem(key), LIVE);

    await revertTo(page, bad);
    await expect(page.getByRole("dialog", { name: "Database backups" }).getByText(refusal)).toBeVisible({
      timeout: 15_000,
    });
    expect(await page.evaluate((key) => window.localStorage.getItem(key), LIVE)).toBe(liveBefore);
    // No safety backup either: nothing was about to change.
    await expect(page.getByRole("dialog", { name: "Database backups" }).getByText("Before revert")).toHaveCount(0);

    await relaunch(page);
    await expect(page.locator("aside").getByText("New Build")).toBeVisible();
    expect(await workflowData(page)).toEqual(before);
  });
}
