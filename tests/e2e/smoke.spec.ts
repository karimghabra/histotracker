import { test, expect } from "../helpers/test";

// Verifies the sql.js Tauri shim actually boots the real app in Chromium:
// migrations run, the board renders past the loading spinner and setup gate,
// and nothing throws in the console.
test("app boots on the sql.js shim with a clean console", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // Fresh DB each run so the smoke test is deterministic.
  await page.goto("/?freshdb=1");

  // The board header only renders once syncConfig resolves and the DB is up.
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });

  // The board drew every column, past the spinner and setup gate, and did not
  // spill sideways - what the capture this replaces was opened to check.
  for (const heading of [
    "Pre-processing",
    "Processor",
    "Needs Embedding",
    "Embedded Inventory",
    "Needs Sectioning",
    "Extras",
    "Staining / IHC",
    "Ready for Imaging",
  ]) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth);
  expect(overflow, "the board does not scroll sideways").toBeLessThanOrEqual(1);

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
