import { test, expect, type Page } from "@playwright/test";
import { settleAfterDrop } from "../helpers/drag";

// #73 / #83 (removing slides without recycling their letters) and #74 (archiving
// a sample) driven through the real UI.

async function signInAndProject(page: Page) {
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

async function slideCodesInLogs(page: Page, code: string): Promise<string[]> {
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: code, exact: true }).click();
  const codes = await page.locator(`text=/^${code}-[A-Z]+$/`).allTextContents();
  await page.getByRole("cell", { name: code, exact: true }).click(); // collapse
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  return codes;
}

// #73/#83 — the reporter's rule, end to end: delete C, and the next slide is E.
test("#73/#83: removing an extra does not recycle its slide letter", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await signInAndProject(page);
  await addSample(page, "letters block");
  await embed(page, "EE-1", "Batch 1");
  await cut(page, "EE-1");

  expect(await slideCodesInLogs(page, "EE-1")).toEqual([
    "EE-1-A",
    "EE-1-B",
    "EE-1-C",
    "EE-1-D",
  ]);

  // The cut group has to leave Needs Sectioning before its extras are inventory.
  await page.getByText("4 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  // The drawer may close itself once the group moves on — only close it if it didn't.
  const drawerClose = page.locator("button:has(svg.lucide-x)").first();
  if (await drawerClose.isVisible().catch(() => false)) {
    await drawerClose.click().catch(() => undefined);
  }

  // Open the Extras inventory and remove slide C (#83). Removal now demands a
  // reason and keeps the record — the old flow was a confirm() that deleted.
  const extras = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Extras", exact: true }) });
  await extras.getByText("EE-1").first().click();
  const row = page.locator("label").filter({ hasText: "EE-1-C" });
  await row.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: /Remove 1 slide/ }).click();

  // The dialog must REFUSE to proceed until a reason is given. Scoped to the
  // dialog: the drawer's trigger button carries the same label.
  const dialog = page.getByRole("dialog", { name: "Remove slides from inventory" });
  await expect(dialog).toBeVisible();
  const confirmRemove = dialog.getByRole("button", { name: "Remove 1 slide", exact: true });
  await expect(confirmRemove).toBeDisabled();
  await dialog.getByLabel("Reason for removal").fill("dropped during coverslipping");
  await expect(confirmRemove).toBeEnabled();
  await confirmRemove.click();

  // Gone from the inventory...
  await expect(page.locator("label").filter({ hasText: "EE-1-C" })).toHaveCount(0, {
    timeout: 15000,
  });

  // ...but still in the Logs, flagged, with the reason (#83: nothing is deleted).
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();
  const removedRow = page.locator("div").filter({ hasText: /^EE-1-C/ }).last();
  await expect(removedRow.getByText("Removed", { exact: true })).toBeVisible();
  await removedRow.getByText("EE-1-C", { exact: true }).click();
  await expect(page.getByText("dropped during coverslipping")).toBeVisible();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click(); // collapse
  await page.locator("nav").getByRole("button", { name: "Board" }).click();

  // Cut again — the next slide must be E, and D must not be duplicated.
  await cut(page, "EE-1");
  const after = await slideCodesInLogs(page, "EE-1");
  expect(after).toContain("EE-1-E");
  // C is still listed — it is a removed slide, not an erased one. What must NOT
  // happen is a SECOND C, which is what letter recycling would produce.
  expect(after.filter((c) => c === "EE-1-C")).toHaveLength(1);
  expect(after.filter((c) => c === "EE-1-D")).toHaveLength(1);
  expect(new Set(after).size).toBe(after.length); // no duplicate codes at all
});

// #74 — archiving hides a sample by default, keeps it retrievable, and does not
// renumber anything.
test("#74: a sample can be archived, hidden, and restored", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await signInAndProject(page);
  await addSample(page, "keep me");
  await addSample(page, "archive me");
  await expect(page.getByText("EE-2")).toBeVisible();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-2", exact: true }).click();
  await page.getByRole("button", { name: "Archive EE-2" }).click();

  // Hidden from the log by default, and gone from the board.
  await expect(page.getByRole("cell", { name: "EE-2", exact: true })).toHaveCount(0, {
    timeout: 15000,
  });
  await expect(page.getByRole("cell", { name: "EE-1", exact: true })).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  await expect(page.getByText("EE-2", { exact: true })).toHaveCount(0);
  await expect(page.getByText("EE-1", { exact: true }).first()).toBeVisible();

  // Retrievable: show archived, then restore it.
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByLabel("Show archived").check();
  const archivedRow = page.getByRole("cell", { name: "EE-2", exact: true });
  await expect(archivedRow).toBeVisible();
  await expect(page.getByText("Archived").first()).toBeVisible();

  await archivedRow.click();
  await page.getByRole("button", { name: "Unarchive EE-2" }).click();
  await page.getByLabel("Show archived").uncheck();
  await expect(page.getByRole("cell", { name: "EE-2", exact: true })).toBeVisible({
    timeout: 15000,
  });

  // Restoring did NOT renumber: a new sample is still EE-3.
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  await addSample(page, "next one");
  await expect(page.getByText("EE-3", { exact: true }).first()).toBeVisible();
});
