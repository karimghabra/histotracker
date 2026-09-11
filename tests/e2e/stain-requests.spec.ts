import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { settleAfterDrop } from "../helpers/drag";
import { addStainFromLogsAndReturn } from "../helpers/stains";

// Stain-request cluster (#41 / #62 / #66): the "needs cut" flag on an embedded
// block and the Send-for-Cutting prefill are driven by an OUTSTANDING-requests
// multiset. These validate the two behaviours that were genuinely broken:
//   1. requesting the same agent twice queues TWO slides (was deduped to one);
//   2. re-requesting an agent already cut/produced flags the block AGAIN and
//      prefills the cut dialog (the old produced-subtraction hid it).

async function dragOnto(page: Page, sourceText: string, columnTitle: string) {
  const card = page.getByText(sourceText, { exact: true });
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
  // dnd-kit swallows every click for 50ms after a drop — wait it out.
  await settleAfterDrop(page);
}

async function boot(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Signed-in user").locator("option", { hasText: "Alex Rivera" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  const overlay = page.locator("div.fixed.inset-0.z-50");
  if (await overlay.count()) await overlay.first().click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
  await page.getByRole("button", { name: "New Sample" }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toBeVisible();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("Stain request block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-1")).toBeVisible();
}

async function embed(page: Page, code: string) {
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
    await expect(page.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await dragOnto(page, "Batch 1", "Needs Embedding");
  await dragOnto(page, code, "Embedded Inventory");
}

// The request is made from the Logs now, not the block drawer — #113 removed
// the Embedded Inventory control and #114 made the Logs one add directly. The
// behaviour asserted below is unchanged; only the button that starts it moved.
async function requestStain(page: Page, value: string) {
  await addStainFromLogsAndReturn(page, "EE-1", value);
  await reopenBlock(page);
}

/** The trip through the Logs may drop the board selection; put it back. */
async function reopenBlock(page: Page, code = "EE-1") {
  const send = page.getByRole("button", { name: /Send for Cutting/ }).first();
  if (await send.isVisible().catch(() => false)) return;
  await page.getByText(code, { exact: true }).first().click();
  await expect(send).toBeVisible({ timeout: 15000 });
}

async function cutRows(page: Page): Promise<string[]> {
  const selects = page.locator(".max-h-64 select");
  const n = await selects.count();
  const values: string[] = [];
  for (let i = 0; i < n; i += 1) values.push(await selects.nth(i).inputValue());
  return values;
}

test("requesting the same stain twice queues two slides (#62/#66)", async ({ page }) => {
  await boot(page);
  await embed(page, "EE-1");
  await page.getByText("EE-1", { exact: true }).first().click();

  await requestStain(page, "stain::H&E");
  await requestStain(page, "stain::H&E");

  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await expect(page.getByText(/How many slides to cut/i)).toBeVisible();
  const values = await cutRows(page);
  // TWO H&E rows now, not one.
  expect(values.filter((v) => v === "stain::H&E").length).toBe(2);
});

test("re-requesting an already-cut stain flags the block again (#41/#62)", async ({ page }) => {
  await boot(page);
  await embed(page, "EE-1");
  await page.getByText("EE-1", { exact: true }).first().click();

  // Request H&E → no extras → flags the block.
  await requestStain(page, "stain::H&E");
  await expect(page.getByText(/Stains preselected/i)).toBeVisible();

  // Cut ONLY the H&E slide (remove the extra rows) so no extras remain.
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await expect(page.getByText(/How many slides to cut/i)).toBeVisible();
  const removeButtons = page.locator(".max-h-64 button:has(svg.lucide-x)");
  // Keep removing the last row until only the single H&E row is left.
  await expect(async () => {
    const values = await cutRows(page);
    if (values.length > 1) {
      await removeButtons.last().click();
      throw new Error("still trimming");
    }
    expect(values).toEqual(["stain::H&E"]);
  }).toPass();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();

  // The flag clears once the H&E is cut (request fulfilled). The drawer stays
  // open from the cut, so it reflects the cleared flag directly (re-clicking the
  // tile would now DE-select it — #61).
  await expect(page.getByText(/Stains preselected/i)).toHaveCount(0);

  // Now actually TAKE the sections.
  //
  // This step used to be missing, and the test passed anyway because nothing
  // read the difference. Sending for cutting only queues the group; the glass
  // does not exist until somebody stands at the microtome (#95). #125 is the
  // first behaviour to ask "is this block still waiting to be cut?", and the
  // honest answer here — before this step — was yes. Without it the re-request
  // below correctly joins the queued cut, and this test would be asserting the
  // behaviour #125 deliberately replaced.
  await page.locator("button:has(svg.lucide-x)").first().click();
  await page.getByText(/^\d+ slides? · /).first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await page.getByText("EE-1", { exact: true }).first().click();

  // Re-request H&E: no extras exist, so it must flag the block AGAIN and the
  // Send-for-Cutting dialog must prefill with H&E (the old model hid this).
  await requestStain(page, "stain::H&E");
  await expect(page.getByText(/Stains preselected/i)).toBeVisible();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await expect(page.getByText(/Prefilled from/i)).toBeVisible();
  const values = await cutRows(page);
  expect(values.filter((v) => v === "stain::H&E").length).toBeGreaterThanOrEqual(1);
});

test("#125: a stain requested while the block is queued for cutting joins that cut", async ({
  page,
}) => {
  await boot(page);
  await embed(page, "EE-1");
  await page.getByText("EE-1", { exact: true }).first().click();

  // The plan the issue describes: one stain, plus the default extras, SENT for
  // cutting but not yet cut.
  await requestStain(page, "stain::H&E");
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await expect(page.getByText(/How many slides to cut/i)).toBeVisible();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();

  const sectioning = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Needs Sectioning", exact: true }) });
  await expect(sectioning.getByText(/H&E/).first()).toBeVisible();
  const before = (await sectioning.getByText(/^\d+ slides? · /).first().innerText()).trim();

  // Ask for a second agent while that cut is still waiting. It must join the
  // cut — not send the technician back to the block for a second one.
  await page.getByText("EE-1", { exact: true }).first().click();
  await requestStain(page, "stain::PAS");

  // The block is NOT flagged for a fresh cut…
  await expect(page.getByText(/Stains preselected/i)).toHaveCount(0);

  // …and the waiting cut now carries PAS as well as H&E, one slide larger.
  await expect(sectioning.getByText(/PAS/).first()).toBeVisible();
  const after = (await sectioning.getByText(/^\d+ slides? · /).first().innerText()).trim();
  expect(after).not.toBe(before);
});
