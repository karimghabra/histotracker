import { test, expect, type Page } from "@playwright/test";

// Drives the real app in Chromium for the 0.6.x issue wave (#75, #78, #81, #82,
// #84). The staining-rack case (#81) is the important one: it reproduces the
// reporter's exact sequence — tick "Stained" on a rack, then move another sample
// into staining — and asserts the two do NOT merge.

async function signInAndProject(page: Page, code = "EE", name = "Enthesis Engineering") {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
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
  await page.locator('input[placeholder="EE"]').fill(code);
  await page.locator('input[placeholder="Enthesis Engineering"]').fill(name);
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
}

async function preprocess(page: Page, code: string) {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
}

// Block → Processor → batch → Needs Embedding → Embedded Inventory.
async function embed(page: Page, code: string, batchLabel: string) {
  await preprocess(page, code);
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

// Cut one slide of the first catalog stain, then mark the group sectioned so it
// lands in Staining as a rack for that agent.
async function cutAndSectionIntoStaining(page: Page, code: string, stainIndex = 1) {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Extra (no stain)" }) })
    .first()
    .selectOption({ index: stainIndex });
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await page.getByText("4 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
}

// Run the 3-step protocol on the ONLY rack currently in Staining, which scatters
// it into that sample's Ready-for-Imaging stack.
async function runProtocolOnLoneRack(page: Page) {
  const staining = col(page, "Staining / IHC");
  await staining.locator("div[aria-selected]").first().click();
  await page.getByLabel("Active operator").fill("Alex");
  for (const step of ["Stained", "Coverslipped"]) {
    await page.getByRole("button", { name: step, exact: true }).click();
  }
}

const col = (page: Page, title: string) =>
  page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });

test("#81: a rack whose Stained box is ticked does not absorb a newly-moved sample", async ({
  page,
}) => {
  await signInAndProject(page);
  await addSample(page, "first block");
  await embed(page, "EE-1", "Batch 1");
  await cutAndSectionIntoStaining(page, "EE-1");

  const staining = col(page, "Staining / IHC");
  // One card per rack; the agent name appears twice per card (title + summary),
  // so count the cards themselves.
  const racks = staining.locator("div[aria-selected]");
  await expect(staining.getByText("Alcian Blue").first()).toBeVisible({ timeout: 15000 });
  await expect(racks).toHaveCount(1);
  await expect(racks.first()).toContainText("1 sample");

  // Tick ONLY "Stained" — the rack is mid-protocol, not yet coverslipped. This
  // is the state that used to leave it open to newcomers.
  await staining.getByText("Alcian Blue").first().click();
  await page.getByLabel("Active operator").fill("Alex");
  await page.getByRole("button", { name: "Stained", exact: true }).click();
  await expect(page.getByText(/1\/2 complete/)).toBeVisible();
  await page.locator("button:has(svg.lucide-x)").first().click();

  // Now move a SECOND sample into staining with the same agent.
  await addSample(page, "second block");
  await embed(page, "EE-2", "Batch 2");
  await cutAndSectionIntoStaining(page, "EE-2");

  // Two separate Alcian Blue racks must coexist — the stained one and a fresh
  // loading rack — so the samples can still be told apart. Before the fix the
  // second sample was absorbed, leaving ONE rack reading "2 samples".
  await expect(racks).toHaveCount(2, { timeout: 15000 });
  await expect(staining.getByText("2 samples")).toHaveCount(0);
  await expect(staining.getByText("1 sample")).toHaveCount(2);
});

// #80 — drying is no longer tracked. A fresh rack's protocol is two steps, and
// finishing those two is enough to reach Ready for Imaging (previously it sat
// waiting for a third).
test("#80: the stain protocol no longer has a drying step", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "no drying");
  await embed(page, "EE-1", "Batch 1");
  await cutAndSectionIntoStaining(page, "EE-1");

  const staining = col(page, "Staining / IHC");
  await staining.locator("div[aria-selected]").first().click();
  await page.getByLabel("Active operator").fill("Alex");

  await expect(page.getByRole("button", { name: "Stained", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Coverslipped", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dried", exact: true })).toHaveCount(0);
  await expect(page.getByText(/0\/2 complete/)).toBeVisible();

  await page.getByRole("button", { name: "Stained", exact: true }).click();
  await expect(page.getByText(/1\/2 complete/)).toBeVisible();
  await page.getByRole("button", { name: "Coverslipped", exact: true }).click();

  // Two steps is the whole protocol — the rack scatters into imaging.
  await expect(col(page, "Ready for Imaging").getByText("EE-1").first()).toBeVisible({
    timeout: 15000,
  });
});

// #84 lives in its own spec (tests/e2e/sidebar-active-project.spec.ts): it needs
// three projects to be a fair test of "which one is selected?", and it captures
// screenshots across themes for a human to judge prominence.

test("#78: the matcha theme is selectable and applies", async ({ page }) => {
  await signInAndProject(page);
  await page.getByLabel("Visual theme").selectOption("matcha");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "matcha");
  // The theme block actually resolves (not an unstyled fallback).
  const brand = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-brand").trim(),
  );
  expect(brand.toLowerCase()).toBe("#6f9438");
  // And it survives a reload, like every other theme.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "matcha");
});

