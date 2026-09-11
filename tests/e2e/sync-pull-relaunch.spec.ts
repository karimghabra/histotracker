import { test, expect, type Browser, type Page } from "@playwright/test";
import { MIGRATIONS, NEWEST, fromANewerVersion, preMigrationImage } from "../helpers/images";

// A viewer pulls the workstation's snapshot, then is closed and opened again.
//
// The app runs its numbered migrations when it launches, and records each one
// inside the database file (`_sqlx_migrations`). A pull swaps the workstation's
// whole image in mid-session, record and all, and the workstation may be on
// another version of Histometer. A snapshot from an older one used to go live
// with a record that lacked the newer migrations: getDb() added their columns,
// and the viewer's next launch ran the migrations again on top of them,
// stopped on "duplicate column name", and would not open its database. One
// from a newer version went live too, and the next launch refused it outright.
//
// The workstation here is the fake GitHub remote the shim routes github_* to
// (vite.config.playwright.ts); the test publishes to it directly. "Relaunch" is
// a new page load: the shim runs the migrator on the first open of each page,
// as the plugin does on the first open of each process.

const LIVE = "histometer-shim-fs:histometer-shim.db";
const LAST_SYNCED = "histometer-shim-last-version";

/** Publish `b64` as the workstation's latest snapshot, stamped `version`. */
async function publish(page: Page, ns: string, b64: string, version: string): Promise<void> {
  const post = (command: string, data: Record<string, unknown>) =>
    page.request.post(`/__fakegh/${command}?ns=${encodeURIComponent(ns)}`, { data });
  await post("upload_release_asset", {
    tag: "snapshot-latest",
    assetName: "histometer.db",
    bytes: Array.from(Buffer.from(b64, "base64")),
  });
  await post("put_file", {
    path: "manifest.json",
    content: JSON.stringify({
      version,
      updated_at: version,
      db_asset: "histometer.db",
      workbook_asset: "histometer-status.xlsx",
    }),
  });
}

async function viewer(browser: Browser, ns: string): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript((namespace: string) => {
    const w = window as unknown as Record<string, unknown>;
    w.__FAKEGH_NS__ = namespace;
    w.__SYNC_OVERRIDE__ = {
      role: "viewer",
      repo_owner: "lab",
      repo_name: "archive",
      operator_name: "Laptop",
      operator_initials: "LT",
      install_id: "vw-1",
      configured: true,
      has_token: true,
    };
  }, ns);
  return context.newPage();
}

async function ledger(page: Page): Promise<number[]> {
  const rows = (await page.evaluate(
    (q) => (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }).__SHIM_SELECT__(q),
    "SELECT version FROM _sqlx_migrations ORDER BY version",
  )) as Array<{ version: number }>;
  return rows.map((r) => Number(r.version));
}

async function stored(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}

/** Close the app and open it again: a new page load, so the migrator runs. */
async function relaunch(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({ timeout: 20_000 });
}

async function showsTheLab(page: Page, launch: string): Promise<void> {
  await expect(page.locator("aside").getByText("Enthesis Engineering"), launch).toBeVisible({ timeout: 15_000 });
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  for (const code of ["EE-1", "EE-2", "EE-3"]) {
    await expect(page.getByRole("cell", { name: code, exact: true }), launch).toBeVisible();
  }
}

test("a snapshot from a workstation on a version before the newest migration: pull, relaunch, relaunch again", async ({
  browser,
}) => {
  const ns = `pull-old-${Date.now()}`;
  const page = await viewer(browser, ns);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await publish(page, ns, preMigrationImage(), "2026-01-01T00:00:00.000Z");

  // A fresh viewer pulls the snapshot as soon as it opens.
  await page.goto("/?freshdb=1");
  await showsTheLab(page, "after the pull");
  // The pull left a record that says what the file now holds.
  expect(await ledger(page)).toEqual(MIGRATIONS.map((m) => m.version));

  for (const launch of ["the next launch", "the launch after that"]) {
    await relaunch(page);
    await showsTheLab(page, launch);
    expect(await ledger(page), launch).toEqual(MIGRATIONS.map((m) => m.version));
  }
  await expect(page.getByText(/Sync error/)).toHaveCount(0);
  expect(errors, errors.join("\n")).toEqual([]);
  await page.context().close();
});

test("a snapshot from a newer version is refused out loud, and the viewer's copy is left as it was", async ({
  browser,
}) => {
  const ns = `pull-newer-${Date.now()}`;
  const page = await viewer(browser, ns);
  await publish(page, ns, preMigrationImage(), "2026-01-01T00:00:00.000Z");
  await page.goto("/?freshdb=1");
  await showsTheLab(page, "after the first pull");
  const live = (await stored(page, LIVE))!;
  const lastSynced = await stored(page, LAST_SYNCED);
  expect(lastSynced).toBe("2026-01-01T00:00:00.000Z");

  // The workstation updates to a version with one more migration, and publishes.
  await publish(page, ns, fromANewerVersion(live), "2026-01-02T00:00:00.000Z");
  const refusal =
    `The workstation's latest snapshot cannot be opened here: it was made by a newer version of ` +
    `Histometer (it has database migration ${NEWEST + 1}, which this version does not have). ` +
    `Update Histometer on this computer to open it. This computer's copy has not been changed.`;
  await page.getByTitle("Sync now").click();
  const notice = page.getByText(`Sync error: ${refusal}`, { exact: true });
  await expect(notice).toBeVisible({ timeout: 15_000 });
  // A notice that long is cut short in the header, whole on hover, and leaves
  // the controls where they were: it once pushed them off the right edge.
  await expect(notice).toHaveAttribute("title", `Sync error: ${refusal}`);
  await expect(page.getByRole("button", { name: "Request stain" })).toBeInViewport({ ratio: 1 });
  // …and it stays on the sync pill once that notice has gone.
  await expect(page.getByText("Sync error", { exact: true })).toHaveAttribute("title", refusal);
  expect(await stored(page, LIVE)).toBe(live);
  // Not marked as pulled, so the viewer takes it once it can open it.
  expect(await stored(page, LAST_SYNCED)).toBe(lastSynced);

  await relaunch(page);
  await showsTheLab(page, "the next launch");
  expect(await ledger(page)).toEqual(MIGRATIONS.map((m) => m.version));
  await page.context().close();
});
