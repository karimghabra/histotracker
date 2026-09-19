// #144, walked through the real app: a stain request for an exhausted block must
// be refused (#70), never joined onto a cut still waiting for that block (#125).
// The captain's ruling was 1b — marking a block exhausted CANCELS its waiting
// cut, with a record — so these assert on what the tech sees: the confirm names
// the cancellation, the card leaves Needs Sectioning, the stain ask is refused,
// a cut already off the microtome is untouched, and Undo puts everything back.
import { test, expect, type Page } from "@playwright/test";
import { settleAfterDrop } from "../helpers/drag";
import { addStainFromLogs } from "../helpers/stains";
import { DB, addProject, addSample, boot } from "../helpers/lab";

const col = (page: Page, title: string) =>
  page.locator("div.rounded-lg").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

/** Cut cards in Needs Sectioning, whichever block they belong to. */
const cutCards = (page: Page) => col(page, "Needs Sectioning").locator("div[aria-selected]");

async function drag(page: Page, src: string, columnTitle: string): Promise<void> {
  const card = page.getByText(src, { exact: true }).first();
  const header = page.getByRole("heading", { name: columnTitle, exact: true });
  const from = await card.boundingBox();
  const to = await header.boundingBox();
  if (!from || !to) throw new Error(`drag endpoints missing for ${src} → ${columnTitle}`);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + 140, { steps: 10 });
  await page.mouse.move(to.x + to.width / 2, to.y + 142, { steps: 3 });
  await page.mouse.up();
  await settleAfterDrop(page);
}

async function closeDrawer(page: Page): Promise<void> {
  const x = page.locator("button:has(svg.lucide-x)").first();
  if (await x.isVisible().catch(() => false)) await x.click();
}

