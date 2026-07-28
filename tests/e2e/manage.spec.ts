import { test, expect, type Page } from "@playwright/test";

// The tabbed Manage dialog: users (implicitly covered by every seed helper),
// projects, and the stain/IHC catalog.
async function seed(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
}

test("Manage → Projects: rename and delete", async ({ page }) => {
  await seed(page);
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  // Scope to the dialog's own row format ("<code> · <name>"): the bare name
  // also renders in the sidebar project list, so an unscoped getByText is
  // ambiguous once that list has loaded.
  await expect(page.getByText("EE · Enthesis Engineering")).toBeVisible();

  // Rename it (the new name shows in both the dialog and the sidebar).
  await page.getByTitle("Edit").first().click();
  // Address the field by its label rather than a textbox index — the index
  // silently drifts when the panel gains an input, and a wrong guess here
  // renames the Code instead, which still "passes" a loose text assertion.
  await page.getByLabel("Name", { exact: true }).fill("Renamed Lab");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("EE · Renamed Lab")).toBeVisible();

  // Delete it (no samples → allowed).
  await page.getByTitle("Delete project").click();
  await expect(page.getByText("Renamed Lab")).toHaveCount(0);
});

test("Manage → Stains: add, deactivate/reactivate, and delete a catalog agent", async ({ page }) => {
  await seed(page);
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByRole("button", { name: "Stains & IHC" }).click();
  // Seeded agents are present.
  await expect(page.getByText("H&E")).toBeVisible();

  // Add a custom agent.
  await page.getByPlaceholder("H&E").fill("ZZZ Custom Stain");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("ZZZ Custom Stain")).toBeVisible();

  // Deactivate then reactivate it (row shows the inactive marker in between).
  const row = () => page.locator("div.rounded-lg").filter({ hasText: "ZZZ Custom Stain" });
  await row().getByRole("button", { name: "Deactivate" }).click();
  await expect(row().getByText(/inactive/)).toBeVisible();
  await row().getByRole("button", { name: "Reactivate" }).click();

  // Delete it (unused → allowed).
  await row().getByTitle("Delete agent").click();
  await expect(page.getByText("ZZZ Custom Stain")).toHaveCount(0);
});
