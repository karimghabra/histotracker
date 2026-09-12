import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { openBlockDrawer } from "../helpers/stains";

/**
 * "add a correction path. i should be able to edit all notes.. especially in
 * the logs"
 *
 * A note is typed once, at intake, and read back days later in the Logs — which
 * is where a wrong one is noticed and, until this, the one place that could do
 * nothing about it. All four kinds of note a user writes about a sample have to
 * be correctable there: embedding, cut, slide and sample notes.
 *
 * This spec walks the captain's own path end to end: write all four at intake,
 * read them back in the Logs, correct them from the Logs, then RELOAD and read
 * them back again. The reload is the point — an edit that only updates the
 * screen is the same bug wearing a better face.
 */

const INTAKE = {
  embedding: "cut face down, proximal end left",
  cut: "10 um, discard the first ribbon",
  slide: "two sections per slide",
  sample: "decal ran long on this one",
};

const CORRECTED = {
  embedding: "cut face UP, proximal end right",
  cut: "8 um, discard the first two ribbons",
  slide: "three sections per slide",
  sample: "decal ran long; rehydrated overnight",
};

/** The four note editors in a block's expanded Logs row, by their own labels. */
function noteEditors(page: Page, code: string) {
  return {
    embedding: page.getByLabel(`Embedding Notes for ${code}`),
    cut: page.getByLabel(`Sectioning / Cut Notes for ${code}`),
    slide: page.getByLabel(`Slide Notes for ${code}`),
    sample: page.getByLabel(`General Notes for ${code}`),
  };
}

/**
 * The four notes as the DATABASE holds them, read through the sql.js shim.
 *
 * Polled on before every reload: a save-on-blur write is in flight when the
 * blur returns, and navigating on top of it would test the navigation rather
 * than the correction. It doubles as the per-column proof — a correction
 * written into the wrong column reads back in the wrong key here.
 */
type StoredNotes = { embedding: string; cut: string; slide: string; sample: string };

async function storedNotes(page: Page, storedCode: string): Promise<StoredNotes> {
  return await page.evaluate(
    (code) =>
      (
        window as unknown as { __SHIM_SELECT__: (s: string, b?: unknown[]) => unknown[] }
      ).__SHIM_SELECT__(
        `SELECT embedding_notes AS embedding, cut_notes AS cut, slide_notes AS slide,
                overall_notes AS sample
           FROM samples WHERE sample_code = ?`,
        [code],
      )[0] as StoredNotes,
    storedCode,
  );
}

/** A block's description as the DATABASE holds it, through the same shim. */
async function storedDescription(page: Page, storedCode: string): Promise<string> {
  const row = await page.evaluate(
    (code) =>
      (
        window as unknown as { __SHIM_SELECT__: (s: string, b?: unknown[]) => unknown[] }
      ).__SHIM_SELECT__(`SELECT sample_description AS d FROM samples WHERE sample_code = ?`, [
        code,
      ])[0] as { d: string },
    storedCode,
  );
  return row.d;
}

async function boot(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
}

/** Expand a block's row in the Logs, arriving from wherever the page is. */
async function expandInLogs(page: Page, code: string) {
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: code, exact: true }).click();
  await expect(page.getByText("Sample timeline")).toBeVisible();
}

/**
 * Open the block's board drawer, which DISPLAYS the same four notes.
 *
 * Via the Board deliberately: openBlockDrawer gives up early when a heading
 * matching "Timeline" is already visible, and an expanded Logs row shows
 * "Sample timeline" — so coming straight from the Logs it would assert against
 * the log it never left.
 */
async function openDrawerFromBoard(page: Page, code: string) {
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  await openBlockDrawer(page, code);
}

