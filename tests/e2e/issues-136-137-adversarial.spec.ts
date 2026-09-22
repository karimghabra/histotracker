import { test, expect, type Page, type Locator } from "../helpers/test";
import { openManage } from "../helpers/app";
import { addStainFromLogs } from "../helpers/stains";
import { cutBlockFor } from "../helpers/cut";

async function boot(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
}

async function newSample(
  page: Page,
  opts: { description: string; embeddingNotes?: string; stains?: string[]; assertTicked?: boolean },
) {
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(opts.description);
  if (opts.embeddingNotes !== undefined) {
    await page.getByLabel("Embedding Notes").fill(opts.embeddingNotes);
  }
  const boxes: Locator[] = [];
  for (const stain of opts.stains ?? []) {
    const box = page.locator("label").filter({ hasText: stain }).last().getByRole("checkbox");
    await box.check();
    boxes.push(box);
  }
  if (opts.assertTicked) {
    // What the capture this replaced was opened to check: the boxes are
    // actually ticked, and the dialog itself is not cut off.
    for (const box of boxes) await expect(box).toBeChecked();
    const dialog = page.getByRole("dialog", { name: /New Sample/ });
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box, "the New Sample dialog is on screen").toBeTruthy();
    if (box && viewport) {
      expect(box.x, "dialog not clipped on the left").toBeGreaterThanOrEqual(0);
      expect(box.y, "dialog not clipped on the top").toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, "dialog not clipped on the right").toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height, "dialog not clipped on the bottom").toBeLessThanOrEqual(viewport.height + 1);
    }
  }
  await page.getByRole("button", { name: /Create Sample/ }).click();
}

const row = (page: Page, code: string) =>
  page.getByRole("row").filter({ has: page.getByRole("cell", { name: code, exact: true }) });

// The concrete sequence from the review finding: cut a block for H&E, then
// re-request H&E from the Logs. Every named agent then carries an outstanding
// request, but the block has real glass — so it must NOT read "all assigned".
test("adversarial: a cut block that re-requests its only agent is not 'all assigned'", async ({
  page,
}) => {
  await boot(page);
  await newSample(page, { description: "cut then re-requested" });
  await expect(page.getByText("EE-1")).toBeVisible();
  await cutBlockFor(page, "EE-1", "H&E");
  expect(await addStainFromLogs(page, "EE-1", "stain::H&E")).toContain("H&E");

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  // Collapse the row the helper expanded.
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();
  const r = row(page, "EE-1");
  await expect(r).toContainText("H&E");
  await expect(r).not.toContainText("all assigned");
  // …and the row really does have glass, which is what makes the claim a lie.
  await expect(r.getByRole("cell").nth(7)).not.toHaveText("0");
});

// #136 for the Assay Type filter: an IHC assigned but never cut must be found.
test("adversarial: the Assay Type filter finds an assigned-but-uncut IHC", async ({ page }) => {
  await boot(page);
  await newSample(page, {
    description: "IHC assigned, never cut",
    embeddingNotes: "bisect longitudinally, cut face down",
    stains: ["CD68"],
    assertTicked: true,
  });
  await newSample(page, { description: "stain only", stains: ["Safranin O"] });
  await expect(page.getByText("EE-2")).toBeVisible();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  // The block really does name its assigned IHC before any filter is applied.
  await expect(row(page, "EE-1")).toContainText("CD68");
  const typeSelect = page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Any type" }) });
  await typeSelect.selectOption("ihc");
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "EE-2", exact: true })).toHaveCount(0);

  // The opposite type must not sweep it in.
  await typeSelect.selectOption("stain");
  await expect(page.getByRole("cell", { name: "EE-2", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toHaveCount(0);
});

// #137 end to end through persistence: the note typed at intake survives a
// reload of the same database and is shown where the block is read.
test("adversarial: an embedding note typed at intake survives a reload", async ({ page }) => {
  await boot(page);
  await newSample(page, {
    description: "note persistence",
    embeddingNotes: 'proximal end left; "do not bisect"',
  });
  await expect(page.getByText("EE-1")).toBeVisible();

  await page.goto("/"); // same shim database, WITHOUT freshdb=1
  await expect(page.getByText("Enthesis Engineering").first()).toBeVisible();
  await page.getByText("Enthesis Engineering").first().click();
  await expect(page.getByText("EE-1", { exact: true }).first()).toBeVisible();
  await page.getByText("EE-1", { exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Embedding Notes" })).toBeVisible();
  await expect(page.getByText('proximal end left; "do not bisect"')).toBeVisible();
});
