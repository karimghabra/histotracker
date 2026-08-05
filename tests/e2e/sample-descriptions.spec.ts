import { test, expect, type Page } from "@playwright/test";

/**
 * #88 — every sample must have a description.
 * #86 — per-sample descriptions are the primary input, not a checkbox option,
 *       and the paste shortcut belongs below the list it fills.
 */

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

// #88 — the single-sample case. The Description field used to be optional, so
// clicking straight through Create produced a permanently anonymous block.
test("#88: a single sample cannot be created without a description", async ({ page }) => {
  await signInAndProject(page);
  await page.getByRole("button", { name: "New Sample" }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toBeVisible();

  const create = page.getByRole("button", { name: "Create Sample" });
  await expect(create).toBeDisabled();
  await expect(page.getByText("EE-1 needs a description.")).toBeVisible();

  // Whitespace is not a description.
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("   ");
  await expect(create).toBeDisabled();

  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("2 week Stretch PLA");
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByText("EE-1", { exact: true }).first()).toBeVisible();
});

// #86/#88 — the batch case, which is where the "same as above" default failed:
// a blank row inherited a blank shared field, so the sample was created with
// nothing at all.
test("#86/#88: a batch shows a row per sample and blocks Create until each is filled", async ({
  page,
}) => {
  await signInAndProject(page);
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByLabel("Quantity").fill("3");

  // The rows appear with NO checkbox to tick — they are the primary input (#86).
  await expect(page.getByRole("checkbox", { name: /own description/i })).toHaveCount(0);
  for (const code of ["EE-1", "EE-2", "EE-3"]) {
    await expect(page.getByLabel(`Description for ${code}`)).toBeVisible();
  }
  // The shared field is explicitly optional now.
  await expect(page.getByText("Shared description (optional)")).toBeVisible();

  // Create is blocked, and the message NAMES the samples that are blank.
  const create = page.getByRole("button", { name: "Create 3 Samples" });
  await expect(create).toBeDisabled();
  await expect(page.getByText(/3 samples need a description: EE-1, EE-2, EE-3/)).toBeVisible();

  // Filling two rows leaves exactly one named.
  await page.getByLabel("Description for EE-1").fill("proximal");
  await page.getByLabel("Description for EE-2").fill("mid");
  await expect(create).toBeDisabled();
  await expect(page.getByText("EE-3 needs a description.")).toBeVisible();

  // The shared field satisfies the remaining blank row — the fallback works,
  // it just can no longer resolve to nothing.
  await page.getByPlaceholder("Used for any sample below you leave blank").fill("distal");
  await expect(create).toBeEnabled();
  await create.click();

  // Each sample carries its own description, and the blank row took the shared one.
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  for (const [code, description] of [
    ["EE-1", "proximal"],
    ["EE-2", "mid"],
    ["EE-3", "distal"],
  ]) {
    const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: code, exact: true }) });
    await expect(row.getByRole("cell", { name: description, exact: true })).toBeVisible();
  }
});

// #86 — the paste shortcut must sit BELOW the list it fills. It used to be the
// first thing in the section, which made the shortcut look like the main event
// and the per-sample rows look like its output.
test("#86: the paste box sits below the per-sample rows", async ({ page }) => {
  await signInAndProject(page);
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByLabel("Quantity").fill("3");

  const firstRow = page.getByLabel("Description for EE-1");
  const paste = page.getByLabel("Paste one description per line");
  const rowBox = await firstRow.boundingBox();
  const pasteBox = await paste.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(pasteBox).not.toBeNull();
  expect(pasteBox!.y).toBeGreaterThan(rowBox!.y);

  // And it still fills the rows positionally, including across a blank line —
  // the case that used to shift every description down by one in silence.
  await paste.fill("proximal\n\ndistal");
  await expect(firstRow).toHaveValue("proximal");
  await expect(page.getByLabel("Description for EE-2")).toHaveValue("");
  await expect(page.getByLabel("Description for EE-3")).toHaveValue("distal");

  // The blank middle row is caught rather than silently created empty (#88).
  await expect(page.getByRole("button", { name: "Create 3 Samples" })).toBeDisabled();
  await expect(page.getByText("EE-2 needs a description.")).toBeVisible();
});
