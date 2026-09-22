import { test, expect, type Page } from "../helpers/test";
import { openManage } from "../helpers/app";

/**
 * Undo against saves that are still being written, as a user meets it.
 *
 * Every undoable save used to begin by copying the whole database across the IPC
 * boundary as a JSON integer array, which on a lab-sized database takes seconds;
 * undo copied it again and then overwrote the file with an older copy. The shim
 * used to answer those copies at once, so no spec ever saw the window. Here the
 * shim is given the measured cost (window.__SNAPSHOT_IPC_MS__: 1.7 s, a 23 MB lab),
 * and the user's own gestures are replayed with nothing in between: no wait
 * before the Undo click, because a wait there stops the spec reproducing the race
 * at all. Undo no longer copies the file (the undo journal), so these pass by
 * construction on the fixed build and fail on the old one for the reason each
 * test names.
 *
 * Every assertion is on what the user sees or what the database holds.
 */

const IPC_MS = 1700;

type Stored = { description: string; cut: string };

async function stored(page: Page): Promise<Stored> {
  return await page.evaluate(
    () =>
      (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }).__SHIM_SELECT__(
        `SELECT sample_description AS description, cut_notes AS cut FROM samples WHERE sample_code = 'EE-0001'`,
      )[0] as Stored,
  );
}

/** A signed-in lab with one block, EE-1, described "DESC-0" with cut note "CUT-0", open in the Logs. */
async function labWithOneBlock(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({ timeout: 20_000 });
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("DESC-0");
  await page.getByLabel("Sectioning / Cut Notes").fill("CUT-0");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-1")).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();
  await expect(page.getByText("Sample timeline")).toBeVisible();
  await expect.poll(() => stored(page)).toEqual({ description: "DESC-0", cut: "CUT-0" });
  // From here on, the database costs what a lab-sized one does to copy.
  await page.evaluate((ms) => ((window as unknown as { __SNAPSHOT_IPC_MS__: number }).__SNAPSHOT_IPC_MS__ = ms), IPC_MS);
}

const cutBox = (page: Page) => page.getByLabel("Sectioning / Cut Notes for EE-1", { exact: true });
const descriptionBox = (page: Page) => page.getByLabel("Description for EE-1", { exact: true });
const undoButton = (page: Page) => page.getByTitle("Undo (Ctrl+Z)");

test("undo pressed while typing undoes the edit being typed, not the one before it", async ({ page }) => {
  await labWithOneBlock(page);

  // Edit 1: correct the cut note, and let it land.
  await page.getByLabel("Edit Sectioning / Cut Notes for EE-1", { exact: true }).click();
  await cutBox(page).fill("CUT-A");
  await cutBox(page).blur();
  await expect.poll(() => stored(page), { timeout: 15_000 }).toEqual({ description: "DESC-0", cut: "CUT-A" });

  // Edit 2: retype the description and, still in the box, press the toolbar Undo.
  // The mousedown blurs the box, which starts the save; the click then asks for Undo.
  await descriptionBox(page).click();
  await descriptionBox(page).fill("DESC-B");
  await undoButton(page).click();

  // The user pressed Undo to cancel the description edit. Edit 1 must survive it.
  await expect(page.getByText("Undone: Edit EE-1 description")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => stored(page), { timeout: 15_000 }).toEqual({ description: "DESC-0", cut: "CUT-A" });
  // ...and stay that way once every write in flight has landed.
  await page.waitForTimeout(3 * IPC_MS);
  expect(await stored(page)).toEqual({ description: "DESC-0", cut: "CUT-A" });
});

test("two edits saved close together are undone one at a time", async ({ page }) => {
  await labWithOneBlock(page);

  // Edit 1 and edit 2 in one motion: correct the cut note, go straight to the
  // description (which blurs the note and saves it), retype it, click away.
  await page.getByLabel("Edit Sectioning / Cut Notes for EE-1", { exact: true }).click();
  await cutBox(page).fill("CUT-A");
  await descriptionBox(page).click();
  await descriptionBox(page).fill("DESC-B");
  await page.getByText("Sample timeline").click();
  await expect.poll(() => stored(page), { timeout: 15_000 }).toEqual({ description: "DESC-B", cut: "CUT-A" });
  await page.waitForTimeout(3 * IPC_MS); // both saves fully recorded before anyone presses Undo

  // One Undo takes back the description only.
  await undoButton(page).click();
  await expect(page.getByText("Undone: Edit EE-1 description")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => stored(page), { timeout: 15_000 }).toEqual({ description: "DESC-0", cut: "CUT-A" });

  // The next Undo takes back the cut note.
  await undoButton(page).click();
  await expect(page.getByText("Undone: Edit EE-1 sectioning / cut notes")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => stored(page), { timeout: 15_000 }).toEqual({ description: "DESC-0", cut: "CUT-0" });
});

test("a plain undo, with nothing else in flight, reverts the edit", async ({ page }) => {
  await labWithOneBlock(page);
  await page.getByLabel("Edit Sectioning / Cut Notes for EE-1", { exact: true }).click();
  await cutBox(page).fill("CUT-A");
  await cutBox(page).blur();
  await expect.poll(() => stored(page), { timeout: 15_000 }).toEqual({ description: "DESC-0", cut: "CUT-A" });
  await page.waitForTimeout(3 * IPC_MS); // the save and everything it set off have finished

  await undoButton(page).click();
  await expect(page.getByText("Undone: Edit EE-1 sectioning / cut notes")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => stored(page), { timeout: 15_000 }).toEqual({ description: "DESC-0", cut: "CUT-0" });
  await page.waitForTimeout(3 * IPC_MS);
  expect(await stored(page)).toEqual({ description: "DESC-0", cut: "CUT-0" });
});
