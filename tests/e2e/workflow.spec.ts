import { test, expect, type Page } from "@playwright/test";

// Real end-to-end drive of the lab workflow in the actual app, used to verify
// the sectioning/processing issues (#35, #36, #40, #41, #42, #37) against the
// running UI rather than the data layer alone.

async function seedSample(page: Page, description = "Workflow block") {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await page.getByTitle("Manage lab users").click();
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
  await page.getByRole("button", { name: "New Sample" }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toBeVisible();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(description);
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-0001")).toBeVisible();
}

// Walk the pre-processing checklist in the drawer so the block reaches
// in_ethanol (the only stage from which it can be dragged into the Processor).
async function completePreprocessing(page: Page, code = "EE-0001") {
  await page.getByText(code, { exact: true }).click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click(); // close drawer
}

async function addSample(page: Page, description: string) {
  await page.getByRole("button", { name: "New Sample" }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toBeVisible();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(description);
  await page.getByRole("button", { name: /Create Sample/ }).click();
}

// dnd-kit PointerSensor: move past the 5px activation threshold, then step onto
// the target droppable and settle before releasing.
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
}

// Advance a freshly-created block all the way to Embedded Inventory.
async function embedBlock(page: Page) {
  await completePreprocessing(page);
  await dragOnto(page, "EE-0001", "Processor");
  await page.getByRole("button", { name: "Start Batch" }).click();
  await expect(page.getByText("Batch 1", { exact: true })).toBeVisible();
  await dragOnto(page, "Batch 1", "Needs Embedding");
  await dragOnto(page, "EE-0001", "Embedded Inventory");
}

test("processing run dialog has no mode tab and infers plan from time (#42)", async ({ page }) => {
  await seedSample(page);
  await completePreprocessing(page);
  await dragOnto(page, "EE-0001", "Processor");

  await expect(page.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Plan for later" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start now" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start Batch" })).toBeVisible();

  const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
  await page.getByLabel(/Planned Start|Processing Started/).fill(future);
  await expect(page.getByRole("button", { name: "Plan Batch" })).toBeVisible();
});

test("undo of a staining-lane transfer removes the tile it created (#31)", async ({ page }) => {
  await seedSample(page);
  await embedBlock(page);

  // Cut one stained slide so Mark Sectioned mints a Staining rack tile.
  await page.getByText("EE-0001", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Extra (no stain)" }) })
    .first()
    .selectOption({ index: 1 });
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();

  // Mark Sectioned → the section leaves Needs Sectioning and a stain rack tile
  // ("Alcian Blue") is minted in Staining.
  await page.getByText("4 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  await page.locator("button:has(svg.lucide-x)").first().click(); // close drawer
  const staining = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Staining / IHC" }) });
  await expect(staining.getByText("Alcian Blue").first()).toBeVisible(); // rack minted in Staining
  await expect(page.getByText("4 slides")).toHaveCount(0); // section left Needs Sectioning

  // Undo the transfer → the minted tile must disappear from Staining (no ghost)
  // and the Needs Sectioning card must return. Under whole-DB-image undo this is
  // just a restore of the prior state, so nothing is left behind.
  await page.getByTitle("Undo (Ctrl+Z)").click({ force: true });
  await expect(staining.getByText("Alcian Blue")).toHaveCount(0); // no ghost tile in Staining
  await expect(page.getByText("4 slides").first()).toBeVisible(); // section restored
});

test("a planned run's sample list is editable in the drawer (#32)", async ({ page }) => {
  await seedSample(page); // EE-0001
  await addSample(page, "Second block"); // EE-0002
  await expect(page.getByText("EE-0002")).toBeVisible();

  // Both blocks reach in_ethanol so they're eligible for processing.
  await completePreprocessing(page, "EE-0001");
  await completePreprocessing(page, "EE-0002");

  // Plan a run (future start time) containing only EE-0001.
  await dragOnto(page, "EE-0001", "Processor");
  const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
  await page.getByLabel(/Planned Start|Processing Started/).fill(future);
  await expect(page.getByRole("button", { name: "Plan Batch" })).toBeVisible();
  await page.getByRole("button", { name: "Plan Batch" }).click();

  // Open the planned batch tile → drawer shows one member. (The Processor tiles
  // re-render on the app's auto-advance interval, so Playwright's stability wait
  // never settles; force past it and retry until the drawer opens.)
  await expect(page.getByText(/PLANNED FOR/)).toBeVisible();
  await expect(async () => {
    await page.getByText(/PLANNED FOR/).click({ force: true });
    await expect(page.getByRole("heading", { name: /Processing Batch/ })).toBeVisible({
      timeout: 1000,
    });
  }).toPass();
  await expect(page.getByText(/protocol · 1 samples/)).toBeVisible();

  // Add EE-0002 to the planned run from the eligible-samples list (scope to the
  // drawer — the Pre-processing card also carries "EE-0002").
  const drawer = page.locator("aside");
  await drawer.getByRole("button", { name: "Add", exact: true }).click({ force: true });
  await drawer.getByRole("button", { name: /EE-0002/ }).click({ force: true });
  await expect(page.getByText(/protocol · 2 samples/)).toBeVisible();

  // And it can be removed again (X on the member row).
  await drawer
    .getByRole("button", { name: "Remove from this planned run" })
    .first()
    .click({ force: true });
  await expect(page.getByText(/protocol · 1 samples/)).toBeVisible();
});

test("sectioning: per-slide cutting, no stale plan tag, slide-count button (#35/#36/#40)", async ({ page }) => {
  await seedSample(page);
  await embedBlock(page);

  // #36: the embedded tile carries no misleading "N slides planned" tag.
  await expect(page.getByText("EE-0001")).toBeVisible();
  await expect(page.getByText(/slides planned/i)).toHaveCount(0);

  // #35: Send for Cutting is a per-slide "how many slides / which get a stain" model.
  await page.getByText("EE-0001", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await expect(page.getByText(/How many slides to cut/i)).toBeVisible();
  await expect(page.getByText(/4 slides · 0 stained · 4 extra/)).toBeVisible();

  // Send the default cut → a Needs Sectioning card appears for the sample.
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await expect(page.getByText("4 slides").first()).toBeVisible();

  // #40: the Mark Sectioned button counts SLIDES (4), not stain types (0).
  await page.getByText("4 slides").first().click();
  await expect(page.getByRole("button", { name: "Mark Sectioned (4)" })).toBeVisible();
});

test("requesting a stain flags the embedded block and prefills the cut dialog (#41)", async ({ page }) => {
  await seedSample(page);
  await embedBlock(page);

  // Request a stain on the embedded block (no extras exist yet → flags the block).
  await page.getByText("EE-0001", { exact: true }).first().click();
  const agentSelect = page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Choose an agent" }) });
  await agentSelect.selectOption({ index: 1 });
  await page.getByRole("button", { name: "Request", exact: true }).click();

  // The drawer confirms the block now carries a preselected stain.
  await expect(page.getByText(/preselected/i).first()).toBeVisible();
  await page.locator("button:has(svg.lucide-x)").first().click();

  // #41a: the embedded tile shows the needs-stain flag.
  await expect(page.getByText(/needs stain/i)).toBeVisible();

  // #41b: Send for Cutting is prefilled from the block's preselected stains.
  await page.getByText("EE-0001", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await expect(page.getByText(/Prefilled from this block/i)).toBeVisible();
});

test("needs-sectioning card exposes a real multi-select checkbox (#37)", async ({ page }) => {
  await seedSample(page);
  await embedBlock(page);
  await page.getByText("EE-0001", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await expect(page.getByText("4 slides").first()).toBeVisible();

  // The card's checkbox is a real input that toggles selection on click.
  // Scope to the Needs Sectioning column (the block also sits in Embedded
  // Inventory, which has its own same-named checkbox).
  const needsSectioning = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Needs Sectioning", exact: true }) });
  const checkbox = needsSectioning.getByRole("checkbox", { name: "Select EE-0001" });
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();
});