test("every note a sample carries can be corrected from the Logs", async ({ page }) => {
  await boot(page);

  // Intake: all four notes, each distinct, so a correction landing in the wrong
  // column is visible rather than plausible.
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("TE8-12 fixing sample");
  await page.getByLabel("Embedding Notes").fill(INTAKE.embedding);
  await page.getByLabel("Sectioning / Cut Notes").fill(INTAKE.cut);
  await page.getByLabel("Slide Notes").fill(INTAKE.slide);
  await page.getByLabel("General Notes").fill(INTAKE.sample);
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-1")).toBeVisible();

  // Read back in the Logs: every note he typed, where he reads the record.
  await expandInLogs(page, "EE-1");
  let notes = noteEditors(page, "EE-1");
  for (const kind of ["embedding", "cut", "slide", "sample"] as const) {
    await expect(notes[kind], `${kind} notes read back in the Logs`).toHaveValue(INTAKE[kind]);
  }

  // Correct all four from here. Save-on-blur, the same as the description and
  // the per-slide notes already in this row.
  for (const kind of ["embedding", "cut", "slide", "sample"] as const) {
    await notes[kind].fill(CORRECTED[kind]);
    await notes[kind].blur();
    await expect(notes[kind]).toHaveValue(CORRECTED[kind]);
  }

  // Every correction is in the database, in its own column, before the reload.
  await expect.poll(() => storedNotes(page, "EE-0001")).toEqual(CORRECTED);

  // Reload — goto("/") rather than reload(), which would carry ?freshdb=1 with
  // it and wipe the database the correction was written to.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await expandInLogs(page, "EE-1");
  notes = noteEditors(page, "EE-1");
  for (const kind of ["embedding", "cut", "slide", "sample"] as const) {
    await expect(notes[kind], `${kind} notes survived the reload`).toHaveValue(CORRECTED[kind]);
  }

  // And the correction reached the right column: the board drawer reads the
  // four notes back under four separate headings, so a swap between them would
  // show here even though all four textareas above looked right.
  await openDrawerFromBoard(page, "EE-1");
  for (const [heading, text] of [
    ["Embedding Notes", CORRECTED.embedding],
    ["Cut Notes", CORRECTED.cut],
    ["Slide Notes", CORRECTED.slide],
    ["General Notes", CORRECTED.sample],
  ]) {
    const section = page.getByRole("heading", { name: heading, exact: true });
    await expect(section, `${heading} in the board drawer`).toBeVisible();
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  }
});

test("a note can be cleared, and an unwritten one can be filled in from the Logs", async ({
  page,
}) => {
  await boot(page);

  // A block created with no notes at all. The Logs still offers all four boxes:
  // a correction surface that hides a blank note cannot fill one in, which is
  // the other half of getting a note wrong.
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("plain block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-1")).toBeVisible();

  await expandInLogs(page, "EE-1");
  const notes = noteEditors(page, "EE-1");
  for (const kind of ["embedding", "cut", "slide", "sample"] as const) {
    await expect(notes[kind]).toHaveValue("");
  }

  await notes.cut.fill("wedge the block, it is tilting");
  await notes.cut.blur();
  await expect
    .poll(async () => (await storedNotes(page, "EE-0001")).cut)
    .toBe("wedge the block, it is tilting");
  await page.goto("/");
  await expandInLogs(page, "EE-1");
  await expect(noteEditors(page, "EE-1").cut).toHaveValue("wedge the block, it is tilting");

  // Clearing is a correction too: a note emptied to whitespace must read as
  // empty, not as a blank line the drawer then shows a heading for.
  const cut = noteEditors(page, "EE-1").cut;
  await cut.fill("   ");
  await cut.blur();
  await expect.poll(async () => (await storedNotes(page, "EE-0001")).cut).toBe("");
  await page.goto("/");
  await expandInLogs(page, "EE-1");
  await expect(noteEditors(page, "EE-1").cut).toHaveValue("");
  await openDrawerFromBoard(page, "EE-1");
  await expect(page.getByRole("heading", { name: "Cut Notes", exact: true })).toHaveCount(0);
});

/**
 * The Logs is where the record is READ back, so making a note editable there
 * must not cost the reading of it: a note typed over several lines at intake
 * used to render whole, and a fixed two-row box would hide all but the first
 * two behind a scrollbar.
 */