/** Intake → Processor → Needs Embedding → Embedded Inventory, for one block. */
async function embed(page: Page, code: string, batchLabel: string): Promise<void> {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await closeDrawer(page);
  await drag(page, code, "Processor");
  await expect(async () => {
    const start = page.getByRole("button", { name: "Start Batch" });
    if (await start.isVisible().catch(() => false)) await start.click();
    await expect(page.getByText(batchLabel, { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await drag(page, batchLabel, "Needs Embedding");
  await drag(page, code, "Embedded Inventory");
}

/** Send an embedded block for cutting and leave the group WAITING in Needs Sectioning. */
async function sendForCutting(page: Page, code: string, slides: number, stainIndex?: number): Promise<void> {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  const plan = page.getByRole("dialog").filter({ hasText: "How many slides to cut" });
  const rows = plan.locator(".max-h-64 > div");
  await expect(rows.first()).toBeVisible();
  while ((await rows.count()) > slides) await rows.last().getByRole("button").click();
  if (stainIndex !== undefined) await rows.first().locator("select").selectOption({ index: stainIndex });
  await plan.getByRole("button", { name: /Send for Cutting/ }).click();
  await expect(plan).toHaveCount(0);
  await closeDrawer(page);
}

/** Accept the next native confirm and hand back the words it showed. */
function captureConfirm(page: Page): { text: () => string } {
  let seen = "";
  page.on("dialog", (dialog) => {
    seen = dialog.message();
    void dialog.accept();
  });
  return { text: () => seen };
}

/** Live (not removed) slides recorded against a block, straight out of the database. */
const planned = (page: Page, code: string) =>
  page.evaluate(
    async ([path, sampleCode]) => {
      const db = (await import(/* @vite-ignore */ path)) as Record<string, () => Promise<{ select: (q: string, a: unknown[]) => Promise<Array<{ n: number }>> }>>;
      const raw = await db.getDb();
      const rows = await raw.select(
        `SELECT COUNT(*) AS n FROM slides sl
           JOIN section_requests sr ON sr.id = sl.section_request_id
           JOIN samples s ON s.id = sr.sample_id
          WHERE s.sample_code = ? AND sl.current_stage != 'removed'`,
        [sampleCode],
      );
      return rows[0].n;
    },
    // The board shows EE-1; the record holds the padded EE-0001 (#87).
    [DB, code.replace(/-(\d+)$/, (_, n: string) => `-${n.padStart(4, "0")}`)] as const,
  );

/** The stage of the block's only cut group, straight out of the database. */
const groupStage = (page: Page, code: string) =>
  page.evaluate(
    async ([path, sampleCode]) => {
      const db = (await import(/* @vite-ignore */ path)) as Record<string, () => Promise<{ select: (q: string, a: unknown[]) => Promise<Array<{ current_stage: string }>> }>>;
      const raw = await db.getDb();
      const rows = await raw.select(
        `SELECT sr.current_stage FROM section_requests sr
           JOIN samples s ON s.id = sr.sample_id
          WHERE s.sample_code = ? ORDER BY sr.id`,
        [sampleCode],
      );
      return rows.map((r) => r.current_stage).join(",");
    },
    [DB, code.replace(/-(\d+)$/, (_, n: string) => `-${n.padStart(4, "0")}`)] as const,
  );

test("#144: exhausting a block cancels its waiting cut, and the stain ask is then refused", async ({ page }) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addSample(page, "spent block with a cut waiting", "EE");
  await embed(page, "EE-1", "Batch 1");
  await sendForCutting(page, "EE-1", 2);

  await expect(cutCards(page), "the cut waits in Needs Sectioning").toHaveCount(1);
  expect(await planned(page, "EE-1"), "two slides are planned on it").toBe(2);

  const confirm = captureConfirm(page);
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Mark Exhausted/ }).click();

  // The tech is told what the click costs, before it happens.
  expect(confirm.text()).toMatch(/leaves Embedded Inventory/i);
  expect(confirm.text(), "the confirm names the cancelled cut").toMatch(/Needs Sectioning.*cancelled/i);
  expect(confirm.text(), "and that the planned glass goes with it").toMatch(/planned slides are removed/i);
  expect(confirm.text(), "plain dashes only").not.toMatch(/[—–]/);

  await expect(col(page, "Embedded Inventory").getByText("EE-1"), "the block leaves the inventory").toHaveCount(0, {
    timeout: 15000,
  });
  await expect(cutCards(page), "the cut it could never carry out is gone from the board").toHaveCount(0);
  await expect
    .poll(() => planned(page, "EE-1"), { timeout: 15000 })
    .toBe(0);

  // #70, which #125 used to let through whenever a cut was queued.
  const flash = await addStainFromLogs(page, "EE-1", "stain::H&E");
  expect(flash, `the Logs said "${flash}"`).toMatch(/cannot be cut again|exhausted/i);
  expect(await planned(page, "EE-1"), "the refusal planned no glass").toBe(0);

  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  await expect(cutCards(page), "and no cut card came back").toHaveCount(0);
  await expect(page.getByText("⚑ needs cut"), "nor was the spent block flagged for a cut").toHaveCount(0);
});

test("#144: a cut already off the microtome is left alone when the block is exhausted", async ({ page }) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addSample(page, "spent block, already cut", "EE");
  await embed(page, "EE-1", "Batch 1");
  await sendForCutting(page, "EE-1", 1, 1); // one slide, carrying the first catalog stain

  // Cut it: the group leaves needs_sectioning for the staining rack, so
  // exhausting the spent block must not reach back and cancel real glass.
  await cutCards(page).first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  await closeDrawer(page);
  const rack = col(page, "Staining / IHC").locator("div[aria-selected]");
  await expect(rack, "the cut glass is in a staining rack").toHaveCount(1);
  const stageBefore = await groupStage(page, "EE-1");
  expect(stageBefore).not.toBe("needs_sectioning");

  captureConfirm(page);
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Mark Exhausted/ }).click();
  await expect(col(page, "Embedded Inventory").getByText("EE-1")).toHaveCount(0, { timeout: 15000 });

  await expect(rack, "the glass that was really cut stays on the board").toHaveCount(1);
  expect(await groupStage(page, "EE-1"), "its cut group is untouched").toBe(stageBefore);
  expect(await planned(page, "EE-1"), "and its slide is still a live record").toBe(1);
});

