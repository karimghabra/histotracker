import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

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

// Click a button by name, retrying until `target` appears. A background sync /
// query refetch can momentarily clear the active operator and no-op a dialog's
// submit; the retry (and the visibility guard, in case a prior click already
// closed the dialog) makes the step deterministic.
async function clickUntil(page: Page, buttonName: string, target: Locator) {
  await expect(async () => {
    const btn = page.getByRole("button", { name: buttonName, exact: true });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(target).toBeVisible({ timeout: 2500 });
  }).toPass({ timeout: 25000 });
}

// Publish on the workstation and pull on the viewer until `target` appears.
// Both cycles are retried: a manual Sync-now can coincide with an instance's own
// auto-sync and be guarded out, so a single publish/pull pair isn't guaranteed
// to move the latest state. The Sync-now button disables while syncing, so each
// click waits for the prior cycle to finish before starting a fresh one.
async function streamTo(ws: Page, vw: Page, target: Locator) {
  await expect(async () => {
    await syncNow(ws); // publish and wait for the cycle to finish...
    await syncNow(vw); // ...then pull, so the viewer sees the just-published state
    await expect(target).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 60000 });
}

// A board column on the (read-only) viewer, scoped by its heading.
function column(page: Page, title: string) {
  return page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

// dnd-kit drag on the workstation board (mirrors workflow.spec's dragOnto).
async function dragOnto(page: Page, sourceText: string, columnTitle: string) {
  const card = page.getByText(sourceText, { exact: true }).first();
  const header = page.getByRole("heading", { name: columnTitle, exact: true });
  const from = await card.boundingBox();
  const to = await header.boundingBox();
  if (!from || !to) throw new Error("drag endpoints missing");
  const dropX = to.x + to.width / 2;
  const dropY = to.y + 140;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 4 });
  await page.mouse.move(dropX, dropY, { steps: 10 });
  await page.mouse.move(dropX, dropY + 2, { steps: 3 });
  await page.mouse.up();
}

// Open a fresh workstation + viewer pair against a shared fake remote.
async function openPair(browser: Browser, ns: string): Promise<{
  ws: Page;
  vw: Page;
  wsCtx: BrowserContext;
  vwCtx: BrowserContext;
}> {
  const wsCtx = await browser.newContext();
  const vwCtx = await browser.newContext();
  await configure(wsCtx, ns, { ...base, role: "workstation", install_id: "ws-1", operator_name: "Bench" });
  await configure(vwCtx, ns, { ...base, role: "viewer", install_id: "vw-1", operator_name: "Laptop" });
  const ws = await wsCtx.newPage();
  const vw = await vwCtx.newPage();
  return { ws, vw, wsCtx, vwCtx };
}

