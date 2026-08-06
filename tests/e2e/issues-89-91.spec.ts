import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { settleAfterDrop } from "../helpers/drag";

/**
 * #91 — a processor run already under way must be editable.
 * #89 — Pre-processing needs the project filter and sort the other queues have.
 */

async function signInAndProject(page: Page, code = "EE", name = "Enthesis Engineering") {
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
  await addProject(page, code, name);
}

async function addProject(page: Page, code: string, name: string) {
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

/** Walk a sample through the pre-processing checklist so it can enter a run. */
async function completePreprocessing(page: Page, code: string) {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
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

// #91 — the whole point of the issue: the mistake is noticed after the run has
// started, which is exactly when the old planned-only rule refused to help.
test("#91: a sample can be added to and removed from a RUNNING processor run", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "in the run");
  await addSample(page, "forgotten");
  await completePreprocessing(page, "EE-1");
  await completePreprocessing(page, "EE-2");

  // Start a run with EE-1 only — EE-2 is the one that got missed.
  await dragOnto(page, "EE-1", "Processor");
  await expect(page.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 25000 });

  // Open the running batch. Editing must be offered, not just for planned runs.
  await page.getByText("Batch 1", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Processing Batch 1" })).toBeVisible();
  const add = page.getByRole("button", { name: "Add", exact: true });
  await expect(add).toBeVisible();
  await add.click();

  // The one-timer consequence is stated BEFORE the click, not discovered after.
  await expect(page.getByText(/already under way.*shares its ready time/s)).toBeVisible();

  // Scoped to the drawer: the board also renders a draggable EE-2 card.
  const drawer = page.locator("aside").filter({ hasText: "Processing Batch 1" });
  await drawer.getByRole("button", { name: "EE-2 forgotten", exact: true }).click();

  const preprocessing = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Pre-processing", exact: true }) });

  // EE-2 joined the run: it is in the drawer's member list AND has left the
  // Pre-processing column. The second half is the one that matters — without the
  // stage transition the board would still show it waiting to be loaded while it
  // is physically in the machine.
  await expect(drawer.getByText("EE-2", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(preprocessing.getByText("EE-2", { exact: true })).toHaveCount(0, { timeout: 15000 });

  // Take EE-1 back out — it returns to pre-processing rather than vanishing.
  await drawer.getByRole("button", { name: "Remove EE-1 from this run" }).click();
  // Assert on MEMBERSHIP, not on the text "EE-1" anywhere in the drawer: once
  // EE-1 is back in pre-processing it is eligible again, so it correctly
  // reappears in the drawer's Add-candidate list. Only the member row carries a
  // remove button.
  await expect(drawer.getByRole("button", { name: "Remove EE-1 from this run" })).toHaveCount(0, {
    timeout: 15000,
  });
  await expect(preprocessing.getByText("EE-1", { exact: true })).toBeVisible({ timeout: 15000 });
});

// #91 — the reporter's own note. Editing a run must not become a back door
// around the guard that starting one already enforces.
test("#91: a half-preprocessed sample is not offered for a running run", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "ready to go");
  await addSample(page, "still in fixative");
  await completePreprocessing(page, "EE-1");
  // EE-2 gets only the first step — it is not eligible for the processor.
  await page.getByText("EE-2", { exact: true }).first().click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();

  await dragOnto(page, "EE-1", "Processor");
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 25000 });

  await page.getByText("Batch 1", { exact: true }).click();
  // With no eligible candidate there is nothing to add, so the control is absent
  // rather than offering a sample the data layer would reject.
  await expect(page.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
});

// #89 — Pre-processing is where every sample enters, so it fills up fastest.
test("#89: Pre-processing filters by project and sorts", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "enthesis one");
  await addProject(page, "CART", "Cartilage Repair");
  await addSample(page, "cartilage one");

  const preprocessing = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Pre-processing", exact: true }) });
  await expect(preprocessing.getByText("EE-1", { exact: true })).toBeVisible();
  await expect(preprocessing.getByText("CART-1", { exact: true })).toBeVisible();

  // Filter to one project.
  await page.getByLabel("Filter pre-processing by project").selectOption({ label: "CART" });
  await expect(preprocessing.getByText("EE-1", { exact: true })).toHaveCount(0);
  await expect(preprocessing.getByText("CART-1", { exact: true })).toBeVisible();

  await page.getByLabel("Filter pre-processing by project").selectOption("all");
  await expect(preprocessing.getByText("EE-1", { exact: true })).toBeVisible();

  // The sort control offers a key that means something for this queue: nothing
  // here has been embedded, so "date embedded" would compare NULLs.
  const sort = page.getByLabel("Sort pre-processing");
  await expect(sort.locator("option")).toHaveText(["Date received", "Name", "Sample ID"]);
  await sort.selectOption("sample_id");
  await expect(preprocessing.getByText("CART-1", { exact: true })).toBeVisible();
});

// #89 — the stale-filter trap that produced bug #85: a <select> whose selected
// option disappears keeps reporting the old value and fires no change event, so
// the column silently filters itself down to nothing.
test("#89: the pre-processing filter clears itself when its project empties", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "enthesis one");
  await addProject(page, "CART", "Cartilage Repair");
  await addSample(page, "cartilage one");

  const preprocessing = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Pre-processing", exact: true }) });
  await page.getByLabel("Filter pre-processing by project").selectOption({ label: "CART" });
  await expect(preprocessing.getByText("CART-1", { exact: true })).toBeVisible();

  // Move CART-1 out of pre-processing entirely; CART then has nothing here.
  await completePreprocessing(page, "CART-1");
  await dragOnto(page, "CART-1", "Processor");
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText("Batch 1", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 25000 });

  // The filter must drop back to All Projects rather than hiding EE-1 forever.
  await expect(page.getByLabel("Filter pre-processing by project")).toHaveValue("all", {
    timeout: 15000,
  });
  await expect(preprocessing.getByText("EE-1", { exact: true })).toBeVisible();
});