test("a several-line note is read back whole in the Logs, not behind a scrollbar", async ({
  page,
}) => {
  await boot(page);

  const LONG = [
    "cut face down, proximal end left",
    "the tendon insertion points at the notch in the cassette",
    "do not re-orient it after the first ribbon",
    "wax was low on this one, top it up before embedding",
    "block 3 of 4 from the same limb",
    "ask Alex before re-embedding",
  ].join("\n");

  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("TE8-12 fixing sample");
  await page.getByLabel("Embedding Notes").fill(LONG);
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-1")).toBeVisible();

  await expandInLogs(page, "EE-1");
  const notes = noteEditors(page, "EE-1");
  await expect(notes.embedding).toHaveValue(LONG);

  // Nothing of the note is scrolled out of sight: the box is tall enough for
  // every line of it. (1px of slack for sub-pixel line heights.)
  await expect
    .poll(async () =>
      notes.embedding.evaluate((el: HTMLTextAreaElement) => el.scrollHeight - el.clientHeight),
    )
    .toBeLessThanOrEqual(1);

  // The box is still the user's to size — a note longer than this one is pulled
  // open rather than scrolled.
  await expect(notes.embedding).toHaveCSS("resize", "vertical");
});

test("a correction is undoable, and the undo names the note it restores", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("TE8-12 fixing sample");
  await page.getByLabel("Embedding Notes").fill(INTAKE.embedding);
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-1")).toBeVisible();

  await expandInLogs(page, "EE-1");

  // The description sits in the same expanded row and lands in the same undo
  // stack, so it has to name the block the same way — a stack reading "Edit
  // EE-0001 description" under "Edit EE-1 embedding notes" is two names for one
  // block. Corrected first, and saved the way it really is: by moving on to the
  // note below it.
  await page.getByLabel("Description for EE-1").fill("TE8-12 fixing sample, re-embedded");

  const embedding = noteEditors(page, "EE-1").embedding;
  await embedding.fill(CORRECTED.embedding);
  await embedding.blur();
  await expect(embedding).toHaveValue(CORRECTED.embedding);

  // Both corrections are in the database before anything is undone. A save is
  // fired on blur and nobody awaits it, so undoing on top of one still being
  // written would be testing that timing rather than the undo.
  await expect
    .poll(() => storedNotes(page, "EE-0001"))
    .toMatchObject({ embedding: CORRECTED.embedding });
  await expect
    .poll(() => storedDescription(page, "EE-0001"))
    .toBe("TE8-12 fixing sample, re-embedded");

  // The original text is not kept as a revision anywhere, so undo is how a
  // correction is taken back. It has to name WHICH note, or a stack of four
  // note edits is four indistinguishable entries.
  await page.getByTitle("Undo (Ctrl+Z)").click();
  await expect(page.getByText("Undone: Edit EE-1 embedding notes")).toBeVisible();
  await expect(noteEditors(page, "EE-1").embedding).toHaveValue(INTAKE.embedding);

  // Reading a note must not itself become an undo entry: focus and blur with no
  // change, and Redo still offers the correction above it, not a no-op.
  const sampleNotes = noteEditors(page, "EE-1").sample;
  await sampleNotes.focus();
  await sampleNotes.blur();
  await page.getByTitle("Redo (Ctrl+Y)").click();
  await expect(page.getByText("Redone: Edit EE-1 embedding notes")).toBeVisible();
  await expect(noteEditors(page, "EE-1").embedding).toHaveValue(CORRECTED.embedding);

  // Down to the description underneath it, which names the same block the same
  // way and restores the text it replaced.
  await page.getByTitle("Undo (Ctrl+Z)").click();
  await expect(page.getByText("Undone: Edit EE-1 embedding notes")).toBeVisible();
  await page.getByTitle("Undo (Ctrl+Z)").click();
  await expect(page.getByText("Undone: Edit EE-1 description")).toBeVisible();
  await expect(page.getByLabel("Description for EE-1")).toHaveValue("TE8-12 fixing sample");
});
