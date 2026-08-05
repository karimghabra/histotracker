import { test, expect, type Page } from "@playwright/test";
import { settleAfterDrop } from "../helpers/drag";

// Real end-to-end drive of the lab workflow in the actual app, used to verify
// the sectioning/processing issues (#35, #36, #40, #41, #42, #37) against the
// running UI rather than the data layer alone.

async function seedSample(page: Page, description = "Workflow block") {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await page.getByRole("button", { name: "Manage" }).click();
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
  await expect(page.getByText("EE-1")).toBeVisible();
}

// Walk the pre-processing checklist in the drawer so the block reaches
// in_ethanol (the only stage from which it can be dragged into the Processor).
async function completePreprocessing(page: Page, code = "EE-1") {
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
  // dnd-kit swallows every click for 50ms after a drop — wait it out.
  await settleAfterDrop(page);
}

// Advance a freshly-created block all the way to Embedded Inventory.
async function embedBlock(page: Page) {
  await completePreprocessing(page);
  await dragOnto(page, "EE-1", "Processor");
  await expect(page.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  // A background refetch can momentarily blank the active operator and no-op the
  // Start-Batch click, so retry it until the batch actually appears.
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await dragOnto(page, "Batch 1", "Needs Embedding");
  await dragOnto(page, "EE-1", "Embedded Inventory");
}

test("processing run dialog has no mode tab and infers plan from time (#42)", async ({ page }) => {
  await seedSample(page);
  await completePreprocessing(page);
  await dragOnto(page, "EE-1", "Processor");

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
  await page.getByText("EE-1", { exact: true }).first().click();
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
  await seedSample(page); // EE-1
  await addSample(page, "Second block"); // EE-2
  await expect(page.getByText("EE-2")).toBeVisible();

  // Both blocks reach in_ethanol so they're eligible for processing.
  await completePreprocessing(page, "EE-1");
  await completePreprocessing(page, "EE-2");

  // Plan a run (future start time) containing only EE-1.
  await dragOnto(page, "EE-1", "Processor");
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

  // Add EE-2 to the planned run from the eligible-samples list (scope to the
  // drawer — the Pre-processing card also carries "EE-2").
  const drawer = page.locator("aside");
  await drawer.getByRole("button", { name: "Add", exact: true }).click({ force: true });
  await drawer.getByRole("button", { name: /EE-2/ }).click({ force: true });
  await expect(page.getByText(/protocol · 2 samples/)).toBeVisible();

  // And it can be removed again (X on the member row). Addressed by aria-label,
  // which names the sample: the button's TITLE now varies with whether the run
  // is planned or already going (#91), so it is no longer a stable handle.
  await drawer
    .getByRole("button", { name: "Remove EE-1 from this run" })
    .click({ force: true });
  await expect(page.getByText(/protocol · 1 samples/)).toBeVisible();
});

test("sectioning: per-slide cutting, no stale plan tag, slide-count button (#35/#36/#40)", async ({ page }) => {
  await seedSample(page);
  await embedBlock(page);

  // #36: the embedded tile carries no misleading "N slides planned" tag.
  await expect(page.getByText("EE-1")).toBeVisible();
  await expect(page.getByText(/slides planned/i)).toHaveCount(0);

  // #35: Send for Cutting is a per-slide "how many slides / which get a stain" model.
  await page.getByText("EE-1", { exact: true }).first().click();
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
  await page.getByText("EE-1", { exact: true }).first().click();
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
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await expect(page.getByText(/Prefilled from .* preselected stains/i)).toBeVisible();
});

test("needs-sectioning card exposes a real multi-select checkbox (#37)", async ({ page }) => {
  await seedSample(page);
  await embedBlock(page);
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await expect(page.getByText("4 slides").first()).toBeVisible();

  // The card's checkbox is a real input that toggles selection on click.
  // Scope to the Needs Sectioning column (the block also sits in Embedded
  // Inventory, which has its own same-named checkbox).
  const needsSectioning = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Needs Sectioning", exact: true }) });
  const checkbox = needsSectioning.getByRole("checkbox", { name: "Select EE-1" });
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();
});

// Drives a stained slide all the way to Analyzed, verifying two things the aggregate
// stack row gets wrong after a stain rack scatters into a per-sample imaging stack:
//   1. the drawer's Stack timeline still shows the pre-imaging stamps
//      (Stained/Coverslipped/Dried) — recovered from the slides, not the stack row;
//   2. the Logs "Analyzed" filter matches a sample whose slides were analyzed
//      (a block never reaches the analyzed stage itself).
test("stack timeline keeps pre-imaging stamps; Logs Analyzed filter matches analyzed slides", async ({ page }) => {
  await seedSample(page);
  await embedBlock(page);

  // Cut with one stained slide (index 1 = first catalog stain, Alcian Blue).
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Extra (no stain)" }) })
    .first()
    .selectOption({ index: 1 });
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();

  // Mark Sectioned → a stain rack ("Alcian Blue") is minted in Staining.
  await page.getByText("4 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  await page.locator("button:has(svg.lucide-x)").first().click(); // close drawer
  const staining = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Staining / IHC" }) });
  await staining.getByText("Alcian Blue").first().click();

  // Run the whole stain protocol (Stained → Coverslipped → Dried). Finishing the
  // last step auto-advances the rack to Ready for Imaging, scattering it into a
  // per-sample imaging stack (which is where the aggregate row loses the stamps).
  await page.getByLabel("Active operator").fill("Alex");
  for (const step of ["Stained", "Coverslipped"]) {
    await page.getByRole("button", { name: step, exact: true }).click();
  }
  // Finishing the protocol scatters the rack and auto-closes its drawer.

  // Open the scattered stack in Ready for Imaging and check its timeline.
  const imaging = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Ready for Imaging", exact: true }) });
  await imaging.getByText("EE-1", { exact: true }).first().click();
  await expect(page.getByText("Stack timeline")).toBeVisible();
  // (1) The pre-imaging stamps survived the scatter (recovered from the slides).
  const stainedRow = page.locator("li").filter({ hasText: /^Stained/ });
  await expect(stainedRow).toContainText(/\d{4}-\d{2}-\d{2}/);
  await expect(page.locator("li").filter({ hasText: /^Coverslipped/ })).toContainText(/\d{4}-\d{2}-\d{2}/);
  await page.screenshot({ path: "test-results/stack-timeline.png" });

  // Complete Imaging → Mark Analyzed → the slide is analyzed.
  await page.getByRole("button", { name: /Complete Imaging/ }).click();
  await page.getByRole("button", { name: /Mark Analyzed/ }).click();

  // (2) The Logs stage filter places the sample in the Analyzed phase.
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.locator("summary").filter({ hasText: /stage/ }).click();
  await page.getByRole("checkbox", { name: "Analyzed" }).check();
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toBeVisible();
  // Filter to a different phase → the analyzed sample drops out.
  await page.getByRole("checkbox", { name: "Analyzed" }).uncheck();
  await page.getByRole("checkbox", { name: "Staining / IHC" }).check();
  await expect(page.getByText("No samples match")).toBeVisible();
});

// Drives one sample to fully-analyzed and leaves a second in progress, then
// exercises the Logs status partition and the CSV export end to end.
test("Logs status partition + CSV export", async ({ page }) => {
  await seedSample(page); // EE-1
  await embedBlock(page);

  // EE-1 → analyzed (cut a stain, run the protocol, image, analyze).
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Extra (no stain)" }) })
    .first()
    .selectOption({ index: 1 });
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.getByText("4 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  const staining = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Staining / IHC" }) });
  await staining.getByText("Alcian Blue").first().click();
  await page.getByLabel("Active operator").fill("Alex");
  for (const step of ["Stained", "Coverslipped"]) {
    await page.getByRole("button", { name: step, exact: true }).click();
  }
  const imaging = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Ready for Imaging", exact: true }) });
  await imaging.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Complete Imaging/ }).click();
  await page.getByRole("button", { name: /Mark Analyzed/ }).click();
  // Marking analyzed removes the stack from the board and auto-closes its drawer.

  // A second block, left in pre-processing → still Active (no analyzed slides).
  await addSample(page, "In-progress block"); // EE-2
  await expect(page.getByText("EE-2")).toBeVisible();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();

  // No filter → both. Stage=Analyzed → only EE-1. Stage=Pre-processing → only EE-2.
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "EE-2", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/logs-all.png", fullPage: true });

  await page.locator("summary").filter({ hasText: /stage/ }).click();
  await page.getByRole("checkbox", { name: "Analyzed" }).check();
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "EE-2", exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Analyzed" }).uncheck();
  await page.getByRole("checkbox", { name: "Pre-processing" }).check();
  await expect(page.getByRole("cell", { name: "EE-2", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Pre-processing" }).uncheck();

  // Export CSV (no stage filter) → confirmation + the file lands in the virtual FS.
  await page.getByRole("button", { name: "CSV", exact: true }).click();
  await expect(page.getByText("Exported.")).toBeVisible();
  const csv = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith("histometer-shim-fs:") && k.endsWith(".csv")) return atob(localStorage.getItem(k) as string);
    }
    return null;
  });
  expect(csv).toContain("Sample ID");
  expect(csv).toContain("EE-1-A");
  expect(csv).toContain("Alcian Blue");
  expect(csv).toContain("EE-2"); // the slide-less in-progress block still appears

  // Export XLSX too → a .xlsx lands in the virtual FS.
  await page.getByRole("button", { name: "Excel", exact: true }).click();
  await expect(page.getByText("Exported.")).toBeVisible();
  const hasXlsx = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith("histometer-shim-fs:") && k.endsWith(".xlsx")) return true;
    }
    return false;
  });
  expect(hasXlsx).toBe(true);
});

