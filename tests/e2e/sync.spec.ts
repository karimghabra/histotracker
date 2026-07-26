import { test, expect, type BrowserContext, type Page } from "@playwright/test";

// Verifies the workstation → viewer sync end to end: two ISOLATED browser
// contexts (each with its own local SQLite image in its own localStorage) share
// one in-memory "fake GitHub" remote (Vite middleware, keyed by ns). The
// workstation publishes its DB; the viewer pulls it and the streamed-in data
// appears in the viewer's read-only UI.

function configure(context: BrowserContext, ns: string, override: Record<string, unknown>) {
  return context.addInitScript(
    (data: { ns: string; override: Record<string, unknown> }) => {
      (window as unknown as Record<string, unknown>).__FAKEGH_NS__ = data.ns;
      (window as unknown as Record<string, unknown>).__SYNC_OVERRIDE__ = data.override;
    },
    { ns, override },
  );
}

const base = {
  repo_owner: "lab",
  repo_name: "archive",
  operator_initials: "OP",
  configured: true,
  has_token: true,
};

// Sign in a user, create a project + one sample on the (editable) workstation.
async function seedWorkstation(page: Page) {
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("Synced block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-0001")).toBeVisible();
}

// Run a manual sync cycle and wait for it to settle without error.
async function syncNow(page: Page) {
  await page.getByTitle("Sync now").click();
  await expect(page.getByText("Syncing…")).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByText("Sync error")).toHaveCount(0);
}

test("viewer streams in the workstation database", async ({ browser }) => {
  const ns = `sync-${Date.now()}`;
  const wsCtx = await browser.newContext();
  const vwCtx = await browser.newContext();
  await configure(wsCtx, ns, { ...base, role: "workstation", install_id: "ws-1", operator_name: "Bench" });
  await configure(vwCtx, ns, { ...base, role: "viewer", install_id: "vw-1", operator_name: "Laptop" });

  const ws = await wsCtx.newPage();
  const vw = await vwCtx.newPage();

  // Workstation: seed a sample, then publish it to the shared remote.
  await ws.goto("/?freshdb=1");
  await expect(ws.locator("text=/^workstation$/i").first()).toBeVisible(); // role pill
  await seedWorkstation(ws);
  await syncNow(ws);

  // Viewer: starts empty (its own fresh DB), pulls, and now shows the streamed data.
  await vw.goto("/?freshdb=1");
  await expect(vw.locator("text=/^viewer$/i").first()).toBeVisible(); // read-only role
  await syncNow(vw);
  await expect(vw.getByText("EE-0001")).toBeVisible({ timeout: 15000 });
  await vw.screenshot({ path: "test-results/sync-viewer.png", fullPage: true });

  // A second change streams too: add EE-0002 on the workstation, publish, pull.
  await ws.getByRole("button", { name: "New Sample" }).click();
  await ws.getByPlaceholder("e.g. 2 week Stretch PLA").fill("Second synced block");
  await ws.getByRole("button", { name: /Create Sample/ }).click();
  await expect(ws.getByText("EE-0002")).toBeVisible();
  await syncNow(ws);

  await syncNow(vw);
  await expect(vw.getByText("EE-0002")).toBeVisible({ timeout: 15000 });

  await wsCtx.close();
  await vwCtx.close();
});
