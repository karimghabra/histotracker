import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { settleAfterDrop } from "../helpers/drag";

/**
 * #83 — "nothing is ever deleted", driven through the real UI.
 *
 * `issues-73-74-83.spec.ts` already covers the Extras-inventory path end to end.
 * This file covers the three destructive buttons that were converted alongside
 * it and had never been driven through a browser: remove slides from a RACK,
 * remove a CUT GROUP, and the sample drawer's old Delete (now Archive).
 *
 * That gap is the point. #83 was reported fixed twice and was wrong twice, both
 * times because a second removal path nobody clicked still did the old thing.
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
  // dnd-kit swallows every click for 50ms after a drop — wait it out.
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

async function cut(page: Page, code: string) {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();
}

/** Slide codes shown in the Logs drill-down for a sample (removed ones included). */
async function slideCodesInLogs(page: Page, code: string): Promise<string[]> {
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: code, exact: true }).click();
  const codes = await page.locator(`text=/^${code}-[A-Z]+$/`).allTextContents();
  await page.getByRole("cell", { name: code, exact: true }).click();
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  return codes;
}

// #83 — removing a cut group used to DELETE the group and every slide in it.
test("#83: removing a cut group keeps its slides in the log", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "group removal");
  await embed(page, "EE-1", "Batch 1");
  await cut(page, "EE-1");

  const before = await slideCodesInLogs(page, "EE-1");
  expect(before.length).toBeGreaterThan(0);

  // Open the cut group card and remove the whole group.
  await page.getByText("3 slides").first().click();
  await page.locator("button.text-red-600, button:has(svg.lucide-trash-2)").last().click();

  const dialog = page.getByRole("dialog", { name: /Remove this cut group/ });
  await expect(dialog).toBeVisible();
  const confirmBtn = dialog.getByRole("button", { name: "Remove cut group" });
  // The reason is REQUIRED — this is the assertion that would fail if the
  // dialog were bypassable.
  await expect(confirmBtn).toBeDisabled();
  await dialog.getByLabel("Reason for removal").fill("wrong block sectioned");
  await confirmBtn.click();

  // Gone from the board...
  await expect(page.getByText("3 slides")).toHaveCount(0, { timeout: 15000 });

  // ...but every slide is still in the log, flagged, with the reason.
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();
  const after = await page.locator("text=/^EE-1-[A-Z]+$/").allTextContents();
  expect(after.sort()).toEqual(before.sort());
  expect(await page.getByText("Removed", { exact: true }).count()).toBe(before.length);

  await page.getByText("EE-1-A", { exact: true }).first().click();
  await expect(page.getByText("wrong block sectioned").first()).toBeVisible();
});

// #83 — the rack path. Reachable without any cut-stage change: Request Stain
// moves a group's extras into a rack, and the rack drawer can remove them.
test("#83: removing slides from a rack keeps them in the log", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "rack removal");
  await embed(page, "EE-1", "Batch 1");

  // Cut with an agent assigned to one slide, so the group produces a real rack.
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  const assay = page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Extra (no stain)" }) })
    .first();
  await assay.selectOption({ index: 1 });
  const agentName = (await assay.locator("option:checked").textContent())?.trim() ?? "";
  expect(agentName).not.toBe("");
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();

  // Assign an agent to one slide during cutting, then Mark Sectioned — that is
  // what auto-splits the group's stain slides into an agent rack.
  await page.getByText("3 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  const drawerClose = page.locator("button:has(svg.lucide-x)").first();
  if (await drawerClose.isVisible().catch(() => false)) {
    await drawerClose.click().catch(() => undefined);
  }
  const staining = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Staining / IHC", exact: true }) });
  await expect(staining.getByText(agentName).first()).toBeVisible({ timeout: 15000 });

  // Open the rack and tick a slide for removal.
  await staining.getByText(agentName).first().click();
  await page.getByRole("button", { name: "Select slides to remove" }).click();
  // By aria-label, not `.first()` — the drawer also renders protocol-checklist
  // checkboxes, and the first one in the DOM is not a slide.
  await page.getByLabel(/^Select EE-1-[A-Z]+$/).first().check();
  await page.getByRole("button", { name: /Remove 1 slide/ }).click();

  const dialog = page.getByRole("dialog", { name: "Remove slides from this rack" });
  await expect(dialog).toBeVisible();
  const confirmBtn = dialog.getByRole("button", { name: "Remove 1 slide", exact: true });
  await expect(confirmBtn).toBeDisabled();
  await dialog.getByLabel("Reason for removal").fill("slide cracked in the rack");
  await confirmBtn.click();

  // Still in the log, flagged, with its reason.
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();
  await expect(page.getByText("Removed", { exact: true }).first()).toBeVisible({ timeout: 15000 });
});

// #83 — the sample drawer's Delete cascaded through cut groups into slides: the
// single most destructive action in the app. It is now Archive, which hides the
// block and keeps everything.
test("#83: the sample drawer archives instead of deleting", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await signInAndProject(page);
  await addSample(page, "archive not delete");
  await embed(page, "EE-1", "Batch 1");
  await cut(page, "EE-1");

  const before = await slideCodesInLogs(page, "EE-1");
  expect(before.length).toBeGreaterThan(0);

  await page.getByText("EE-1", { exact: true }).first().click();
  // There must be NO delete affordance left in the drawer.
  await expect(page.getByRole("button", { name: /^Delete/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Archive EE-1" }).click();

  // Off the board, hidden from the log by default...
  await expect(page.getByText("EE-1", { exact: true })).toHaveCount(0, { timeout: 15000 });
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toHaveCount(0);

  // ...and completely intact behind "Show archived", slides and all.
  await page.getByLabel("Show archived").check();
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toBeVisible();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();
  const after = await page.locator("text=/^EE-1-[A-Z]+$/").allTextContents();
  expect(after.sort()).toEqual(before.sort());
});