// #82 — a single tile in the queue would match every filter value on offer, so
// the narrowing is only meaningful with TWO stacks carrying different stains.
test("#82: the Ready for Imaging stain filter actually narrows the queue", async ({ page }) => {
  await signInAndProject(page);

  // Sample 1 → Alcian Blue, all the way to Ready for Imaging.
  await addSample(page, "imaging block one");
  await embed(page, "EE-1", "Batch 1");
  await cutAndSectionIntoStaining(page, "EE-1", 1);
  await runProtocolOnLoneRack(page);

  const imaging = col(page, "Ready for Imaging");
  const tiles = imaging.locator("div[aria-selected]");
  await expect(tiles).toHaveCount(1, { timeout: 15000 });

  // Sample 2 → a DIFFERENT stain AND a different project, so BOTH filters have
  // something real to narrow. Keeping both samples in one project made the
  // project-filter assertion below vacuous: the filtered count equalled the
  // unfiltered one, so it would have passed with the filter disabled.
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill("ZZ");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Zebrafish Study");
  await page.getByRole("button", { name: "Save Project" }).click();

  await addSample(page, "imaging block two");
  await embed(page, "ZZ-1", "Batch 2");
  await cutAndSectionIntoStaining(page, "ZZ-1", 2);
  await runProtocolOnLoneRack(page);
  await expect(tiles).toHaveCount(2, { timeout: 15000 });

  const projectFilter = page.getByLabel("Filter imaging by project");
  const stainFilter = page.getByLabel("Filter imaging by stain");
  await expect(projectFilter).toBeVisible();
  await expect(stainFilter).toBeVisible();

  // Two distinct stains are on offer, and picking one hides the other sample.
  const stainOptions = await stainFilter.locator("option").allTextContents();
  expect(stainOptions).toContain("Alcian Blue");
  expect(stainOptions.length).toBeGreaterThan(2); // "All Stains" + at least two agents

  await stainFilter.selectOption("Alcian Blue");
  await expect(tiles).toHaveCount(1);
  await expect(imaging.getByText("EE-1").first()).toBeVisible();
  await expect(imaging.getByText("ZZ-1")).toHaveCount(0);

  // Clearing the filter brings the other sample back.
  await stainFilter.selectOption("all");
  await expect(tiles).toHaveCount(2);

  // The project filter genuinely narrows: two projects in the queue, pick one.
  await projectFilter.selectOption("ZZ");
  await expect(tiles).toHaveCount(1);
  await expect(imaging.getByText("ZZ-1").first()).toBeVisible();
  await expect(imaging.getByText("EE-1")).toHaveCount(0);

  await projectFilter.selectOption("all");
  await expect(tiles).toHaveCount(2);
});

test("#79: a sample description can be corrected from the drawer", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "typo in teh description");
  await expect(page.getByText("EE-1")).toBeVisible();

  await page.getByText("EE-1", { exact: true }).first().click();
  // The pencil only exists once the drawer is open, so it doubles as the wait.
  await page.getByLabel("Edit description").click();
  const field = page.getByLabel("Sample description");
  await expect(field).toHaveValue("typo in teh description");

  await field.fill("corrected description");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText("corrected description").first()).toBeVisible();
  await expect(page.getByText("typo in teh description")).toHaveCount(0);

  // The edit is undoable like every other mutation.
  await page.getByTitle("Undo (Ctrl+Z)").click({ force: true });
  await expect(page.getByText("typo in teh description").first()).toBeVisible({ timeout: 15000 });
});

test("#70: the request dialog refuses an exhausted block", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "spent block");
  await embed(page, "EE-1", "Batch 1");

  // Mark the block exhausted (a native confirm guards it). It then leaves
  // Embedded Inventory, which is why the request dialog — not the board drawer —
  // is the path a user actually reaches it by.
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Mark Exhausted/ }).click();
  await expect(page.locator("aside").getByText("EE-1")).toHaveCount(0, { timeout: 15000 });

  // On the workstation the request dialog is reached from the Logs view (#64).
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();
  await page.getByRole("button", { name: /Request stain for EE-1/ }).click();
  await expect(page.getByRole("heading", { name: "Request a stain" })).toBeVisible();

  const sampleSelect = page.getByLabel("Sample");
  await expect(sampleSelect.locator("option", { hasText: "EE-1 — exhausted" })).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText(/exhausted/i);

  await page.getByLabel("Requested stain / IHC").selectOption({ index: 1 });
  await page.getByRole("button", { name: /Send request/ }).click();
  // Refused: the dialog stays open and explains why.
  await expect(page.getByRole("heading", { name: "Request a stain" })).toBeVisible();
  await expect(page.getByText(/cannot be cut again/i).first()).toBeVisible();
});

// #75 — the ordering only goes wrong once a sample has MORE THAN ONE cut group.
// slides.slide_ordinal is a per-SECTION counter that restarts at 1, while
// slide_code is issued from a per-SAMPLE counter; listAllSlides orders by
// slide_ordinal with no tie-break, so a second cut group interleaves its slides
// (A, E, B, F, …). A single-cut sample can never show the bug.
test("#75: slides stay alphabetical in Logs across two cut groups", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "logs block");
  await embed(page, "EE-1", "Batch 1");

  // First cut → slides A–D.
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();

  // Second cut on the same block → slides E onward, ordinals restarting at 1.
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();

  const codes = await page.locator("text=/^EE-1-[A-Z]+$/").allTextContents();
  // Both cut groups must be present, or the interleaving can't occur.
  expect(codes.length).toBeGreaterThan(4);
  expect(codes).toContain("EE-1-E");

  const suffix = (c: string) => c.split("-").pop() ?? "";
  const expected = [...codes].sort(
    (a, b) => suffix(a).length - suffix(b).length || suffix(a).localeCompare(suffix(b)),
  );
  expect(codes).toEqual(expected);
});