test("section drawer lists assay slides across all grouped cut groups (#55)", async ({ page }) => {
  await seedSample(page);
  await embedBlock(page);

  // Cut with TWO different agents → two section_requests, grouped under one card.
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  const rows = page.locator(".max-h-64 select");
  await rows.nth(0).selectOption({ index: 1 });
  await rows.nth(1).selectOption({ index: 2 });
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();

  // Open the grouped Needs Sectioning card → the drawer shows BOTH assay slides,
  // not just the first cut group's one slide.
  await page.getByText("4 slides").first().click();
  await expect(page.getByText("Assay slides")).toBeVisible();
  await expect(page.getByText("EE-1-A", { exact: true })).toBeVisible();
  await expect(page.getByText("EE-1-B", { exact: true })).toBeVisible();
});

test("undo after the staining scatter returns to Staining, not Needs Sectioning (#56)", async ({ page }) => {
  await seedSample(page);
  await embedBlock(page);
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Extra (no stain)" }) })
    .first()
    .selectOption({ index: 1 });
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await page.getByText("4 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();

  const col = (title: string) =>
    page.locator("div.rounded-lg").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

  // Run the stain protocol → scatter into Ready for Imaging.
  await col("Staining / IHC").getByText("Alcian Blue").first().click();
  await page.getByLabel("Active operator").fill("Alex");
  const steps = ["Stained", "Coverslipped"];
  for (let i = 0; i < steps.length; i += 1) {
    await page.getByRole("button", { name: steps[i], exact: true }).click();
    if (i < steps.length - 1) await expect(page.getByText(new RegExp(`${i + 1}/2 complete`))).toBeVisible();
  }
  await expect(col("Ready for Imaging").getByText("EE-1").first()).toBeVisible({ timeout: 15000 });

  // Undo once → slides return to Staining, NOT all the way to Needs Sectioning.
  await page.getByTitle("Undo (Ctrl+Z)").click({ force: true });
  await expect(col("Staining / IHC").getByText("Alcian Blue").first()).toBeVisible({ timeout: 15000 });
  await expect(col("Ready for Imaging").getByText("EE-1")).toHaveCount(0);
  await expect(col("Needs Sectioning").getByText("4 slides")).toHaveCount(0);
});

test("undo AND redo of the imaging transfer leave no ghost/duplicate tile (#31)", async ({ page }) => {
  await seedSample(page);
  await embedBlock(page);
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Extra (no stain)" }) })
    .first()
    .selectOption({ index: 1 });
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await page.getByText("4 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();

  const col = (title: string) =>
    page.locator("div.rounded-lg").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

  // Scatter into Ready for Imaging.
  await col("Staining / IHC").getByText("Alcian Blue").first().click();
  await page.getByLabel("Active operator").fill("Alex");
  for (const step of ["Stained", "Coverslipped"]) {
    await page.getByRole("button", { name: step, exact: true }).click();
  }
  await expect(col("Ready for Imaging").getByText("EE-1").first()).toBeVisible({ timeout: 15000 });

  // Undo → the imaging tile disappears entirely (no ghost left behind, #31);
  // the stack returns to Staining.
  await page.getByTitle("Undo (Ctrl+Z)").click({ force: true });
  await expect(col("Ready for Imaging").getByText("EE-1")).toHaveCount(0, { timeout: 15000 });
  await expect(col("Staining / IHC").getByText("Alcian Blue").first()).toBeVisible();

  // Redo → it comes back in imaging and Staining is cleared (moved forward, not
  // duplicated across columns).
  await page.getByTitle("Redo (Ctrl+Y)").click({ force: true });
  await expect(col("Ready for Imaging").getByText("EE-1").first()).toBeVisible({ timeout: 15000 });
  await expect(col("Staining / IHC").getByText("Alcian Blue")).toHaveCount(0);
});
