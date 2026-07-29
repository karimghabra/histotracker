import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The update must not compromise a database that is already in use. This loads a
// REAL pre-0023 image (built by scripts/make-legacy-db.mjs from migrations
// 0001–0022, populated with bench-shaped data) into the actual running app and
// checks that it opens, keeps every row, repairs itself, and supports the new
// features — no `?freshdb=1`, so the app is genuinely opening existing data.
//
// Note this is the STRICTER of the two upgrade paths: the browser shim opens a
// saved image WITHOUT re-running migrations, so `ensureRuntimeSchema()` alone has
// to converge it — the same situation as an undo restore or a viewer sync pull.
// The plugin-sql migration path is covered by scripts/legacy-db-upgrade-test.mjs.

const HERE = dirname(fileURLToPath(import.meta.url));
const LEGACY_B64 = readFileSync(join(HERE, "..", "fixtures", "legacy-pre-0023.b64"), "utf8").trim();

// The shim's virtual FS key (see src/test/shim-fs.ts + browser-sql-shim.ts).
const SHIM_KEY = "histometer-shim-fs:histometer-shim.db";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([key, b64]: [string, string]) => {
      window.localStorage.setItem(key, b64);
    },
    [SHIM_KEY, LEGACY_B64] as [string, string],
  );
});

test("an existing pre-0023 database opens in the new build with no data loss", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // No ?freshdb — open the injected image as-is.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });

  // The pre-existing project and its samples are all there.
  await expect(page.locator("aside").getByText("Enthesis Engineering")).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  for (const code of ["EE-0001", "EE-0002", "EE-0003"]) {
    await expect(page.getByRole("cell", { name: code, exact: true })).toBeVisible();
  }

  // Every original slide survived the upgrade, with its original code.
  await page.getByRole("cell", { name: "EE-0001", exact: true }).click();
  const codes = await page.locator("text=/^EE-0001-[A-Z]+$/").allTextContents();
  expect(codes.sort()).toEqual(["EE-0001-A", "EE-0001-B", "EE-0001-C", "EE-0001-D"]);

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("the #81 repair runs on the legacy image and separates the merged rack", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });

  const staining = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Staining / IHC", exact: true }) });

  // The fixture ships ONE Safranin O rack holding two samples' slides. On open,
  // the repair must pull the late arrival into its own rack.
  await expect(staining.locator("div[aria-selected]")).toHaveCount(2, { timeout: 20_000 });
  await expect(staining.getByText("2 samples")).toHaveCount(0);
  await expect(staining.getByText("1 sample")).toHaveCount(2);
});

test("the new features work on the upgraded legacy database", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });

  // #74 — archive a pre-existing sample, then bring it back.
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-0003", exact: true }).click();
  await page.getByRole("button", { name: "Archive EE-0003" }).click();
  await expect(page.getByRole("cell", { name: "EE-0003", exact: true })).toHaveCount(0, {
    timeout: 15000,
  });
  await page.getByLabel("Show archived").check();
  await expect(page.getByRole("cell", { name: "EE-0003", exact: true })).toBeVisible();
  await page.getByLabel("Show archived").uncheck();

  // #73 — the legacy sample has A–D and slides_issued = 0 (never tracked). Delete
  // C from the Extras inventory; the next cut must give E, not a duplicate D.
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  const extras = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Extras", exact: true }) });
  await extras.getByText("EE-0001").first().click();
  await page.locator("label").filter({ hasText: "EE-0001-C" }).locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: /Remove 1 slide/ }).click();
  await expect(page.getByText("EE-0001-C")).toHaveCount(0, { timeout: 15000 });

  // Cut again on the legacy block.
  await page.getByText("EE-0001", { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-0001", exact: true }).click();
  const after = await page.locator("text=/^EE-0001-[A-Z]+$/").allTextContents();
  expect(after).toContain("EE-0001-E");
  expect(after).not.toContain("EE-0001-C");
  expect(new Set(after).size).toBe(after.length); // no duplicate codes
});
