import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

// #72 — a viewer should SEE cutting plans and existing tags, and nothing more.
// The data layer already rejects viewer writes (guardWrites in db.ts), so the
// symptom was a UI that offered the control, fired the mutation and then sat on
// a promise that never resolved — the reported "perpetual loading screens".
// These tests assert the controls are simply not there.

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

async function openPair(browser: Browser, ns: string) {
  const wsCtx = await browser.newContext();
  const vwCtx = await browser.newContext();
  await configure(wsCtx, ns, { ...base, role: "workstation", install_id: "ws-1", operator_name: "Bench" });
  await configure(vwCtx, ns, { ...base, role: "viewer", install_id: "vw-1", operator_name: "Laptop" });
  return { ws: await wsCtx.newPage(), vw: await vwCtx.newPage(), wsCtx, vwCtx };
}

async function syncNow(page: Page) {
  await page.getByTitle("Sync now").click();
  await expect(page.getByText("Syncing…")).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByText("Sync error")).toHaveCount(0);
}

async function streamTo(ws: Page, vw: Page, target: Locator) {
  await expect(async () => {
    await syncNow(ws);
    await syncNow(vw);
    await expect(target).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 60000 });
}

// A board column, scoped by its heading.
function column(page: Page, title: string) {
  return page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

// dnd-kit drag (mirrors workflow.spec's dragOnto).
async function dragOnto(page: Page, sourceText: string, columnTitle: string) {
  const card = page.getByText(sourceText, { exact: true }).first();
  const header = page.getByRole("heading", { name: columnTitle, exact: true });
  const from = await card.boundingBox();
  const to = await header.boundingBox();
  if (!from || !to) throw new Error(`drag endpoints missing for ${sourceText} → ${columnTitle}`);
  const dropX = to.x + to.width / 2;
  const dropY = to.y + 140;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 4 });
  await page.mouse.move(dropX, dropY, { steps: 10 });
  await page.mouse.move(dropX, dropY + 2, { steps: 3 });
  await page.mouse.up();
}

