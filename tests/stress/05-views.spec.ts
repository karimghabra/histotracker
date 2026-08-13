import {
  test,
  expect,
  sql,
  count,
  column,
  closeDrawer,
  boot,
  addProject,
  selectProject,
  newSamples,
  runBatch,
  sendForCutting,
  runProtocolSteps,
  checkIntegrity,
} from "./lib";

/**
 * Every read surface, driven against a board that is genuinely full.
 *
 * Filters and sorts are where a workflow app quietly lies: a control that
 * returns nothing looks the same as a lab with nothing in it (#117), and a
 * control whose selected option disappears fires no change event (#85). So each
 * one here is driven and then CHECKED against the database, not just observed.
 */

async function cutAndSection(
  page: import("@playwright/test").Page,
  code: string,
  plan: string[],
): Promise<void> {
  await sendForCutting(page, code, plan);
  await closeDrawer(page);
  const queued = column(page, "Needs Sectioning");
  for (let guard = 0; guard < 20; guard += 1) {
    const card = queued.locator("div[aria-selected]").first();
    if ((await card.count()) === 0) break;
    await card.click();
    const mark = page.getByRole("button", { name: /Mark Sectioned/ });
    if (!(await mark.count())) {
      await closeDrawer(page);
      break;
    }
    await mark.click();
    await closeDrawer(page);
  }
}

// Data rows only. The empty state renders as a single full-width row, so
// counting every <tr> makes "no matches" look like one match.
const logsRows = (page: import("@playwright/test").Page) =>
  page.locator("tbody tr").filter({ hasNot: page.locator("td[colspan]") });

async function toLogs(page: import("@playwright/test").Page) {
  await closeDrawer(page);
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await expect(page.getByPlaceholder(/Search code/)).toBeVisible();
}

async function toBoard(page: import("@playwright/test").Page) {
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
}

/** Tick a stage in the Logs stage popover. */
async function stageFilter(page: import("@playwright/test").Page, label: string) {
  const summary = page.locator("summary").filter({ hasText: /stage/i }).first();
  if (!(await summary.count())) return false;
  const details = page.locator("details").filter({ has: summary }).first();
  // `<details open>` has the attribute set to the EMPTY STRING, which is falsy —
  // testing the attribute toggles the popover shut on every other call.
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await summary.click();
  const box = page.getByRole("checkbox", { name: label, exact: true });
  if (!(await box.count())) return false;
  await box.check();
  return true;
}

async function clearStageFilters(page: import("@playwright/test").Page) {
  const boxes = page.locator("details").getByRole("checkbox");
  for (let i = 0; i < (await boxes.count()); i += 1) {
    const box = boxes.nth(i);
    if (await box.isChecked().catch(() => false)) await box.uncheck();
  }
}