test("viewer streams in the workstation database", async ({ browser }) => {
  const { ws, vw, wsCtx, vwCtx } = await openPair(browser, `sync-${Date.now()}`);

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

// Walks a single block through the whole pipeline on the workstation, syncing
// after each transition, and asserts the viewer reflects each stage. Because the
// synced payload is the whole SQLite image, this exercises every workflow table
// (samples, processing batches, section requests, slides, stacks, checklists).
test("every workflow step syncs workstation → viewer", async ({ browser }) => {
  const ns = `flow-${Date.now()}`;
  const { ws, vw, wsCtx, vwCtx } = await openPair(browser, ns);
  await ws.goto("/?freshdb=1");
  await seedWorkstation(ws); // EE-0001 in pre-processing
  await vw.goto("/?freshdb=1");
  await expect(vw.locator("text=/^viewer$/i").first()).toBeVisible();

  // 1. Pre-processing → in_ethanol.
  await ws.getByText("EE-0001", { exact: true }).click();
  await ws.getByRole("button", { name: "Placed in fixative" }).click();
  await ws.getByRole("button", { name: "Removed from fixative" }).click();
  await ws.getByRole("button", { name: "Placed in ethanol" }).click();
  await ws.locator("button:has(svg.lucide-x)").first().click();
  await streamTo(ws, vw, column(vw, "Pre-processing").getByText("EE-0001"));

  // 2. Processor (start a batch). A background sync/refetch can momentarily blank
  // the active operator and no-op the first click, so retry until it sticks.
  await dragOnto(ws, "EE-0001", "Processor");
  await expect(ws.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await clickUntil(ws, "Start Batch", ws.getByText("Batch 1", { exact: true }));
  await streamTo(ws, vw, column(vw, "Processor").getByText("Batch 1"));

  // 3. Needs Embedding.
  await dragOnto(ws, "Batch 1", "Needs Embedding");
  await streamTo(ws, vw, column(vw, "Needs Embedding").getByText("EE-0001"));

  // 4. Embedded Inventory.
  await dragOnto(ws, "EE-0001", "Embedded Inventory");
  await streamTo(ws, vw, column(vw, "Embedded Inventory").getByText("EE-0001"));

  // 5. Needs Sectioning (send for cutting with one stain).
  await ws.getByText("EE-0001", { exact: true }).first().click();
  await ws.getByRole("button", { name: /Send for Cutting/ }).click();
  await ws
    .locator("select")
    .filter({ has: ws.locator("option", { hasText: "Extra (no stain)" }) })
    .first()
    .selectOption({ index: 1 });
  await ws.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await ws.locator("button:has(svg.lucide-x)").first().click();
  await expect(column(ws, "Needs Sectioning").getByText("Alcian Blue")).toBeVisible({ timeout: 15000 });
  await streamTo(ws, vw, column(vw, "Needs Sectioning").getByText("Alcian Blue"));

  // 6. Staining (mark sectioned mints the stain rack). Wait for the workstation
  // to finish (rack visible) BEFORE publishing, so we don't snapshot a half-done
  // operation.
  await ws.getByText("4 slides").first().click();
  await ws.getByRole("button", { name: /Mark Sectioned/ }).click();
  await ws.locator("button:has(svg.lucide-x)").first().click();
  await expect(column(ws, "Staining / IHC").getByText("Alcian Blue").first()).toBeVisible({ timeout: 15000 });
  await streamTo(ws, vw, column(vw, "Staining / IHC").getByText("Alcian Blue").first());

  // 7. Ready for Imaging (run the stain protocol → scatter into a per-sample
  // stack). Each checklist toggle refetches, so wait for the running count to
  // tick before the next click instead of firing all three at once.
  await column(ws, "Staining / IHC").getByText("Alcian Blue").first().click();
  await ws.getByLabel("Active operator").fill("Alex");
  const steps = ["Stained", "Coverslipped", "Dried"];
  for (let i = 0; i < steps.length; i += 1) {
    await ws.getByRole("button", { name: steps[i], exact: true }).click();
    if (i < steps.length - 1) {
      await expect(ws.getByText(new RegExp(`${i + 1}/3 complete`))).toBeVisible({ timeout: 10000 });
    }
  }
  await expect(column(ws, "Ready for Imaging").getByText("EE-0001").first()).toBeVisible({ timeout: 15000 });
  await streamTo(ws, vw, column(vw, "Ready for Imaging").getByText("EE-0001").first());

  // 8. Analyzed (complete imaging + mark analyzed) → shows in the viewer's Logs.
  await column(ws, "Ready for Imaging").getByText("EE-0001", { exact: true }).first().click();
  await ws.getByRole("button", { name: /Complete Imaging/ }).click();
  await ws.getByRole("button", { name: /Mark Analyzed/ }).click();
  // Analyzed is terminal — the stack leaves the board; wait for that on the
  // workstation before publishing, then pull (retry) on the viewer.
  await expect(column(ws, "Ready for Imaging").getByText("EE-0001")).toHaveCount(0, { timeout: 15000 });
  await syncNow(ws);
  await expect(async () => {
    await vw.getByTitle("Sync now").click();
    await vw.waitForTimeout(500);
    await vw.locator("nav").getByRole("button", { name: "Logs" }).click();
    await expect(vw.getByRole("cell", { name: "EE-0001", exact: true })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30000 });
  await vw.locator("summary").filter({ hasText: /stage/ }).click();
  await vw.getByRole("checkbox", { name: "Analyzed" }).check();
  await expect(vw.getByRole("cell", { name: "EE-0001", exact: true })).toBeVisible({ timeout: 15000 });
  await vw.screenshot({ path: "test-results/sync-workflow-analyzed.png", fullPage: true });

  await wsCtx.close();
  await vwCtx.close();
});