async function seedWorkstation(ws: Page) {
  await expect(ws.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await ws.getByRole("button", { name: "Manage" }).click();
  await ws.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await ws.getByRole("button", { name: "Add", exact: true }).click();
  await ws.keyboard.press("Escape");
  await ws.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await ws.getByTitle("Add project").click();
  await ws.locator('input[placeholder="EE"]').fill("EE");
  await ws.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await ws.getByRole("button", { name: "Save Project" }).click();
  await ws.getByRole("button", { name: "New Sample" }).click();
  await ws.getByPlaceholder("e.g. 2 week Stretch PLA").fill("Viewer block");
  await ws.getByRole("button", { name: /Create Sample/ }).click();
  await expect(ws.getByText("EE-0001")).toBeVisible();
}

test("#72: the viewer's sample panel offers no bench actions", async ({ browser }) => {
  const { ws, vw, wsCtx, vwCtx } = await openPair(browser, `ro-${Date.now()}`);
  await ws.goto("/?freshdb=1");
  await seedWorkstation(ws);
  await vw.goto("/?freshdb=1");
  await expect(vw.locator("text=/^viewer$/i").first()).toBeVisible();
  await streamTo(ws, vw, vw.getByText("EE-0001", { exact: true }).first());

  // The viewer CAN open the panel and read it — that is the point of viewer mode.
  await vw.getByText("EE-0001", { exact: true }).first().click();
  await expect(vw.getByText("Description").first()).toBeVisible();

  // …but every write control is absent, so nothing can hang on a rejected write.
  await expect(vw.getByRole("button", { name: /Send for Cutting/ })).toHaveCount(0);
  await expect(vw.getByRole("button", { name: "Request", exact: true })).toHaveCount(0);
  await expect(vw.getByLabel("Edit description")).toHaveCount(0);
  await expect(vw.getByRole("button", { name: /Mark Exhausted/ })).toHaveCount(0);
  await expect(vw.getByText(/Read-only viewer/).first()).toBeVisible();

  // The same panel on the workstation DOES offer them — proving the assertions
  // above are about viewer mode, not about a selector that never matches.
  await ws.getByText("EE-0001", { exact: true }).first().click();
  await expect(ws.getByRole("button", { name: /Send for Cutting/ })).toBeVisible();
  await expect(ws.getByLabel("Edit description")).toBeVisible();

  await wsCtx.close();
  await vwCtx.close();
});

// #71 — a viewer's own request used to be invisible to it until the workstation
// drained it AND published AND the viewer pulled (up to two sync intervals), and
// vanished silently if any of that failed. It should show up immediately, and
// must not double up once the real row arrives in a snapshot.
test("#71: a viewer's request appears immediately and does not duplicate after sync", async ({
  browser,
}) => {
  const { ws, vw, wsCtx, vwCtx } = await openPair(browser, `desync-${Date.now()}`);
  await ws.goto("/?freshdb=1");
  await seedWorkstation(ws);

  // Take the block to Embedded Inventory so it is a real request target.
  await ws.getByText("EE-0001", { exact: true }).first().click();
  await ws.getByRole("button", { name: "Placed in fixative" }).click();
  await ws.getByRole("button", { name: "Removed from fixative" }).click();
  await ws.getByRole("button", { name: "Placed in ethanol" }).click();
  await ws.locator("button:has(svg.lucide-x)").first().click();

  await vw.goto("/?freshdb=1");
  await expect(vw.locator("text=/^viewer$/i").first()).toBeVisible();
  await streamTo(ws, vw, vw.getByText("EE-0001", { exact: true }).first());

  // Viewer raises a request…
  await vw.getByRole("button", { name: /Request stain/ }).click();
  await vw.getByLabel("Sample").selectOption("EE-0001");
  await vw.getByLabel("Requested stain / IHC").selectOption({ index: 1 });
  await vw.getByRole("button", { name: /Send request/ }).click();

  // The board behind the modal also shows the code, so scope to the dialog.
  const inbox = vw.locator("div.fixed.inset-0.z-50");

  // …and can see it straight away, with NO sync in between.
  await vw.getByRole("button", { name: /My requests/ }).click();
  await expect(inbox.getByText("EE-0001").first()).toBeVisible();
  await expect(inbox.getByText("EE-0001")).toHaveCount(1);
  await vw.keyboard.press("Escape");

  // After the full round-trip the request is still listed exactly once.
  await expect(async () => {
    await syncNow(ws); // drain + publish
    await syncNow(vw); // pull
    await vw.getByRole("button", { name: /My requests/ }).click();
    await expect(inbox.getByText("EE-0001")).toHaveCount(1, { timeout: 3000 });
    await vw.keyboard.press("Escape");
  }).toPass({ timeout: 60000 });

  await wsCtx.close();
  await vwCtx.close();
});

// #72 — the RHS panel the report calls out includes the STAINING rack, whose
// protocol checkboxes write on every tick. Ticking one on a viewer is the
// clearest way to hit the hanging spinner, so it must not be offered.
test("#72: the viewer cannot run the stain protocol from the rack panel", async ({ browser }) => {
  const { ws, vw, wsCtx, vwCtx } = await openPair(browser, `ro3-${Date.now()}`);
  await ws.goto("/?freshdb=1");
  await seedWorkstation(ws);

  // Drive EE-0001 into Staining on the workstation.
  await ws.getByText("EE-0001", { exact: true }).first().click();
  await ws.getByRole("button", { name: "Placed in fixative" }).click();
  await ws.getByRole("button", { name: "Removed from fixative" }).click();
  await ws.getByRole("button", { name: "Placed in ethanol" }).click();
  await ws.locator("button:has(svg.lucide-x)").first().click();
  await dragOnto(ws, "EE-0001", "Processor");
  await expect(ws.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await expect(async () => {
    const btn = ws.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(ws.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 25000 });
  await dragOnto(ws, "Batch 1", "Needs Embedding");
  await dragOnto(ws, "EE-0001", "Embedded Inventory");
  await ws.getByText("EE-0001", { exact: true }).first().click();
  await ws.getByRole("button", { name: /Send for Cutting/ }).click();
  await ws
    .locator("select")
    .filter({ has: ws.locator("option", { hasText: "Extra (no stain)" }) })
    .first()
    .selectOption({ index: 1 });
  await ws.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await ws.locator("button:has(svg.lucide-x)").first().click();
  await ws.getByText("4 slides").first().click();
  await ws.getByRole("button", { name: /Mark Sectioned/ }).click();
  await ws.locator("button:has(svg.lucide-x)").first().click();
  await expect(column(ws, "Staining / IHC").getByText("Alcian Blue").first()).toBeVisible({
    timeout: 15000,
  });

  await vw.goto("/?freshdb=1");
  await expect(vw.locator("text=/^viewer$/i").first()).toBeVisible();
  await streamTo(ws, vw, column(vw, "Staining / IHC").getByText("Alcian Blue").first());

  // The viewer opens the rack and reads it…
  await column(vw, "Staining / IHC").getByText("Alcian Blue").first().click();
  await expect(vw.getByText("Assay slides").first()).toBeVisible();

  // …but the protocol checkboxes are absent, so nothing can hang.
  await expect(vw.getByRole("button", { name: "Stained", exact: true })).toHaveCount(0);
  await expect(vw.getByRole("button", { name: "Coverslipped", exact: true })).toHaveCount(0);
  await expect(vw.getByLabel("Active operator")).toHaveCount(0);
  await expect(vw.getByText(/Read-only viewer/).first()).toBeVisible();

  // The workstation's own rack panel DOES offer them.
  await column(ws, "Staining / IHC").getByText("Alcian Blue").first().click();
  await expect(ws.getByRole("button", { name: "Stained", exact: true })).toBeVisible();

  await wsCtx.close();
  await vwCtx.close();
});

test("#72: the viewer cannot start a depth tag from the Logs", async ({ browser }) => {
  const { ws, vw, wsCtx, vwCtx } = await openPair(browser, `ro2-${Date.now()}`);
  await ws.goto("/?freshdb=1");
  await seedWorkstation(ws);

  // Give the block slides so the Logs drill-down has something selectable.
  await ws.getByText("EE-0001", { exact: true }).first().click();
  await ws.getByRole("button", { name: "Placed in fixative" }).click();
  await ws.getByRole("button", { name: "Removed from fixative" }).click();
  await ws.getByRole("button", { name: "Placed in ethanol" }).click();
  await ws.locator("button:has(svg.lucide-x)").first().click();

  await vw.goto("/?freshdb=1");
  await expect(vw.locator("text=/^viewer$/i").first()).toBeVisible();
  await streamTo(ws, vw, vw.getByText("EE-0001", { exact: true }).first());

  await vw.locator("nav").getByRole("button", { name: "Logs" }).click();
  await expect(vw.getByRole("cell", { name: "EE-0001", exact: true })).toBeVisible();

  // Archiving is a write too — not offered on a viewer.
  await vw.getByRole("cell", { name: "EE-0001", exact: true }).click();
  await expect(vw.getByRole("button", { name: /Archive EE-0001/ })).toHaveCount(0);
  await expect(vw.getByRole("button", { name: /Request stain for/ })).toHaveCount(0);

  await wsCtx.close();
  await vwCtx.close();
});