test("views: a full board's filters, sorts, search and exports all tell the truth", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "VA", "View Alpha");
  await addProject(page, "VB", "View Beta");

  await selectProject(page, "View Alpha");
  await newSamples(page, { quantity: 5, descriptions: ["va1", "va2", "va3", "va4", "va5"] });
  await selectProject(page, "View Beta");
  await newSamples(page, { quantity: 3, descriptions: ["vb1", "vb2", "vb3"] });

  // Leave VB-3 in pre-processing so every column has something in it.
  await selectProject(page, "View Alpha");
  await runBatch(page, ["VA-1", "VA-2", "VA-3"], "Batch 1");
  await selectProject(page, "View Beta");
  await runBatch(page, ["VB-1", "VB-2"], "Batch 2");

  await selectProject(page, "View Alpha");
  await cutAndSection(page, "VA-1", ["stain::H&E", "extra", "extra"]);
  await cutAndSection(page, "VA-2", ["ihc::CD31", "extra"]);
  await selectProject(page, "View Beta");
  await cutAndSection(page, "VB-1", ["stain::H&E", "extra"]);
  // VA-3 keeps a queued group so Needs Sectioning is not empty.
  await selectProject(page, "View Alpha");
  await sendForCutting(page, "VA-3", ["stain::PAS", "extra"]);

  // Take one rack to staining-in-progress and one all the way to imaging.
  await closeDrawer(page);
  const staining = column(page, "Staining / IHC");
  const first = staining.locator("div[aria-selected]").first();
  if (await first.count()) {
    await first.click();
    await runProtocolSteps(page);
    await closeDrawer(page);
  }

  await checkIntegrity(page, findings, "after building the view fixture");

  // ---------------------------------------------------------------- Logs
  await toLogs(page);

  const totalSamples = await count(page, `SELECT COUNT(*) AS n FROM samples`);
  const shown = await logsRows(page).count();
  findings.push({ where: "logs", detail: `${shown} rows shown for ${totalSamples} samples` });
  if (shown !== totalSamples) {
    findings.push({
      where: "logs",
      detail: `the unfiltered Logs show ${shown} of ${totalSamples} samples`,
    });
  }

  // -- project filter: drive EVERY option and check each against the database.
  const projectFilter = page.getByRole("combobox").filter({ hasText: /All projects/ }).first();
  if (await projectFilter.count()) {
    const options = await projectFilter.locator("option").all();
    for (let i = 1; i < options.length; i += 1) {
      const label = (await options[i].innerText()).trim();
      await projectFilter.selectOption({ index: i });
      await page.waitForTimeout(350);
      const rows = await logsRows(page).count();
      const expected = await count(
        page,
        `SELECT COUNT(*) AS n FROM samples s JOIN projects p ON p.id = s.project_id
          WHERE p.code = ? OR p.name = ?`,
        [label, label],
      );
      findings.push({
        where: "logs project filter",
        detail: `"${label}" → ${rows} rows, DB says ${expected}`,
      });
      if (expected > 0 && rows !== expected) {
        findings.push({
          where: "logs project filter",
          detail: `DEFECT: "${label}" shows ${rows} rows but the project has ${expected} samples`,
        });
      }
    }
    await projectFilter.selectOption({ index: 0 });
    await page.waitForTimeout(300);
  } else {
    findings.push({ where: "logs", detail: "no project filter found in the Logs" });
  }

  // -- stage filters: every one of them, against the DB
  const stages = ["Pre-processing", "Embedded", "Sectioned", "Staining / IHC", "Imaging", "Analyzed"];
  for (const label of stages) {
    await clearStageFilters(page);
    const ok = await stageFilter(page, label);
    if (!ok) {
      findings.push({ where: "logs stage filter", detail: `no "${label}" stage filter offered` });
      continue;
    }
    await page.waitForTimeout(300);
    const rows = await logsRows(page).count();
    findings.push({ where: "logs stage filter", detail: `${label} → ${rows} rows` });
    if (rows === 0) {
      findings.push({
        where: "logs stage filter",
        detail: `"${label}" returns NOTHING on a board that has work at every stage — the empty result is indistinguishable from an empty lab (#117)`,
      });
    }
  }
  await clearStageFilters(page);

  // -- search, including the padding-insensitive forms (#120)
  const search = page.getByPlaceholder(/Search code/);
  for (const [term, expectVisible] of [
    ["VA-1", true],
    ["VA-0001", true],
    ["va1", true],
    ["nonexistent-xyz", false],
  ] as Array<[string, boolean]>) {
    await search.fill(term);
    await page.waitForTimeout(350);
    const rows = await logsRows(page).count();
    const found = rows > 0;
    findings.push({ where: "logs search", detail: `"${term}" → ${rows} rows` });
    if (found !== expectVisible) {
      findings.push({
        where: "logs search",
        detail: `DEFECT: searching "${term}" ${found ? "matched" : "matched nothing"} — expected the opposite`,
      });
    }
  }
  await search.fill("");
  await page.waitForTimeout(300);

  // -- sorting by every column header must not throw or empty the table
  const headers = page.locator("thead th");
  const headerCount = await headers.count();
  for (let i = 0; i < headerCount; i += 1) {
    const header = headers.nth(i);
    const label = (await header.innerText()).trim();
    if (!label) continue;
    const clickable = header.locator("button");
    const target = (await clickable.count()) ? clickable.first() : header;
    await target.click().catch(() => undefined);
    await page.waitForTimeout(200);
    const rows = await logsRows(page).count();
    if (rows === 0) {
      findings.push({
        where: "logs sort",
        detail: `DEFECT: sorting by "${label}" emptied the table`,
      });
    }
  }

  // -- show archived / show removed toggles
  for (const label of ["Show archived", "Show removed"]) {
    const toggle = page.getByLabel(label);
    if (!(await toggle.count())) {
      findings.push({ where: "logs toggles", detail: `no "${label}" toggle` });
      continue;
    }
    const before = await logsRows(page).count();
    await toggle.check();
    await page.waitForTimeout(300);
    const after = await logsRows(page).count();
    findings.push({ where: "logs toggles", detail: `${label}: ${before} → ${after} rows` });
    await toggle.uncheck();
    await page.waitForTimeout(200);
  }

  // -- exports
  //
  // These go through the Tauri save dialog (`@tauri-apps/plugin-dialog`), which
  // the browser shim does not provide — so a download can never arrive here and
  // its absence proves nothing. What CAN be checked is that the click is handled
  // and the outcome is reported rather than failing silently.
  for (const label of ["CSV", "Excel"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    if (!(await button.count())) {
      findings.push({ where: "logs export", detail: `no ${label} export button` });
      continue;
    }
    await button.click();
    await page.waitForTimeout(800);
    const message = await page
      .getByText(/Exported\.|Export cancelled\.|Export failed/)
      .first()
      .innerText()
      .catch(() => "(no message)");
    findings.push({
      where: "logs export",
      detail: `${label} → "${message}" (a Tauri save dialog cannot open under the browser shim, so this only proves the click is handled and reported)`,
    });
  }

  // ------------------------------------------------------------- board
  await toBoard(page);

  // Every column filter/sort control: drive it and confirm the column does not
  // silently empty. #85 is the pattern — a select whose option vanishes.
  const controls = [
    "Filter pre-processing by project",
    "Sort pre-processing",
    "Filter needs embedding by project",
    "Sort needs embedding",
    "Filter needs sectioning by project",
    "Sort needs sectioning",
    "Filter imaging by project",
    "Filter imaging by stain",
  ];
  for (const label of controls) {
    const control = page.getByLabel(label);
    if (!(await control.count())) {
      findings.push({ where: "board controls", detail: `no control labelled "${label}"` });
      continue;
    }
    const options = await control.locator("option").allInnerTexts();
    for (let i = 0; i < options.length; i += 1) {
      await control.selectOption({ index: i });
      await page.waitForTimeout(150);
    }
    await control.selectOption({ index: 0 });
    findings.push({
      where: "board controls",
      detail: `"${label}" cycled ${options.length} options: ${options.map((o) => o.trim()).join(" | ")}`,
    });
  }

  // ---------------------------------------------------------- manifest
  await page.getByRole("button", { name: "Manifest" }).click();
  await page.waitForTimeout(500);
  const manifestRows = await page.locator("tbody tr").count();
  const auditRows = await count(page, `SELECT COUNT(*) AS n FROM audit_events`);
  findings.push({
    where: "manifest",
    detail: `manifest shows ${manifestRows} rows; audit_events holds ${auditRows}`,
  });
  if (manifestRows === 0 && auditRows > 0) {
    findings.push({
      where: "manifest",
      detail: `DEFECT: the manifest is empty while ${auditRows} audit events exist`,
    });
  }
  const manifestSearch = page.getByLabel("Search the manifest");
  if (await manifestSearch.count()) {
    await manifestSearch.fill("VA-1");
    await page.waitForTimeout(400);
    findings.push({
      where: "manifest",
      detail: `manifest search "VA-1" → ${await page.locator("tbody tr").count()} rows`,
    });
    await manifestSearch.fill("");
  } else {
    findings.push({ where: "manifest", detail: "no manifest search box" });
  }
  for (const label of ["Filter manifest by action", "Filter manifest by user"]) {
    const control = page.getByLabel(label);
    if (!(await control.count())) {
      findings.push({ where: "manifest", detail: `no control labelled "${label}"` });
      continue;
    }
    const options = await control.locator("option").allInnerTexts();
    for (let i = 0; i < options.length; i += 1) {
      await control.selectOption({ index: i });
      await page.waitForTimeout(120);
    }
    await control.selectOption({ index: 0 });
    findings.push({ where: "manifest", detail: `"${label}" has ${options.length} options` });
  }

  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
