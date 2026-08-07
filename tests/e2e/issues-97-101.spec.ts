import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { settleAfterDrop } from "../helpers/drag";

/**
 * The right-hand drawer round (#98, #99, #100, #101) plus the Logs' Short/Long
 * column (#97).
 */

async function signInAndProject(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByLabel("Signed-in user").locator("option", { hasText: "Alex Rivera" }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
}

async function addSample(page: Page, description: string) {
  await page.getByRole("button", { name: "New Sample" }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toBeVisible();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(description);
  await page.getByRole("button", { name: /Create Sample/ }).click();
}

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
  await settleAfterDrop(page);
}

async function embed(page: Page, code: string, batchLabel: string) {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await dragOnto(page, code, "Processor");
  await expect(page.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText(batchLabel, { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await dragOnto(page, batchLabel, "Needs Embedding");
  await dragOnto(page, code, "Embedded Inventory");
}

/** The block drawer, scoped so board cards with the same text don't match. */
function drawer(page: Page) {
  return page.locator("div.border-l").filter({ has: page.getByRole("heading", { name: "Timeline" }) });
}

// ---------------------------------------------------------------------------
// #98 — "'send for cutting' should only be visible in the embedded inventory …
// it should be 'cutting plan' when in the pre-processing and needs embedding
// stage. the dialogue should also not show the 'send for cutting' button until
// they are in the embedded inventory."
// ---------------------------------------------------------------------------
test("#98: it is a Cutting Plan until the block reaches Embedded Inventory", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "cut plan naming");

  // Fresh block, sitting in Pre-processing.
  await page.getByText("EE-1", { exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Cutting Plan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send for Cutting" })).toHaveCount(0);

  // The dialog agrees, and offers no send.
  await page.getByRole("button", { name: "Cutting Plan" }).click();
  const dialog = page.getByRole("dialog", { name: /Cutting Plan/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Send for Cutting/ })).toHaveCount(0);
  // The plan is still draftable — that is the whole point of opening it early.
  await expect(dialog.getByRole("button", { name: "Save Plan" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  // Close the drawer: embed() opens it by clicking the tile, and clicking an
  // already-selected tile toggles it shut instead (#61).
  await drawer(page).locator("button:has(svg.lucide-x)").first().click();
  await expect(drawer(page)).toHaveCount(0);

  // Take it to Embedded Inventory; now it really can be sent.
  await embed(page, "EE-1", "Batch 1");
  await page.getByText("EE-1", { exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Send for Cutting" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cutting Plan" })).toHaveCount(0);
  await page.getByRole("button", { name: "Send for Cutting" }).click();
  const sendDialog = page.getByRole("dialog", { name: /Send for Cutting/ });
  await expect(sendDialog.getByRole("button", { name: /Send for Cutting/ })).toBeVisible();
});

// ---------------------------------------------------------------------------
// #99 — the project switcher is gone, and so is the capability behind it.
// ---------------------------------------------------------------------------
test("#99: the drawer has no project switcher", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "no project switching");
  await page.getByText("EE-1", { exact: true }).first().click();

  await expect(page.getByLabel("Sample project")).toHaveCount(0);
  // The project is still READABLE — removing the control must not remove the
  // answer to "which project is this block in?".
  await expect(drawer(page).getByText(/Enthesis Engineering/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// #100 + #101 — the Stains / IHC list is live, one line per entry, and shows
// what state each slide is in.
// ---------------------------------------------------------------------------
test("#100/#101: the Stains list is live, one line each, with slide state", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "live stain list");
  await embed(page, "EE-1", "Batch 1");

  await page.getByText("EE-1", { exact: true }).first().click();
  const panel = drawer(page);

  // #100 — the control says Add, not Request.
  await expect(panel.getByRole("heading", { name: "Add a Stain" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Add", exact: true })).toBeVisible();

  // Nothing asked for yet, so no list.
  await expect(panel.getByRole("heading", { name: "Stains / IHC" })).toHaveCount(0);

  // Add two agents. Each must appear on its OWN line, flagged as requested —
  // the old panel showed a frozen intake string and never changed at all.
  // Named outright, not picked by index: "CD3" is a substring of "CD31", which
  // makes any hasText row filter ambiguous.
  const select = panel.locator("select").first();
  const firstName = "H&E";
  const secondName = "Ki-67";
  await select.selectOption(`stain::${firstName}`);
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Stains / IHC" })).toBeVisible();
  await select.selectOption(`ihc::${secondName}`);
  await panel.getByRole("button", { name: "Add", exact: true }).click();

  const list = panel.locator("ul").filter({ hasText: firstName });
  await expect(list.locator("li")).toHaveCount(2);
  for (const name of [firstName, secondName]) {
    const row = list.locator("li").filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Requested");
  }

  // #101 — cut them, and the same list turns into slides with a real state.
  await page.getByRole("button", { name: "Send for Cutting" }).click();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();

  await page.getByText("EE-1", { exact: true }).first().click();
  const cutList = drawer(page).locator("ul").filter({ hasText: firstName });
  const cutRow = cutList.locator("li").filter({ hasText: firstName });
  // Named by its slide code now, and honest about not being cut yet: the group
  // is sitting in Needs Sectioning (#95).
  await expect(cutRow).toContainText(/EE-1-[A-Z]+/);
  await expect(cutRow).toContainText("Awaiting cut");
  await expect(cutRow).not.toContainText("Requested");
});

// ---------------------------------------------------------------------------
// #97 — the Logs must say whether a block ran the Short or the Long protocol.
// ---------------------------------------------------------------------------
test("#97: the Logs show Short vs Long processing", async ({ page }) => {
  await signInAndProject(page);

  // One of each protocol.
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("short protocol");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("long protocol");
  await page
    .getByRole("dialog", { name: /New Sample/ })
    .locator("select")
    .filter({ hasText: "Long" })
    .selectOption("Long");
  await page.getByRole("button", { name: /Create Sample/ }).click();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await expect(page.getByRole("columnheader", { name: "Processing" })).toBeVisible();

  const rowFor = (code: string) =>
    page.getByRole("row").filter({ has: page.getByRole("cell", { name: code, exact: true }) });
  await expect(rowFor("EE-1").getByRole("cell", { name: "Short", exact: true })).toBeVisible();
  await expect(rowFor("EE-2").getByRole("cell", { name: "Long", exact: true })).toBeVisible();
});
