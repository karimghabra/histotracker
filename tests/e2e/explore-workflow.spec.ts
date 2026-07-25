import { test, expect } from "@playwright/test";

// A real drive-through of the write path: add a lab user, sign in, create a
// project. Exercises INSERTs, lastInsertId, and React Query refetch through the
// sql.js shim — the things a type-check or a mocked test can't catch.
test("add user, sign in, create a project", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();

  // --- Add a lab user ---
  await page.getByTitle("Manage lab users").click();
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByLabel("Signed-in user").locator("option", { hasText: "Alex Rivera" }),
  ).toHaveCount(1);
  await page.screenshot({ path: "test-results/step1-user-added.png" });
  await page.keyboard.press("Escape");

  // --- Sign in as that user ---
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });

  // --- Create a project ---
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();

  // Project should now appear in the sidebar and the header count updates.
  await expect(page.getByText("Enthesis Engineering")).toBeVisible();
  await expect(page.getByText(/1 active project/)).toBeVisible();
  await page.screenshot({ path: "test-results/step2-project-created.png", fullPage: true });

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
