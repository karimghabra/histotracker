import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { cutBlockFor } from "../helpers/cut";
import { addStainFromLogs } from "../helpers/stains";
import { readSheet } from "../helpers/xlsx";

/**
 * The Logs export's note columns, driven through the app's own Save buttons.
 *
 * The bug this guards: the export carried ONE note column called "Slide Notes",
 * and it held the physical slide's note — a different field from the box
 * labelled Slide Notes on screen — while the cut notes and the sample's
 * slide-plan notes reached the file at all. So a note corrected in the Logs was
 * missing from the export of that same view, and the column that did arrive was
 * mislabelled.
 *
 * The unit suites (src/lib/logsCsv.test.ts, logsXlsx.test.ts) pin the cells from
 * hand-built rows. This one walks the user's path instead: type four notes at
 * intake, correct one in the Logs, write a note on the glass, then click CSV and
 * Excel and read the bytes that landed in the shim filesystem — the only place
 * that shows what the technician actually opens.
 */

const INTAKE = {
  embedding: "EMB-7f3 cut face down",
  cut: "CUT-7f3 10 um, discard the first ribbon",
  slide: "PLAN-7f3 two sections per slide",
  general: "GEN-7f3 decal ran long, and a comma",
};
const CORRECTED_PLAN = 'PLAN-7f3 corrected in the Logs: three "per slide"';
const GLASS_NOTE = "GLASS-7f3 faint staining on this one";

/** The five note columns, in the order the file holds them. */
const NOTE_COLUMNS = [
  "This Slide's Notes",
  "Embedding Notes",
  "Sectioning / Cut Notes",
  "Slide Notes",
  "General Notes",
];

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

/** The bytes of the most recently saved file whose path ends with `suffix`. */
async function savedFile(page: Page, suffix: string): Promise<Uint8Array> {
  const b64 = await page.evaluate((end) => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith("histometer-shim-fs:") && k.endsWith(end)) {
        return localStorage.getItem(k) as string;
      }
    }
    return "";
  }, suffix);
  expect(b64, `nothing was saved ending in ${suffix}`).not.toBe("");
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

/** RFC 4180 enough for this file: quoted cells, doubled quotes, embedded commas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [[]];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      rows[rows.length - 1].push(cell);
      cell = "";
    } else if (c === "\n") {
      rows[rows.length - 1].push(cell);
      cell = "";
      rows.push([]);
    } else if (c !== "\r") cell += c;
  }
  rows[rows.length - 1].push(cell);
  return rows.filter((r) => r.some(Boolean));
}

/** Expand a block's row in the Logs, arriving from wherever the page is. */
async function expandInLogs(page: Page, code: string) {
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  if (!(await page.getByText("Sample timeline").isVisible().catch(() => false))) {
    await page.getByRole("cell", { name: code, exact: true }).click();
  }
  await expect(page.getByText("Sample timeline")).toBeVisible();
}

/** Correct a sample note the way a user does: pencil, retype, move on. */
async function correct(page: Page, code: string, label: string, text: string) {
  await page.getByLabel(`Edit ${label} for ${code}`, { exact: true }).click();
  const box = page.getByLabel(`${label} for ${code}`, { exact: true });
  await box.fill(text);
  await box.blur();
  await expect(box).toHaveText(text);
}

async function exportAndRead(page: Page, kind: "CSV" | "Excel"): Promise<string[][]> {
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("button", { name: kind, exact: true }).click();
  await expect(page.getByText("Exported.")).toBeVisible({ timeout: 15000 });
  return kind === "CSV"
    ? parseCsv(new TextDecoder().decode(await savedFile(page, ".csv")))
    : readSheet(await savedFile(page, ".xlsx"));
}

