import { test, expect, type Page } from "@playwright/test";

// Verifies the five fixes from the exploration pass.
async function seed(page: Page, opts: { user?: string } = {}) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByPlaceholder("Alex Rivera").fill(opts.user ?? "Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: opts.user ?? "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
}
async function addSample(page: Page, desc: string) {
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(desc);
  await page.getByRole("button", { name: /Create Sample/ }).click();
}

test("#1: undo preserves the signed-in user and keeps the header in sync", async ({ page }) => {
  await seed(page); // Alex (id 1)
  await addSample(page, "Block");
  await expect(page.getByText("EE-1")).toBeVisible();
  // Switch users, then undo the sample create.
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByPlaceholder("Alex Rivera").fill("Blake Chen");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Blake Chen" }); // id 2
  await page.getByTitle("Undo (Ctrl+Z)").click({ force: true });
  await expect(page.getByText("EE-1")).toHaveCount(0);
  // Header still shows Blake, and it matches the DB (a reload agrees).
  await expect(page.getByLabel("Signed-in user")).toHaveValue("2");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await expect(page.getByLabel("Signed-in user")).toHaveValue("2");
});

test("#2: undo history survives a reload", async ({ page }) => {
  await seed(page);
  await addSample(page, "Persisted");
  await expect(page.getByText("EE-1")).toBeVisible();
  await page.waitForTimeout(900); // let the debounced history persist to IndexedDB
  await page.goto("/"); // reload, keep the DB
  await expect(page.getByText("EE-1")).toBeVisible();
  // Undo is available again and actually reverts the pre-reload action.
  await expect(page.getByTitle("Undo (Ctrl+Z)")).toBeEnabled();
  await page.getByTitle("Undo (Ctrl+Z)").click({ force: true });
  await expect(page.getByText("EE-1")).toHaveCount(0);
});

test("#3: header title stays on one line and New Sample stays in view", async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(150);
  const title = await page.getByRole("heading", { name: "Open Histology Workflow" }).boundingBox();
  const ns = await page.getByRole("button", { name: "New Sample" }).boundingBox();
  expect(title!.height).toBeLessThan(40); // was ~84px (3-4 lines) before the fix
  expect(ns!.x + ns!.width).toBeLessThanOrEqual(1280); // fully within the viewport
});

test("#4: New Sample is disabled when nobody is signed in", async ({ page }) => {
  await seed(page);
  await expect(page.getByRole("button", { name: "New Sample" })).toBeEnabled();
  await page.getByTitle("Sign out").click();
  await expect(page.getByRole("button", { name: "New Sample" })).toBeDisabled();
});

test("#5: Escape closes an open detail drawer", async ({ page }) => {
  await seed(page);
  await addSample(page, "Block");
  await expect(page.getByText("EE-1")).toBeVisible();
  await page.getByText("EE-1", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "EE-1" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "EE-1" })).toHaveCount(0);
});
