import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { settleAfterDrop } from "../helpers/drag";

/**
 * The board/logs housekeeping round: #102 imaging tiles, #103 Needs Embedding
 * filters, #104 filter persistence, #105 Show removed, #106 project rename,
 * #107 timestamp sorting, #108 the sign-in prompt after a manual sign-out.
 */

async function signIn(page: Page) {
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
}

async function addProject(page: Page, code: string, name: string) {
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill(code);
  await page.locator('input[placeholder="Enthesis Engineering"]').fill(name);
  await page.getByRole("button", { name: "Save Project" }).click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toHaveCount(0);
}

async function signInAndProject(page: Page) {
  await signIn(page);
  await addProject(page, "EE", "Enthesis Engineering");
}

async function addSample(page: Page, description: string) {
  await page.getByRole("button", { name: "New Sample" }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toBeVisible();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(description);
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toHaveCount(0);
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

/** Preprocessing only — enough to reach the Processor. */
async function preprocess(page: Page, code: string) {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
}

/** Run a block through the processor and stop in Needs Embedding. */
async function toNeedsEmbedding(page: Page, code: string, batchLabel: string) {
  await preprocess(page, code);
  await dragOnto(page, code, "Processor");
  await expect(page.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText(batchLabel, { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await dragOnto(page, batchLabel, "Needs Embedding");
}

/** A board column, by its heading. */
function column(page: Page, title: string) {
  return page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

// ---------------------------------------------------------------------------
// #103 — the Needs Embedding column gets the filter + sort every other busy
// column has.
// ---------------------------------------------------------------------------
test("#103: Needs Embedding can be filtered by project and sorted", async ({ page }) => {
  await signInAndProject(page);
  await addProject(page, "ZZ", "Zebrafish Zone");

  // One block from each project, both parked in Needs Embedding.
  await page.locator("aside").first().getByRole("button", { name: /Enthesis/ }).click();
  await addSample(page, "enthesis block");
  await toNeedsEmbedding(page, "EE-1", "Batch 1");
  await page.locator("aside").first().getByRole("button", { name: /Zebrafish/ }).click();
  await addSample(page, "zebrafish block");
  await toNeedsEmbedding(page, "ZZ-1", "Batch 2");

  const col = column(page, "Needs Embedding");
  await expect(col.getByText("EE-1", { exact: true })).toBeVisible();
  await expect(col.getByText("ZZ-1", { exact: true })).toBeVisible();

  // Filter to one project; the other block leaves the column.
  const filter = page.getByLabel("Filter needs embedding by project");
  await expect(filter).toBeVisible();
  await filter.selectOption({ label: "EE" });
  await expect(col.getByText("EE-1", { exact: true })).toBeVisible();
  await expect(col.getByText("ZZ-1", { exact: true })).toHaveCount(0);

  // And the sort control is real, not decorative.
  const sort = page.getByLabel("Sort needs embedding");
  await expect(sort).toBeVisible();
  await sort.selectOption("name");
  await expect(col.getByText("EE-1", { exact: true })).toBeVisible();
});

// ---------------------------------------------------------------------------
// #104 — filters survive moving between the Board and the Logs, and are dropped
// when the user signs out.
// ---------------------------------------------------------------------------
test("#104: filters survive a view switch and reset on sign-out", async ({ page }) => {
  await signInAndProject(page);
  await addProject(page, "ZZ", "Zebrafish Zone");
  await page.locator("aside").first().getByRole("button", { name: /Enthesis/ }).click();
  await addSample(page, "enthesis block");
  await toNeedsEmbedding(page, "EE-1", "Batch 1");

  await page.getByLabel("Filter needs embedding by project").selectOption({ label: "EE" });

  // Board → Logs → Board. The filter used to reset to All Projects, because the
  // Board unmounts and its useState went with it.
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  const showArchived = page.getByLabel("Show archived");
  await showArchived.check();
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  await expect(page.getByLabel("Filter needs embedding by project")).toHaveValue(/^\d+$/);

  // …and the Logs filter survived the round trip too.
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await expect(page.getByLabel("Show archived")).toBeChecked();

  // Signing out drops them: the next person at this machine gets a clean board.
  await page.getByRole("button", { name: "Sign out" }).click();
  // Dismiss the sign-in prompt (#108) — it is modal and would swallow the nav
  // clicks below.
  await page.getByRole("button", { name: "Keep reading" }).click();
  await expect(page.getByLabel("Show archived")).not.toBeChecked();
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  await expect(page.getByLabel("Filter needs embedding by project")).toHaveValue("all");
});

// ---------------------------------------------------------------------------
// #108 — signing out by hand offers the way back in, like the idle and launch
// sign-outs already did.
// ---------------------------------------------------------------------------
test("#108: signing out by hand offers the sign-in dialogue", async ({ page }) => {
  await signInAndProject(page);

  await page.getByRole("button", { name: "Sign out" }).click();
  const dialog = page.getByRole("dialog", { name: "Signed out" });
  await expect(dialog).toBeVisible();
  // Not the inactivity story — that copy was hard-coded and untrue here.
  await expect(dialog).toContainText("Alex Rivera signed out.");
  await expect(dialog).not.toContainText("without activity");

  // And it signs you back in.
  await dialog.getByLabel("Sign back in").selectOption({ label: "Alex Rivera" });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Signed-in user")).toHaveValue(/^\d+$/);
});

// ---------------------------------------------------------------------------
// #106 — renaming a project's acronym has to reach everything named after it.
// ---------------------------------------------------------------------------
test("#106: renaming a project renames its samples and slides", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await signInAndProject(page);
  await addSample(page, "renamed block");
  await expect(page.getByText("EE-1", { exact: true }).first()).toBeVisible();

  // Rename EE → EN in the management tab.
  await openManage(page);
  // Scoped to the dialog: the sidebar carries a "Collapse projects" button that
  // a loose name match also hits.
  const manage = page.getByRole("dialog", { name: /Manage/ });
  await manage.getByRole("button", { name: "Projects", exact: true }).click();
  await manage.getByTitle("Edit").first().click();
  await manage.locator('input[value="EE"]').first().fill("EN");
  await manage.getByRole("button", { name: "Save", exact: true }).click();
  await page.keyboard.press("Escape");

  // The board and the log both answer to the new acronym, and to nothing else.
  await expect(page.getByText("EN-1", { exact: true }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("EE-1", { exact: true })).toHaveCount(0);
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await expect(page.getByRole("cell", { name: "EN-1", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// #105 — removed blocks are in the record but not in the way.
// ---------------------------------------------------------------------------
test("#105: Show removed reveals a deleted block in the Logs", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "removed block");
  await addSample(page, "kept block");

  // Delete EE-1 from the board, with a reason (#96).
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: "Delete EE-1" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove this block" });
  await dialog.getByLabel("Reason for removal").fill("logged in error");
  await dialog.getByRole("button", { name: "Remove block" }).click();
  await expect(page.getByText("EE-1", { exact: true })).toHaveCount(0, { timeout: 15000 });

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  // Hidden by default now — the log stays readable.
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "EE-2", exact: true })).toBeVisible();

  // One click brings it back, flagged, with its reason.
  await page.getByLabel("Show removed").check();
  const row = page.getByRole("cell", { name: "EE-1", exact: true });
  await expect(row).toBeVisible();
  await expect(page.getByText("Removed", { exact: true }).first()).toBeVisible();
  await row.click();
  await expect(page.getByText("logged in error")).toBeVisible();
});

// ---------------------------------------------------------------------------
// #107 — Added sorted on `date_added`, which is a DAY, so everything logged on
// the same day tied and the order looked arbitrary.
// ---------------------------------------------------------------------------
test("#107: Added sorts by time, not just by day", async ({ page }) => {
  await signInAndProject(page);
  for (const description of ["first in", "second in", "third in"]) {
    await addSample(page, description);
  }

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  // All three were logged today, so a day-granular sort cannot order them.
  const addedHeader = page.getByRole("columnheader", { name: "Added" });
  await addedHeader.click(); // ascending
  await expect
    .poll(() => page.getByRole("cell", { name: /^EE-\d+$/ }).allTextContents())
    .toEqual(["EE-1", "EE-2", "EE-3"]);
  await addedHeader.click(); // descending
  await expect
    .poll(() => page.getByRole("cell", { name: /^EE-\d+$/ }).allTextContents())
    .toEqual(["EE-3", "EE-2", "EE-1"]);
  // The tooltip carries the time the sort actually used.
  // Column 8 (after the chevron) is Added — named by position rather than by
  // "the last cell with a title", which is Updated.
  const title = await page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "EE-1", exact: true }) })
    .locator("td")
    .nth(8)
    .getAttribute("title");
  expect(title ?? "").toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
});

// ---------------------------------------------------------------------------
// #102 — a Ready-for-Imaging tile that says only "EE-4" means nothing to
// somebody reading the board from across the bench.
// ---------------------------------------------------------------------------
test("#102: imaging tiles carry the description and the agents", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "left femur 8wk");

  // Take the block to Embedded Inventory, then cut it with one agent assigned.
  await toNeedsEmbedding(page, "EE-1", "Batch 1");
  await dragOnto(page, "EE-1", "Embedded Inventory");
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: "Send for Cutting" }).click();
  const assay = page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: "Extra (no stain)" }) })
    .first();
  await assay.selectOption({ index: 1 });
  const agentName = (await assay.locator("option:checked").textContent())?.trim() ?? "";
  expect(agentName).not.toBe("");
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();

  // Section it, which splits the agent slide into a rack…
  await page.getByText("3 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  const drawerClose = page.locator("button:has(svg.lucide-x)").first();
  if (await drawerClose.isVisible().catch(() => false)) {
    await drawerClose.click().catch(() => undefined);
  }

  // …then run the protocol, which is what actually scatters the rack into
  // Ready for Imaging (dragging it there does not).
  const staining = column(page, "Staining / IHC");
  await expect(staining.getByText(agentName).first()).toBeVisible({ timeout: 15000 });
  await staining.getByText(agentName).first().click();
  for (const step of ["Stained", "Coverslipped"]) {
    await page.getByRole("button", { name: step, exact: true }).click();
  }

  const imaging = column(page, "Ready for Imaging");
  await expect(imaging.getByText("EE-1", { exact: true })).toBeVisible({ timeout: 15000 });
  // The tile carries the block's ID, its description beside it, and what needs
  // imaging below. Asserted on the tile itself, not the column, so a stray
  // match elsewhere cannot pass this.
  const tile = imaging.locator("div.cursor-grab").filter({ hasText: "EE-1" }).first();
  await expect(tile).toContainText("left femur 8wk");
  await expect(tile).toContainText(agentName);
});
