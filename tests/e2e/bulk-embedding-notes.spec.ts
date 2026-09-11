import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { openBlockDrawer } from "../helpers/stains";
import { readSheet } from "../helpers/xlsx";

/**
 * "Can samples that are added in bulk each receive their own unique embedding
 * notes? Add an option for 'apply this note to all samples', and an option for
 * defining each sample's embedding notes separately."
 *
 * Both modes, driven through the real New Sample dialog, and then read back from
 * every place a singly-created sample's note already shows: the board drawer,
 * the expanded Logs row, and the Logs CSV and Excel exports. A batch is only
 * finished when each sample reads exactly as if it had been created on its own.
 * (The mode switch itself — that it never drops typed text — is pinned in
 * src/components/NewSampleDialog.test.tsx.)
 */

async function boot(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
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

/** Open New Sample for a batch of three sharing one description. */
async function startBatch(page: Page) {
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByLabel("Quantity").fill("3");
  await page.getByPlaceholder(/added to every sample below/).fill("TE8 batch");
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

/** Split a CSV line on commas that are not inside a quoted cell. */
function cells(line: string): string[] {
  return (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [])
    .map((c) => c.replace(/,$/, ""))
    .slice(0, -1)
    .map((c) => (c.startsWith('"') ? c.slice(1, -1).replace(/""/g, '"') : c));
}

/** Each block's Embedding Notes cell, from both Logs exports of the same view. */
async function exportedNotes(page: Page): Promise<{ csv: Map<string, string>; xlsx: Map<string, string> }> {
  const byCode = (grid: string[][]) => {
    const [header, ...rows] = grid;
    const out = new Map<string, string>();
    for (const row of rows) {
      out.set(row[header.indexOf("Sample ID")], row[header.indexOf("Embedding Notes")] ?? "");
    }
    return out;
  };

  await page.getByRole("button", { name: "CSV" }).click();
  await expect(page.getByText("Exported.")).toBeVisible({ timeout: 15000 });
  const csvText = Buffer.from(await savedFile(page, ".csv")).toString("utf8");
  const csv = byCode(csvText.trim().split("\n").map(cells));

  await page.getByRole("button", { name: "Excel", exact: true }).click();
  await expect(page.getByText("Exported.")).toBeVisible({ timeout: 15000 });
  const xlsx = byCode(readSheet(await savedFile(page, ".xlsx")));
  return { csv, xlsx };
}

/**
 * Read one block's note back from the drawer and the expanded Logs row, and
 * from the two exports. `""` means the block has none, and then neither
 * surface may show an empty heading for it.
 */
async function expectNoteEverywhere(
  page: Page,
  exported: { csv: Map<string, string>; xlsx: Map<string, string> },
  code: string,
  note: string,
) {
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  await openBlockDrawer(page, code);
  if (note) {
    await expect(page.getByRole("heading", { name: "Embedding Notes" })).toBeVisible();
    await expect(page.getByText(note, { exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { name: "Embedding Notes" })).toHaveCount(0);
  }
  await page.locator("button:has(svg.lucide-x)").first().click();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: code, exact: true }).click();
  await expect(page.getByText("Sample timeline")).toBeVisible();
  if (note) {
    await expect(page.getByText("Embedding notes", { exact: true })).toBeVisible();
    await expect(page.getByText(note, { exact: true })).toBeVisible();
  } else {
    await expect(page.getByText("Embedding notes", { exact: true })).toHaveCount(0);
  }
  await page.getByRole("cell", { name: code, exact: true }).click(); // collapse

  expect(exported.csv.get(code), `${code} in the CSV export`).toBe(note);
  expect(exported.xlsx.get(code), `${code} in the Excel export`).toBe(note);
}

test("a batch with a note for each sample: every sample carries its own", async ({ page }) => {
  await boot(page);
  await startBatch(page);

  // The switch says which mode is live, and "one for all" is where it starts.
  await expect(page.getByRole("radio", { name: "One note for all 3" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("radio", { name: "A note for each" }).click();
  await expect(page.getByRole("radio", { name: "A note for each" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // …and it SHOWS which, not only tells a screen reader: once the colour change
  // settles, the live mode is the filled segment and the other is bare.
  const fill = (name: string) =>
    page.getByRole("radio", { name }).evaluate((e) => getComputedStyle(e).backgroundColor);
  await expect.poll(() => fill("One note for all 3")).toBe("rgba(0, 0, 0, 0)");
  expect(await fill("A note for each")).not.toBe("rgba(0, 0, 0, 0)");
  await page.getByLabel("Embedding note for EE-1").fill("cut face down");
  await page.getByLabel("Embedding note for EE-2").fill("bisect through the enthesis");
  // EE-3 is left blank on purpose: "for each" includes "none for this one".
  await page.screenshot({ path: "test-results/bulk-embedding-notes-each.png" });
  await page.getByRole("button", { name: "Create 3 Samples" }).click();
  await expect(page.getByText("EE-3", { exact: true }).first()).toBeVisible();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  const exported = await exportedNotes(page);
  await expectNoteEverywhere(page, exported, "EE-1", "cut face down");
  await expectNoteEverywhere(page, exported, "EE-2", "bisect through the enthesis");
  await expectNoteEverywhere(page, exported, "EE-3", "");
});

test("a batch with one note for all: every sample carries the same note", async ({ page }) => {
  await boot(page);
  await startBatch(page);
  await page.getByLabel("Embedding Notes").fill("orient anterior up");
  await page.screenshot({ path: "test-results/bulk-embedding-notes-all.png" });
  await page.getByRole("button", { name: "Create 3 Samples" }).click();
  await expect(page.getByText("EE-3", { exact: true }).first()).toBeVisible();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  const exported = await exportedNotes(page);
  for (const code of ["EE-1", "EE-2", "EE-3"]) {
    await expectNoteEverywhere(page, exported, code, "orient anterior up");
  }
});

test("a batch note and a single sample's note read back identically", async ({ page }) => {
  await boot(page);
  // One sample on its own, the way #137 first shipped…
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("single block");
  await page.getByLabel("Embedding Notes").fill("cut face down");
  await page.getByRole("button", { name: "Create Sample" }).click();
  await expect(page.getByText("EE-1", { exact: true }).first()).toBeVisible();

  // …and the same note given separately to one sample of a batch.
  await startBatch(page);
  await page.getByRole("radio", { name: "A note for each" }).click();
  await page.getByLabel("Embedding note for EE-3").fill("cut face down");
  await page.getByRole("button", { name: "Create 3 Samples" }).click();
  await expect(page.getByText("EE-4", { exact: true }).first()).toBeVisible();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  const exported = await exportedNotes(page);
  await expectNoteEverywhere(page, exported, "EE-1", "cut face down");
  await expectNoteEverywhere(page, exported, "EE-3", "cut face down");
  await expectNoteEverywhere(page, exported, "EE-2", "");
  await expectNoteEverywhere(page, exported, "EE-4", "");
});
