import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";
import { addStainFromLogs } from "../helpers/stains";
import { cutBlockFor } from "../helpers/cut";
import { readSheet, readWorkbook } from "../helpers/xlsx";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Excel side of the exports, driven through the app's own Save buttons.
 *
 * The CSV path is covered by issues-136-137.spec.ts. The `.xlsx` path is a
 * separate writer, and a wrong argument shape there is accepted SILENTLY: the
 * file is saved, the app says "Exported.", and the workbook opens with not one
 * cell in it. So these specs click the real button and then decode the bytes
 * that landed in the virtual filesystem — the only place that lie shows up.
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

async function newSample(
  page: Page,
  opts: { description: string; embeddingNotes?: string; stains?: string[] },
) {
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(opts.description);
  if (opts.embeddingNotes !== undefined) {
    await page.getByLabel("Embedding Notes").fill(opts.embeddingNotes);
  }
  for (const stain of opts.stains ?? []) {
    await page.locator("label").filter({ hasText: stain }).last().getByRole("checkbox").check();
  }
  await page.getByRole("button", { name: /Create Sample/ }).click();
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

test("the Logs Excel export carries the rows the Logs screen shows (#136/#137)", async ({
  page,
}) => {
  await boot(page);

  // EE-1: a stain assigned at intake and no glass at all — the captain's case.
  await newSample(page, {
    description: "TE8-12 fixing sample",
    embeddingNotes: "cut face down, proximal end left",
    stains: ["Safranin O"],
  });
  await expect(page.getByText("EE-1")).toBeVisible();
  // EE-2: real glass for one agent, a second agent still only assigned.
  await newSample(page, { description: "cut but still owing a stain" });
  await expect(page.getByText("EE-2")).toBeVisible();
  await cutBlockFor(page, "EE-2", "Alcian Blue");
  expect(await addStainFromLogs(page, "EE-2", "stain::Safranin O")).toContain("Safranin O");

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-2", exact: true }).click(); // collapse
  await page.getByRole("button", { name: "Excel", exact: true }).click();
  await expect(page.getByText("Exported.")).toBeVisible({ timeout: 15000 });

  const grid = readSheet(await savedFile(page, ".xlsx"));
  const header = grid[0];
  expect(header).toContain("Sample ID");
  expect(header).toContain("Stain / IHC");
  const col = (row: string[], name: string) => row[header.indexOf(name)];
  const rowsFor = (code: string) => grid.slice(1).filter((r) => col(r, "Sample ID") === code);

  // A workbook with a header and no body is the failure this guards against.
  expect(grid.length).toBeGreaterThan(1);

  const one = rowsFor("EE-1");
  expect(one).toHaveLength(1);
  expect(col(one[0], "Stain / IHC")).toBe("Safranin O");
  expect(col(one[0], "Slide")).toBe("");
  expect(col(one[0], "Slide Stage")).toBe("requested (not cut)");
  expect(col(one[0], "Embedding Notes")).toBe("cut face down, proximal end left");

  const two = rowsFor("EE-2");
  expect(two.some((r) => col(r, "Stain / IHC") === "Alcian Blue")).toBe(true);
  const owed = two.filter((r) => col(r, "Stain / IHC") === "Safranin O");
  expect(owed).toHaveLength(1);
  expect(col(owed[0], "Slide")).toBe("");
  expect(col(owed[0], "Slide Stage")).toBe("requested (not cut)");

  // Render the decoded workbook next to the screen it was taken from, so the
  // two can be compared by eye.
  await page.screenshot({ path: "test-results/nm-logs-screen.png", fullPage: true });
  await page.setContent(
    `<style>body{font:13px system-ui;padding:16px}table{border-collapse:collapse}
     td,th{border:1px solid #bbb;padding:3px 7px;white-space:nowrap}th{background:#eef}</style>
     <h3>histometer-logs.xlsx — decoded "Log" sheet</h3><table>` +
      grid
        .map(
          (r, i) =>
            "<tr>" +
            r.map((c) => `<${i ? "td" : "th"}>${c || "&nbsp;"}</${i ? "td" : "th"}>`).join("") +
            "</tr>",
        )
        .join("") +
      "</table>",
  );
  await page.screenshot({ path: "test-results/nm-logs-xlsx.png", fullPage: true });
});

test("the Excel workbook export writes every sheet with real rows", async ({ page }) => {
  await boot(page);
  await newSample(page, {
    description: "workbook block",
    embeddingNotes: "bisect longitudinally",
    stains: ["Safranin O"],
  });
  await expect(page.getByText("EE-1")).toBeVisible();

  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("button", { name: /Excel workbook/ }).click();
  await expect(page.getByText(/Exported to/)).toBeVisible({ timeout: 15000 });

  const sheets = readWorkbook(await savedFile(page, ".xlsx"));
  expect([...sheets.keys()]).toEqual([
    "Projects",
    "Samples",
    "Cut Orders",
    "Slides",
    "Processing Batches",
  ]);
  // Every sheet carries its header row…
  for (const [name, rows] of sheets) {
    expect(rows.length, `${name} has no header row`).toBeGreaterThan(0);
    expect(rows[0].length, `${name} header is empty`).toBeGreaterThan(1);
  }
  // …and the sheets that have data carry it.
  const projects = sheets.get("Projects") as string[][];
  expect(projects.slice(1).some((r) => r.includes("EE"))).toBe(true);
  const samples = sheets.get("Samples") as string[][];
  const sampleHeader = samples[0];
  const row = samples.slice(1).find((r) => r[sampleHeader.indexOf("Sample ID")] === "EE-1");
  expect(row, "the sample just created is missing from the Samples sheet").toBeDefined();
  expect(row?.[sampleHeader.indexOf("Description")]).toBe("workbook block");
  expect(row?.[sampleHeader.indexOf("Embedding Notes")]).toBe("bisect longitudinally");
});

// The third workbook writer: the status workbook a workstation PUBLISHES with
// every sync, which is what a viewer machine (and the captain, from the
// release) opens in Excel. Nothing in the UI shows its contents, so an empty
// one would ship silently — drive a real publish and read the asset back.
test("the published status workbook carries both sheets with real rows", async ({ browser }) => {
  const ns = `nm-workbook-${Date.now()}`;
  const context = await browser.newContext();
  await context.addInitScript((data: { ns: string }) => {
    (window as unknown as Record<string, unknown>).__FAKEGH_NS__ = data.ns;
    (window as unknown as Record<string, unknown>).__SYNC_OVERRIDE__ = {
      role: "workstation",
      repo_owner: "lab",
      repo_name: "archive",
      operator_name: "Bench",
      operator_initials: "OP",
      configured: true,
      has_token: true,
      install_id: "ws-1",
    };
  }, { ns });
  const page = await context.newPage();

  await boot(page);
  await newSample(page, {
    description: "published block",
    embeddingNotes: "orient anterior up",
    stains: ["Safranin O"],
  });
  await expect(page.getByText("EE-1")).toBeVisible();

  await page.getByTitle("Sync now").click();
  await expect(page.getByText("Syncing…")).toHaveCount(0, { timeout: 20000 });
  await expect(page.getByText("Sync error")).toHaveCount(0);

  const bytes = await page.evaluate(async (namespace) => {
    const res = await fetch(`/__fakegh/download_release_asset?ns=${encodeURIComponent(namespace)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "snapshot-latest", assetName: "histometer-status.xlsx" }),
    });
    return (await res.json()) as number[];
  }, ns);
  expect(bytes.length, "no status workbook was published").toBeGreaterThan(0);

  const sheets = readWorkbook(Uint8Array.from(bytes));
  expect([...sheets.keys()]).toEqual(["Sample Status", "Slide Status"]);
  const samples = sheets.get("Sample Status") as string[][];
  expect(samples[0]).toContain("Sample ID");
  expect(samples[0]).toContain("Embedding Notes");
  const row = samples.slice(1).find((r) => r[samples[0].indexOf("Sample ID")] === "EE-1");
  expect(row, "the published workbook has no rows").toBeDefined();
  expect(row?.[samples[0].indexOf("Description")]).toBe("published block");
  expect(row?.[samples[0].indexOf("Embedding Notes")]).toBe("orient anterior up");
  expect((sheets.get("Slide Status") as string[][])[0]).toContain("Slide ID");

  await context.close();
});

// The captain's database is POPULATED. scripts/legacy-db-upgrade-test.mjs proves
// the column arrives with every row intact at the data layer; this drives the
// same real pre-0023 image through the running app: the old rows are still
// there, the NEW field works on it, and the log it exports carries both.
test("a populated database from before #137 gains embedding notes with its rows intact", async ({
  browser,
}) => {
  const b64 = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "legacy-pre-0023.b64"),
    "utf8",
  ).trim();
  const context = await browser.newContext();
  await context.addInitScript(
    ([key, image]: [string, string]) => window.localStorage.setItem(key, image),
    ["histometer-shim-fs:histometer-shim.db", b64] as [string, string],
  );
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // No ?freshdb — this opens the existing image, exactly as an update would.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await page.locator("aside").getByText("Enthesis Engineering").click();
  // The image already carries the lab user; sign in as them, which is what the
  // New Sample button waits for.
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });

  // The three blocks that were already in the database are still there…
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  for (const code of ["EE-1", "EE-2", "EE-3"]) {
    await expect(page.getByRole("cell", { name: code, exact: true })).toBeVisible();
  }

  // …and the new field works on the upgraded database.
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  await newSample(page, {
    description: "post-upgrade block",
    embeddingNotes: "embed cut face down",
    stains: ["Safranin O"],
  });
  await expect(page.getByText("EE-4")).toBeVisible();
  await page.getByText("EE-4", { exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Embedding Notes" })).toBeVisible();
  await expect(page.getByText("embed cut face down")).toBeVisible();
  await page.screenshot({ path: "test-results/nm-legacy-embedding-notes.png", fullPage: true });
  await page.locator("button:has(svg.lucide-x)").first().click();

  // The log exported from the upgraded database carries the note and the
  // assigned-but-uncut stain, and still lists the pre-existing blocks.
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("button", { name: "Excel", exact: true }).click();
  await expect(page.getByText("Exported.")).toBeVisible({ timeout: 15000 });
  const grid = readSheet(await savedFile(page, ".xlsx"));
  const header = grid[0];
  const col = (row: string[], name: string) => row[header.indexOf(name)];
  const four = grid.slice(1).filter((r) => col(r, "Sample ID") === "EE-4");
  expect(four).toHaveLength(1);
  expect(col(four[0], "Stain / IHC")).toBe("Safranin O");
  expect(col(four[0], "Slide Stage")).toBe("requested (not cut)");
  expect(col(four[0], "Embedding Notes")).toBe("embed cut face down");
  // The pre-existing rows export too, with an empty note rather than a crash.
  for (const code of ["EE-1", "EE-2", "EE-3"]) {
    const rows = grid.slice(1).filter((r) => col(r, "Sample ID") === code);
    expect(rows.length, `${code} is missing from the export`).toBeGreaterThan(0);
    expect(col(rows[0], "Embedding Notes")).toBe("");
  }
  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
  await context.close();
});

// Adversarial: a note is free text typed by a technician. Both exports have to
// carry it verbatim — CSV quoting and XLSX XML escaping are different codepaths
// over the same string, and a workbook is XML, where a bare & is not valid.
test("a note full of hostile characters survives both exports verbatim", async ({ page }) => {
  const nasty = 'A & B <bisect>, "proximal" end; 100%_LIKE\tαβ 🧫';
  await boot(page);
  await newSample(page, {
    description: 'hostile "note" block, & co',
    embeddingNotes: nasty,
    stains: ["Safranin O"],
  });
  await expect(page.getByText("EE-1")).toBeVisible();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("button", { name: "Excel", exact: true }).click();
  await expect(page.getByText("Exported.")).toBeVisible({ timeout: 15000 });
  const grid = readSheet(await savedFile(page, ".xlsx"));
  const header = grid[0];
  const row = grid.slice(1).find((r) => r[header.indexOf("Sample ID")] === "EE-1") as string[];
  expect(row[header.indexOf("Embedding Notes")]).toBe(nasty);
  expect(row[header.indexOf("Description")]).toBe('hostile "note" block, & co');

  await page.getByRole("button", { name: "CSV" }).click();
  await expect(page.getByText("Exported.")).toBeVisible({ timeout: 15000 });
  const csv = new TextDecoder().decode(await savedFile(page, ".csv"));
  const lines = csv.trim().split("\n");
  // A quoted cell keeps the note whole: doubled quotes, commas and all.
  expect(lines[1]).toContain(`"${nasty.replace(/"/g, '""')}"`);
  // And the drill-down on screen shows the same string it exported.
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();
  await expect(page.getByText(nasty)).toBeVisible();
});
