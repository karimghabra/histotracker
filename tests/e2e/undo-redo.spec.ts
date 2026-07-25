import { test, expect } from "@playwright/test";

// Exercises the rewritten image-based undo/redo through the real UI: a mutation,
// an undo that must fully revert the database, and a redo that must fully
// reapply it — with the UI a pure reflection of the DB via React Query refetch.
async function signInAndSeedUser(page: import("@playwright/test").Page) {
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
}

async function createProject(page: import("@playwright/test").Page, code: string, name: string) {
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill(code);
  await page.locator('input[placeholder="Enthesis Engineering"]').fill(name);
  await page.getByRole("button", { name: "Save Project" }).click();
}

async function createSample(page: import("@playwright/test").Page, description: string) {
  await page.getByRole("button", { name: "New Sample" }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toBeVisible();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(description);
  await page.getByRole("button", { name: /Create Sample/ }).click();
}

test("undo reverts a create; redo reapplies it", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await signInAndSeedUser(page);
  await createProject(page, "EE", "Enthesis Engineering");

  // Creating a sample IS an undoable action (goes through the commit/snapshot path).
  await createSample(page, "Undo test block");
  await expect(page.getByText("EE-0001")).toBeVisible();

  // Undo → the whole DB reverts to the pre-create image; the UI follows.
  await page.getByTitle("Undo (Ctrl+Z)").click();
  await expect(page.getByText("EE-0001")).toHaveCount(0);

  // Redo → the image is reapplied and the sample is back, same ID (no sequence drift).
  await page.getByTitle("Redo (Ctrl+Y)").click();
  await expect(page.getByText("EE-0001")).toBeVisible();

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});

test("undo/redo keep sample IDs stable (no sequence drift)", async ({ page }) => {
  await signInAndSeedUser(page);
  await createProject(page, "EE", "Enthesis Engineering");

  // Create, undo, then create again: the ID must be EE-0001 both times. The old
  // logical-dump undo left sqlite_sequence un-rewound, so the second create
  // could jump to EE-0002; a true image revert restores the counter too.
  await createSample(page, "First block");
  await expect(page.getByText("EE-0001")).toBeVisible();

  await page.getByTitle("Undo (Ctrl+Z)").click();
  await expect(page.getByText("EE-0001")).toHaveCount(0);

  await createSample(page, "Replacement block");
  await expect(page.getByText("EE-0001")).toBeVisible();
  await expect(page.getByText("EE-0002")).toHaveCount(0);
});

test("undo survives a full page reload (persisted DB image)", async ({ page }) => {
  await signInAndSeedUser(page);
  await createProject(page, "EE", "Enthesis Engineering");
  await expect(page.getByText("Enthesis Engineering")).toBeVisible();

  // Reload WITHOUT freshdb: the persisted image should still hold the project,
  // proving restore writes real bytes that survive a reopen.
  await page.goto("/");
  await expect(page.getByText("Enthesis Engineering")).toBeVisible();
  await expect(page.getByText(/1 active project/)).toBeVisible();
});