test("#144: a database that already holds the state shows no waiting cut to drag onward", async ({ page }) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addSample(page, "already spent, cut still queued", "EE");
  await embed(page, "EE-1", "Batch 1");
  await sendForCutting(page, "EE-1", 1);
  await expect(cutCards(page)).toHaveCount(1);
  expect(await planned(page, "EE-1")).toBe(1);

  // The live-lab condition the issue was reported from: the flag set behind the
  // app's back, with the cut still queued. Nothing converts it on open.
  await page.evaluate(async (path) => {
    const db = (await import(/* @vite-ignore */ path)) as Record<string, () => Promise<{ execute: (q: string) => Promise<unknown> }>>;
    const raw = await db.getDb();
    await raw.execute(`UPDATE samples SET block_exhausted = 1`);
  }, DB);
  // Plain "/" — ?freshdb=1 would wipe the database this test just arranged.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pre-processing", exact: true })).toBeVisible({ timeout: 20_000 });

  await expect(cutCards(page), "the stranded card is not shown, so it cannot be dragged to Sectioned").toHaveCount(0);
  expect(await groupStage(page, "EE-1"), "the record is only hidden, not rewritten").toBe("needs_sectioning");
  expect(await planned(page, "EE-1"), "its planned glass is untouched - this is a read path only").toBe(1);

  const flash = await addStainFromLogs(page, "EE-1", "stain::H&E");
  expect(flash, `the Logs said "${flash}"`).toMatch(/cannot be cut again|exhausted/i);
  expect(await planned(page, "EE-1"), "nothing joined the stranded cut").toBe(1);
});

test("#144: exhausting two selected blocks at once says how many cuts it cancels", async ({ page }) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addSample(page, "first spent block", "EE");
  await addSample(page, "second spent block", "EE");
  await embed(page, "EE-1", "Batch 1");
  await embed(page, "EE-2", "Batch 2");
  await sendForCutting(page, "EE-1", 1);
  await sendForCutting(page, "EE-2", 1);
  await expect(cutCards(page)).toHaveCount(2);

  const inventory = col(page, "Embedded Inventory");
  await inventory.getByLabel("Select EE-1").check();
  await inventory.getByLabel("Select EE-2").check();

  const confirm = captureConfirm(page);
  await page.getByRole("button", { name: /Mark 2 Exhausted/ }).click();
  expect(confirm.text(), "the bulk confirm names the count").toMatch(/2 selected samples/);
  expect(confirm.text(), "and the cuts it cancels for those blocks").toMatch(/those 2 blocks is cancelled/);
  expect(confirm.text()).toMatch(/planned slides are removed/i);
  expect(confirm.text(), "plain dashes only").not.toMatch(/[—–]/);

  await expect(inventory.getByText(/EE-[12]/)).toHaveCount(0, { timeout: 15000 });
  await expect(cutCards(page), "both waiting cuts are cancelled").toHaveCount(0);
  for (const code of ["EE-1", "EE-2"]) {
    await expect.poll(() => planned(page, code), { timeout: 15000 }).toBe(0);
  }
});

test("#144: Undo puts the block and the cut it cancelled back", async ({ page }) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addSample(page, "exhausted by mistake", "EE");
  await embed(page, "EE-1", "Batch 1");
  await sendForCutting(page, "EE-1", 2);

  captureConfirm(page);
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Mark Exhausted/ }).click();
  await expect(cutCards(page)).toHaveCount(0, { timeout: 15000 });

  await page.getByTitle("Undo (Ctrl+Z)").click({ force: true });
  await expect(col(page, "Embedded Inventory").getByText("EE-1").first(), "the block is back").toBeVisible({
    timeout: 15000,
  });
  await expect(cutCards(page), "and so is the cut that was cancelled with it").toHaveCount(1);
  await expect.poll(() => planned(page, "EE-1"), { timeout: 15000 }).toBe(2);
});
