import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { settleAfterDrop } from "../helpers/drag";

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
  // dnd-kit swallows every click for 50ms after a drop — wait it out.
  await settleAfterDrop(page);
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
  await expect(ws.getByText("EE-1")).toBeVisible();
}

test("#72: the viewer's sample panel offers no bench actions", async ({ browser }) => {
  const { ws, vw, wsCtx, vwCtx } = await openPair(browser, `ro-${Date.now()}`);
  await ws.goto("/?freshdb=1");
  await seedWorkstation(ws);
  await vw.goto("/?freshdb=1");
  await expect(vw.locator("text=/^viewer$/i").first()).toBeVisible();
  await streamTo(ws, vw, vw.getByText("EE-1", { exact: true }).first());

  // The viewer CAN open the panel and read it — that is the point of viewer mode.
  await vw.getByText("EE-1", { exact: true }).first().click();
  await expect(vw.getByText("Description").first()).toBeVisible();

  // …but every write control is absent, so nothing can hang on a rejected write.
  await expect(vw.getByRole("button", { name: /Send for Cutting/ })).toHaveCount(0);
  await expect(vw.getByRole("button", { name: "Request", exact: true })).toHaveCount(0);
  await expect(vw.getByLabel("Edit description")).toHaveCount(0);
  await expect(vw.getByRole("button", { name: /Mark Exhausted/ })).toHaveCount(0);
  await expect(vw.getByText(/Read-only viewer/).first()).toBeVisible();

  // The same panel on the workstation DOES offer them — proving the assertions
  // above are about viewer mode, not about a selector that never matches.
  await ws.getByText("EE-1", { exact: true }).first().click();
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
  await ws.getByText("EE-1", { exact: true }).first().click();
  await ws.getByRole("button", { name: "Placed in fixative" }).click();
  await ws.getByRole("button", { name: "Removed from fixative" }).click();
  await ws.getByRole("button", { name: "Placed in ethanol" }).click();
  await ws.locator("button:has(svg.lucide-x)").first().click();

  await vw.goto("/?freshdb=1");
  await expect(vw.locator("text=/^viewer$/i").first()).toBeVisible();
  await streamTo(ws, vw, vw.getByText("EE-1", { exact: true }).first());

  // Viewer raises a request…
  await vw.getByRole("button", { name: /Request stain/ }).click();
  // Option value is the stored code; the label is the display form (#87).
  await vw.getByLabel("Sample").selectOption({ label: "EE-1" });
  await vw.getByLabel("Requested stain / IHC").selectOption({ index: 1 });
  await vw.getByRole("button", { name: /Send request/ }).click();

  // The board behind the modal also shows the code, so scope to the dialog.
  const inbox = vw.locator("div.fixed.inset-0.z-50");

  // …and can see it straight away, with NO sync in between.
  await vw.getByRole("button", { name: /My requests/ }).click();
  await expect(inbox.getByText("EE-1").first()).toBeVisible();
  await expect(inbox.getByText("EE-1")).toHaveCount(1);
  await vw.keyboard.press("Escape");

  // After the full round-trip the request is still listed exactly once.
  await expect(async () => {
    await syncNow(ws); // drain + publish
    await syncNow(vw); // pull
    await vw.getByRole("button", { name: /My requests/ }).click();
    await expect(inbox.getByText("EE-1")).toHaveCount(1, { timeout: 3000 });
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

  // Drive EE-1 into Staining on the workstation.
  await ws.getByText("EE-1", { exact: true }).first().click();
  await ws.getByRole("button", { name: "Placed in fixative" }).click();
  await ws.getByRole("button", { name: "Removed from fixative" }).click();
  await ws.getByRole("button", { name: "Placed in ethanol" }).click();
  await ws.locator("button:has(svg.lucide-x)").first().click();
  await dragOnto(ws, "EE-1", "Processor");
  await expect(ws.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await expect(async () => {
    const btn = ws.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(ws.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 25000 });
  await dragOnto(ws, "Batch 1", "Needs Embedding");
  await dragOnto(ws, "EE-1", "Embedded Inventory");
  await ws.getByText("EE-1", { exact: true }).first().click();
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

// NOTE: this used to be named "cannot start a depth tag" while asserting only
// the Archive and Request-stain buttons — and its seed created ZERO slides, so
// the depth-tag bar it claimed to prove absent could never have rendered on a
// workstation either. Renamed to what it actually checks; the depth-tag case is
// the separate test below, which seeds real slides.
test("#72: the viewer's Logs row offers no write actions", async ({ browser }) => {
  const { ws, vw, wsCtx, vwCtx } = await openPair(browser, `ro2-${Date.now()}`);
  await ws.goto("/?freshdb=1");
  await seedWorkstation(ws);

  // Give the block slides so the Logs drill-down has something selectable.
  await ws.getByText("EE-1", { exact: true }).first().click();
  await ws.getByRole("button", { name: "Placed in fixative" }).click();
  await ws.getByRole("button", { name: "Removed from fixative" }).click();
  await ws.getByRole("button", { name: "Placed in ethanol" }).click();
  await ws.locator("button:has(svg.lucide-x)").first().click();

  await vw.goto("/?freshdb=1");
  await expect(vw.locator("text=/^viewer$/i").first()).toBeVisible();
  await streamTo(ws, vw, vw.getByText("EE-1", { exact: true }).first());

  await vw.locator("nav").getByRole("button", { name: "Logs" }).click();
  await expect(vw.getByRole("cell", { name: "EE-1", exact: true })).toBeVisible();

  // Archiving is a write too — not offered on a viewer.
  await vw.getByRole("cell", { name: "EE-1", exact: true }).click();
  await expect(vw.getByRole("button", { name: /Archive EE-1/ })).toHaveCount(0);
  await expect(vw.getByRole("button", { name: /Request stain for/ })).toHaveCount(0);
  // Notes are readable but not editable — they used to accept typing and throw
  // it away on blur (#72). Target the notes textarea by placeholder; the Logs
  // search box is also a textbox and is legitimately editable.
  const notes = vw.getByPlaceholder("Notes about this sample…");
  await expect(notes).toHaveAttribute("readonly", "");

  await wsCtx.close();
  await vwCtx.close();
});

// #72 — the depth-tag case, with SLIDES actually present so the action bar is
// reachable. This is what the renamed test above only claimed to cover: with a
// zero-slide seed there is nothing to select, so its absence proved nothing.
test("#72: a viewer with real slides still cannot tag a depth", async ({ browser }) => {
  const { ws, vw, wsCtx, vwCtx } = await openPair(browser, `ro4-${Date.now()}`);
  await ws.goto("/?freshdb=1");
  await seedWorkstation(ws);

  // Drive EE-1 to a cut so it HAS slides to select in the Logs drill-down.
  await ws.getByText("EE-1", { exact: true }).first().click();
  await ws.getByRole("button", { name: "Placed in fixative" }).click();
  await ws.getByRole("button", { name: "Removed from fixative" }).click();
  await ws.getByRole("button", { name: "Placed in ethanol" }).click();
  await ws.locator("button:has(svg.lucide-x)").first().click();
  await dragOnto(ws, "EE-1", "Processor");
  await expect(ws.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await expect(async () => {
    const btn = ws.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(ws.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 25000 });
  await dragOnto(ws, "Batch 1", "Needs Embedding");
  await dragOnto(ws, "EE-1", "Embedded Inventory");
  await ws.getByText("EE-1", { exact: true }).first().click();
  await ws.getByRole("button", { name: /Send for Cutting/ }).click();
  await ws.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await ws.locator("button:has(svg.lucide-x)").first().click();

  await vw.goto("/?freshdb=1");
  await expect(vw.locator("text=/^viewer$/i").first()).toBeVisible();
  await streamTo(ws, vw, vw.getByText("EE-1", { exact: true }).first());

  await vw.locator("nav").getByRole("button", { name: "Logs" }).click();
  await vw.getByRole("cell", { name: "EE-1", exact: true }).click();

  // Precondition that the OLD test lacked: the slides really are there, so a
  // workstation WOULD show the tagging bar once they are selected.
  const slideCheckboxes = vw.getByRole("checkbox", { name: /Select slide/ });
  await expect(slideCheckboxes.first()).toBeVisible({ timeout: 15000 });
  await slideCheckboxes.first().check();

  // Selection is allowed (viewers may inspect), but tagging is not offered.
  await expect(vw.getByRole("button", { name: /Create Tag/ })).toHaveCount(0);
  await expect(vw.getByText(/Read-only viewer/).first()).toBeVisible();

  // And the workstation, with the identical selection, DOES offer it — which is
  // what makes the absence above meaningful rather than incidental.
  await ws.locator("nav").getByRole("button", { name: "Logs" }).click();
  await ws.getByRole("cell", { name: "EE-1", exact: true }).click();
  await ws.getByRole("checkbox", { name: /Select slide/ }).first().check();
  await expect(ws.getByRole("button", { name: /Create Tag/ })).toBeVisible();

  await wsCtx.close();
  await vwCtx.close();
});

// #72 — a READ must never depend on a WRITE.
//
// listSlidesForSections calls ensureSlidesForSectionRequest, which INSERTs the
// slides of a cut group that has none. On a viewer guardWrites rejects that
// INSERT, and the rejection propagates out of the *read*, so useSectionsSlides
// fails and the drawer falls back to `slides = []`. Because the loop runs over
// every grouped cut group, ONE uninitialised sibling blanked the slide rows of
// every populated group on the card — destroying the exact read #72 promises
// viewers ("see cutting plans and existing tags"). Invisible from the bench,
// because the workstation is allowed to write and so repairs the row on open.
test("#72: an uninitialised sibling cut group does not blank the viewer's slide list", async ({
  browser,
}) => {
  const { ws, vw, wsCtx, vwCtx } = await openPair(browser, `ro5-${Date.now()}`);
  await ws.goto("/?freshdb=1");
  await seedWorkstation(ws);

  // Plant the pre-0.4.6 shape the UI cannot produce any more: one cut group
  // holding real slides, and a sibling with duplicates > 0 and no slides at all.
  // (ensureSlidesForSectionRequest exists precisely to serve those legacy rows.)
  await ws.evaluate(() => {
    const sql = (window as unknown as Record<string, unknown>).__SHIM_SQL__ as (
      q: string,
      p?: unknown[],
    ) => void;
    sql(
      `INSERT INTO section_requests (id, sample_id, duplicates, stains, current_stage, stage_needs_sectioning_at)
       VALUES (901, 1, 2, 'H&E', 'needs_sectioning', '2026-01-01 09:00:00')`,
    );
    for (const [ordinal, code] of [[1, "EE-1-A"], [2, "EE-1-B"]] as Array<[number, string]>) {
      sql(
        `INSERT INTO slides (section_request_id, slide_ordinal, slide_code, purpose, stain_name,
                             assay_type, assay_name, assignment_saved, current_stage)
         VALUES (901, ?, ?, 'stain', 'H&E', 'stain', 'H&E', 1, 'assigned')`,
        [ordinal, code],
      );
    }
    // The sibling: legacy, never initialised, still claims a plan.
    sql(
      `INSERT INTO section_requests (id, sample_id, duplicates, stains, current_stage, stage_needs_sectioning_at)
       VALUES (902, 1, 1, '', 'needs_sectioning', '2026-01-01 09:00:00')`,
    );
  });
  // NOT reload(): the page URL still carries ?freshdb=1, which makes the shim
  // drop the database on load and would wipe both the seed and the planted rows.
  await ws.goto("/");

  await vw.goto("/?freshdb=1");
  await expect(vw.locator("text=/^viewer$/i").first()).toBeVisible();
  await streamTo(ws, vw, vw.getByText("EE-1", { exact: true }).first());

  // The viewer opens the grouped Needs Sectioning card. Scope to the column —
  // the block itself is also on the board and carries the same "EE-1" text.
  await column(vw, "Needs Sectioning").getByText("EE-1", { exact: true }).first().click();
  await expect(vw.getByRole("heading", { name: "Assay slides" })).toBeVisible({ timeout: 15000 });
  await expect(vw.getByText("EE-1-A", { exact: true })).toBeVisible();
  await expect(vw.getByText("EE-1-B", { exact: true })).toBeVisible();

  // No read-only banner either: the read must not have attempted a write.
  await expect(vw.getByText(/read-only viewer — changes are made/i)).toHaveCount(0);

  // The workstation shows the same rows, so the assertion above is meaningful
  // rather than incidental.
  await column(ws, "Needs Sectioning").getByText("EE-1", { exact: true }).first().click();
  await expect(ws.getByText("EE-1-A", { exact: true })).toBeVisible({ timeout: 15000 });

  await wsCtx.close();
  await vwCtx.close();
});
