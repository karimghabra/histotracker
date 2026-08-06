import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { settleAfterDrop } from "../helpers/drag";

// The 0.7.1 wave: #85 (sticky Ready-for-Imaging filter) and the #79 follow-up
// (description editing was shipped but nobody could find it).

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
  }).toPass({ timeout: 20000 });
  await dragOnto(page, batchLabel, "Needs Embedding");
  await dragOnto(page, code, "Embedded Inventory");
}

async function cutAndSection(page: Page, code: string, stainIndex = 1) {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Extra (no stain)" }) })
    .first()
    .selectOption({ index: stainIndex });
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await page.getByText("3 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
}

const col = (page: Page, title: string) =>
  page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });

async function runProtocolOnLoneRack(page: Page) {
  const staining = col(page, "Staining / IHC");
  await staining.locator("div[aria-selected]").first().click();
  await page.getByLabel("Active operator").fill("Alex");
  for (const step of ["Stained", "Coverslipped"]) {
    await page.getByRole("button", { name: step, exact: true }).click();
  }
}

// #85 — the reporter's exact sequence. Two projects reach Ready for Imaging,
// the filter is set to one of them, and that one is then marked Analyzed. The
// filtered project leaves the option list, so the <select> silently starts
// showing "All Projects" — and before the fix, React state still filtered to the
// departed project, leaving the column empty even though the other project's
// stack was sitting right there.
test("#85: analyzing the last stack of a filtered project does not empty the queue", async ({
  page,
}) => {
  await signInAndProject(page);

  // A second project, so "All Projects" is a meaningful state.
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill("ZZ");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Zebrafish Study");
  await page.getByRole("button", { name: "Save Project" }).click();

  // Sample in ZZ → Ready for Imaging. Creating a project does not select it, so
  // pick it explicitly or the sample lands in EE.
  await page.locator("aside").getByText("Zebrafish Study").click();
  await expect(page.locator('aside button[aria-current="true"]')).toContainText("Zebrafish Study");
  await addSample(page, "zz block");
  await embed(page, "ZZ-1", "Batch 1");
  await cutAndSection(page, "ZZ-1");
  await runProtocolOnLoneRack(page);

  const imaging = col(page, "Ready for Imaging");
  const tiles = imaging.locator("div[aria-selected]");
  await expect(tiles).toHaveCount(1, { timeout: 20000 });

  // Sample in EE → Ready for Imaging as well.
  await page.locator("aside").getByText("Enthesis Engineering").click();
  await addSample(page, "ee block");
  await embed(page, "EE-1", "Batch 2");
  await cutAndSection(page, "EE-1");
  await runProtocolOnLoneRack(page);
  await expect(tiles).toHaveCount(2, { timeout: 20000 });

  // Filter to EE, then analyze EE's only stack.
  const projectFilter = page.getByLabel("Filter imaging by project");
  await projectFilter.selectOption("EE");
  await expect(tiles).toHaveCount(1);
  await tiles.first().click();
  // Ready for Imaging → Complete Imaging (pictures taken) → Mark Analyzed, which
  // is what finally removes the stack from this queue.
  await page.getByRole("button", { name: /Complete Imaging/ }).click();
  await page.getByRole("button", { name: /Mark Analyzed/ }).click();

  // EE is gone from the queue, so the filter must fall back to All Projects FOR
  // REAL — ZZ's stack has to still be visible.
  await expect(projectFilter).toHaveValue("all", { timeout: 20000 });
  await expect(tiles).toHaveCount(1);
  await expect(imaging.getByText("ZZ-1").first()).toBeVisible();
});

// #79 follow-up — the feature existed but was a 12px faint pencil next to a
// label, and the user could not find it. It must now be reachable from the Logs
// view (where notes are already edited) and read as a field in the drawer.
test("#79: descriptions are editable from the Logs view, like notes", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "typo in teh description");
  await expect(page.getByText("EE-1")).toBeVisible();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();

  // An always-visible field, not a hidden affordance.
  const field = page.getByLabel("Description for EE-1");
  await expect(field).toBeVisible();
  await expect(field).toHaveValue("typo in teh description");

  await field.fill("corrected from the log");
  await field.blur(); // saves on blur, exactly like the notes editor
  await expect(page.getByText("corrected from the log").first()).toBeVisible({ timeout: 15000 });

  // And it persisted, rather than just living in the input. Navigate to "/" —
  // reload() would keep ?freshdb=1 in the URL and wipe the database.
  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();
  await expect(page.getByLabel("Description for EE-1")).toHaveValue("corrected from the log");
});

test("#79: the drawer description reads as an editable field", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "drawer description");
  await page.getByText("EE-1", { exact: true }).first().click();

  // The control carries a visible "Edit" label, not just an icon.
  const control = page.getByRole("button", { name: "Edit description" });
  await expect(control).toBeVisible();
  await expect(control).toContainText("Edit");
  await expect(control).toContainText("drawer description");

  await control.click();
  const field = page.getByLabel("Sample description");
  await field.fill("edited in the drawer");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("edited in the drawer").first()).toBeVisible();
});