test("the Logs export carries all four notes, each under its on-screen label (#155 follow-up)", async ({
  page,
}) => {
  await boot(page);

  // Intake: all four notes, a distinct sentinel in each, so a swapped or
  // dropped column cannot pass by coincidence.
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("TE8-12 fixing sample");
  await page.getByLabel("Embedding Notes").fill(INTAKE.embedding);
  await page.getByLabel("Sectioning / Cut Notes").fill(INTAKE.cut);
  await page.getByLabel("Slide Notes").fill(INTAKE.slide);
  await page.getByLabel("General Notes").fill(INTAKE.general);
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("EE-1")).toBeVisible();

  // Real glass for one stain, and a second stain assigned but never cut — the
  // two shapes of row the export writes.
  await cutBlockFor(page, "EE-1", "Alcian Blue");
  expect(await addStainFromLogs(page, "EE-1", "stain::Safranin O")).toContain("Safranin O");

  // A note on the glass itself, written where the technician writes it.
  await expandInLogs(page, "EE-1");
  await page.getByRole("button", { name: /EE-1-A/ }).click();
  const glass = page.getByPlaceholder("Notes about this slide…");
  await glass.fill(GLASS_NOTE);
  await glass.blur();
  await expect(glass).toHaveValue(GLASS_NOTE);

  // …and a correction to a sample note, made in the Logs, which is the whole
  // point: the export of this view has to carry the words now on screen.
  await correct(page, "EE-1", "Slide Notes", CORRECTED_PLAN);

  // The labels the screen itself uses for those four notes, read off the live
  // controls rather than assumed.
  const onScreen = await page
    .locator('button[aria-label^="Edit "][aria-label$=" for EE-1"]')
    .evaluateAll((els) =>
      els.map((el) => (el.getAttribute("aria-label") ?? "").replace(/^Edit /, "").replace(/ for EE-1$/, "")),
    );
  expect(onScreen, "the four note labels on the Logs screen").toEqual([
    "Embedding Notes",
    "Sectioning / Cut Notes",
    "Slide Notes",
    "General Notes",
  ]);

  const csv = await exportAndRead(page, "CSV");
  const header = csv[0];
  expect(header.slice(-5), "the export's note columns").toEqual(NOTE_COLUMNS);
  // Every name the screen shows is a column name in the file — the mislabelled
  // column is what made a corrected note unfindable.
  for (const label of onScreen) expect(header, `${label} column`).toContain(label);

  const at = (row: string[], name: string) => row[header.indexOf(name)];
  const rows = csv.slice(1);
  const cut = rows.find((r) => at(r, "Stain / IHC") === "Alcian Blue");
  const owed = rows.find((r) => at(r, "Stain / IHC") === "Safranin O");
  expect(cut, "a row for the slide that was cut").toBeTruthy();
  expect(owed, "a row for the stain assigned but never cut").toBeTruthy();

  // The cut slide's row: the four sample notes as they read on screen NOW
  // (including the correction), and the glass's own note in its own column.
  expect(NOTE_COLUMNS.map((c) => at(cut!, c))).toEqual([
    GLASS_NOTE,
    INTAKE.embedding,
    INTAKE.cut,
    CORRECTED_PLAN,
    INTAKE.general,
  ]);
  // Adversarial: the two fields that share the words "slide notes" must not be
  // each other. The old export put the glass note under "Slide Notes".
  expect(at(cut!, "Slide Notes")).not.toBe(GLASS_NOTE);
  expect(at(cut!, "This Slide's Notes")).not.toBe(CORRECTED_PLAN);
  // …and the note that was corrected does not survive anywhere as its old words.
  expect(csv.flat().join("\u0000")).not.toContain(INTAKE.slide);

  // The requested-but-never-cut row has no glass, so no note of a slide's own —
  // but it still carries everything written about the block.
  expect(at(owed!, "Slide")).toBe("");
  expect(NOTE_COLUMNS.map((c) => at(owed!, c))).toEqual([
    "",
    INTAKE.embedding,
    INTAKE.cut,
    CORRECTED_PLAN,
    INTAKE.general,
  ]);

  // The Excel workbook is the same cells — a separate writer, so it is read back
  // from its own bytes rather than assumed.
  const grid = await exportAndRead(page, "Excel");
  expect(grid.map((r) => r.slice(-5))).toEqual(csv.map((r) => r.slice(-5)));
  expect(grid[0]).toEqual(header);
});
