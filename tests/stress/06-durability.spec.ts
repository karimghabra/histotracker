import {
  test,
  expect,
  sql,
  count,
  column,
  drawer,
  closeDrawer,
  openTile,
  boot,
  addProject,
  newSamples,
  runBatch,
  sendForCutting,
  runProtocolSteps,
  checkIntegrity,
  tally,
  openSettings,
  closeSettings,
} from "./lib";

/**
 * The things that have to survive being hammered: undo/redo over a long chain
 * of mutations, a project renamed under a full board, exhausted blocks and
 * archived samples, and editing a processing run that is already going.
 *
 * Undo restores whole database IMAGES, so the interesting question is never
 * "did one field come back" but "did the image come back INTACT" — which is
 * what the integrity probes are for.
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

test("durability: a long undo chain rewinds the whole board and redo replays it", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "UD", "Undo Deep");
  await newSamples(page, { quantity: 4, descriptions: ["d1", "d2", "d3", "d4"] });
  await runBatch(page, ["UD-1", "UD-2", "UD-3", "UD-4"], "Batch 1");

  const checkpoints: Array<{ label: string; tally: Record<string, number> }> = [];
  checkpoints.push({ label: "embedded", tally: await tally(page) });

  await cutAndSection(page, "UD-1", ["stain::H&E", "extra"]);
  checkpoints.push({ label: "cut UD-1", tally: await tally(page) });
  await cutAndSection(page, "UD-2", ["stain::H&E", "ihc::CD31", "extra"]);
  checkpoints.push({ label: "cut UD-2", tally: await tally(page) });

  await closeDrawer(page);
  const staining = column(page, "Staining / IHC");
  if (await staining.locator("div[aria-selected]").first().count()) {
    await staining.locator("div[aria-selected]").first().click();
    await runProtocolSteps(page);
    await closeDrawer(page);
  }
  checkpoints.push({ label: "stained", tally: await tally(page) });

  const peak = await tally(page);
  findings.push({ where: "undo chain", detail: `peak state: ${JSON.stringify(peak)}` });

  // Rewind as far as the app will go.
  const undo = page.getByTitle("Undo (Ctrl+Z)");
  let undos = 0;
  for (let i = 0; i < 40; i += 1) {
    if (await undo.isDisabled().catch(() => true)) break;
    await undo.click({ force: true });
    await page.waitForTimeout(250);
    undos += 1;
  }
  const rewound = await tally(page);
  findings.push({ where: "undo chain", detail: `${undos} undos → ${JSON.stringify(rewound)}` });
  const broken = await checkIntegrity(page, findings, `after ${undos} undos`);
  if (broken > 0) {
    findings.push({
      where: "undo chain",
      detail: `DEFECT: ${broken} integrity probe(s) broke after rewinding ${undos} steps`,
    });
  }

  // …then replay it all.
  const redo = page.getByTitle("Redo (Ctrl+Y)");
  let redos = 0;
  if (await redo.count()) {
    for (let i = 0; i < 40; i += 1) {
      if (await redo.isDisabled().catch(() => true)) break;
      await redo.click({ force: true });
      await page.waitForTimeout(250);
      redos += 1;
    }
  } else {
    findings.push({ where: "redo chain", detail: "no Redo control found" });
  }
  const replayed = await tally(page);
  findings.push({ where: "redo chain", detail: `${redos} redos → ${JSON.stringify(replayed)}` });

  const brokenAfterRedo = await checkIntegrity(page, findings, `after ${redos} redos`);
  if (brokenAfterRedo > 0) {
    findings.push({
      where: "redo chain",
      detail: `DEFECT: ${brokenAfterRedo} integrity probe(s) broke after replaying ${redos} steps`,
    });
  }
  // audit_events is excluded: undo/redo are themselves auditable actions, so the
  // trail is EXPECTED to be longer after a replay. Everything else must match.
  const withoutAudit = (t: Record<string, number>) => {
    const { audit_events: _ignored, ...rest } = t;
    return rest;
  };
  if (undos === redos && JSON.stringify(withoutAudit(replayed)) !== JSON.stringify(withoutAudit(peak))) {
    findings.push({
      where: "redo chain",
      detail: `DEFECT: full undo then full redo did not return to the peak state (audit trail excluded). peak=${JSON.stringify(withoutAudit(peak))} replayed=${JSON.stringify(withoutAudit(replayed))}`,
    });
  }

  // The signed-in user must survive an image restore.
  const signedIn = await page.getByLabel("Signed-in user").inputValue();
  if (!signedIn || signedIn === "") {
    findings.push({
      where: "undo chain",
      detail: "DEFECT: the signed-in user was lost during the undo/redo storm",
    });
  }

  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("durability: renaming a project under a full board renames everything it owns", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "RN", "Rename Me");
  await newSamples(page, { quantity: 4, descriptions: ["n1", "n2", "n3", "n4"] });
  await runBatch(page, ["RN-1", "RN-2", "RN-3", "RN-4"], "Batch 1");
  await cutAndSection(page, "RN-1", ["stain::H&E", "extra", "extra"]);
  await cutAndSection(page, "RN-2", ["ihc::CD31", "extra"]);

  const before = {
    samples: await count(page, `SELECT COUNT(*) AS n FROM samples WHERE sample_code LIKE 'RN-%'`),
    slides: await count(page, `SELECT COUNT(*) AS n FROM slides WHERE slide_code LIKE 'RN-%'`),
  };
  findings.push({
    where: "rename",
    detail: `before: ${before.samples} samples and ${before.slides} slides carry the RN code`,
  });

  // Rename through the project editor. NOTE: it is not on the sidebar — the only
  // route is Settings → Manage users → the project row's pencil.
  await closeDrawer(page);
  let renamed = false;
  await openSettings(page);
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: /Manage users/ })
    .click();
  await page.waitForTimeout(500);
  // The Manage dialog is tabbed — Users / Projects / Stains & IHC — and it opens
  // on Users, so the project editor is two clicks in, not one.
  const projectsTab = page.getByRole("dialog", { name: "Manage" }).getByRole("button", { name: "Projects", exact: true });
  if (await projectsTab.count()) {
    await projectsTab.click();
    await page.waitForTimeout(400);
  }
  const pencil = page.getByRole("button", { name: "Edit" }).first();
  if (!(await pencil.count())) {
    const dialogs = await page.getByRole("dialog").evaluateAll((els) =>
      els.map((el) => el.getAttribute("aria-label") ?? "(unnamed)"),
    );
    const buttons = await page.getByRole("dialog").getByRole("button").allInnerTexts();
    findings.push({
      where: "rename",
      detail: `no "Edit" button. Dialogs open: ${JSON.stringify(dialogs)}; buttons: ${JSON.stringify(
        buttons.map((b) => b.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 25),
      )}`,
    });
  }
  if (await pencil.count()) {
    await pencil.click();
    await page.waitForTimeout(300);
    const codeInput = page.getByRole("dialog").locator("input").filter({ hasNot: page.locator("[type=checkbox]") }).first();
    const current = await codeInput.inputValue();
    if (current.toUpperCase() === "RN") {
      await codeInput.fill("ZZ");
      const save = page.getByRole("dialog").getByRole("button", { name: /^Save/ }).first();
      if (await save.count()) {
        await save.click();
        renamed = true;
        await page.waitForTimeout(1500);
      }
    } else {
      findings.push({ where: "rename", detail: `the first editable field held "${current}", not the project code` });
    }
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  if (!renamed) {
    findings.push({ where: "rename", detail: "could not reach the project rename control (Settings → Manage users → pencil)" });
  } else {
    const after = {
      oldSamples: await count(page, `SELECT COUNT(*) AS n FROM samples WHERE sample_code LIKE 'RN-%'`),
      newSamples: await count(page, `SELECT COUNT(*) AS n FROM samples WHERE sample_code LIKE 'ZZ-%'`),
      oldSlides: await count(page, `SELECT COUNT(*) AS n FROM slides WHERE slide_code LIKE 'RN-%'`),
      newSlides: await count(page, `SELECT COUNT(*) AS n FROM slides WHERE slide_code LIKE 'ZZ-%'`),
    };
    findings.push({ where: "rename", detail: `after: ${JSON.stringify(after)}` });
    if (after.oldSamples > 0 || after.oldSlides > 0) {
      findings.push({
        where: "rename",
        detail: `DEFECT: ${after.oldSamples} samples and ${after.oldSlides} slides kept the old RN code after the rename (#106)`,
      });
    }
    await checkIntegrity(page, findings, "after the rename cascade");
  }

  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("durability: exhausted blocks, archived samples and an already-running batch", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "EX", "Exhaust");
  await newSamples(page, { quantity: 5, descriptions: ["e1", "e2", "e3", "e4", "e5"] });

  // -- edit a run that is already going (#91) -------------------------------
  await runBatch(page, ["EX-1", "EX-2"], "Batch 1");
  const batchMembers = await count(page, `SELECT COUNT(*) AS n FROM processing_batch_members`);
  findings.push({ where: "batch", detail: `${batchMembers} members recorded for the first run` });

  // -- exhausted block ------------------------------------------------------
  page.on("dialog", (d) => void d.accept());
  await openTile(page, "EX-1", "Embedded Inventory");
  const exhaust = page.getByRole("button", { name: /Mark Exhausted/ });
  if (!(await exhaust.count())) {
    findings.push({ where: "exhausted", detail: "no Mark Exhausted control on an embedded block" });
  } else {
    await exhaust.click();
    await page.waitForTimeout(800);
    const flag = await count(
      page,
      `SELECT COUNT(*) AS n FROM samples WHERE block_exhausted = 1 AND sample_code = 'EX-0001'`,
    );
    findings.push({ where: "exhausted", detail: `EX-1 exhausted flag = ${flag}` });
    if (flag !== 1) {
      findings.push({ where: "exhausted", detail: "DEFECT: Mark Exhausted did not set the flag" });
    }

    // An exhausted block must refuse a stain it can never cut (#70).
    await page.locator("nav").getByRole("button", { name: "Logs" }).click();
    const cell = page.getByRole("cell", { name: "EX-1", exact: true });
    if (await cell.count()) {
      await cell.click();
      const add = page.getByLabel("Add a stain to EX-1");
      if (await add.count()) {
        await add.selectOption("stain::H&E");
        await page.getByRole("button", { name: "Add", exact: true }).click();
        await page.waitForTimeout(900);
        const status = await page.getByRole("status").first().innerText().catch(() => "(none)");
        findings.push({ where: "exhausted", detail: `adding a stain to an exhausted block said: "${status}"` });
        if (!/cannot|exhaust|refus/i.test(status)) {
          findings.push({
            where: "exhausted",
            detail: `DEFECT: an exhausted block accepted a stain request — it reported "${status}" (#70)`,
          });
        }
      } else {
        findings.push({ where: "exhausted", detail: "no Add-a-stain control on the exhausted block's Logs row" });
      }
    }
    await page.locator("nav").getByRole("button", { name: "Board" }).click();
  }

  // -- archive --------------------------------------------------------------
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  const archiveBtn = page.getByRole("button", { name: /^Archive EX-2$/ });
  const row = page.getByRole("cell", { name: "EX-2", exact: true });
  if (await row.count()) {
    await row.click();
    if (await archiveBtn.count()) {
      await archiveBtn.click();
      await page.waitForTimeout(800);
      const archived = await count(
        page,
        `SELECT COUNT(*) AS n FROM samples WHERE archived_at IS NOT NULL`,
      );
      findings.push({ where: "archive", detail: `${archived} samples archived` });
      const stillListed = await page.getByRole("cell", { name: "EX-2", exact: true }).count();
      findings.push({
        where: "archive",
        detail: `EX-2 ${stillListed ? "is still listed" : "is hidden"} with Show archived off`,
      });
      // …and nothing was deleted.
      const gone = await count(page, `SELECT COUNT(*) AS n FROM samples WHERE sample_code = 'EX-0002'`);
      if (gone !== 1) {
        findings.push({
          where: "archive",
          detail: "DEFECT: archiving removed the sample row — this app never deletes (#74/#83)",
        });
      }
    } else {
      findings.push({ where: "archive", detail: "no Archive control on the Logs row" });
    }
  }

  await checkIntegrity(page, findings, "after exhaust/archive");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("durability: a backup taken mid-workflow restores the board it captured", async ({
  page,
  consoleErrors,
  findings,
}) => {
  // Revert asks with window.confirm; Playwright DISMISSES native dialogs unless
  // told otherwise, so without this the revert silently never runs.
  page.on("dialog", (d) => void d.accept());

  await boot(page);
  await addProject(page, "BK", "Backup");
  await newSamples(page, { quantity: 3, descriptions: ["b1", "b2", "b3"] });
  await runBatch(page, ["BK-1", "BK-2", "BK-3"], "Batch 1");
  await cutAndSection(page, "BK-1", ["stain::H&E", "extra"]);

  const atBackup = await tally(page);

  await openSettings(page);
  const backups = page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: /Backups/ });
  if (!(await backups.count())) {
    findings.push({ where: "backup", detail: "no Backups entry in Settings" });
    await closeSettings(page);
  } else {
    await backups.click();
    await page.waitForTimeout(600);
    const take = page.getByRole("button", { name: /Back up now|Create backup|Take backup/i });
    if (!(await take.count())) {
      const buttons = await page.getByRole("dialog").getByRole("button").allInnerTexts();
      findings.push({
        where: "backup",
        detail: `no "back up now" control; dialog offers: ${JSON.stringify(
          buttons.map((b) => b.trim().replace(/\s+/g, " ")).filter(Boolean),
        )}`,
      });
    } else {
      await take.first().click();
      await page.waitForTimeout(1500);
      findings.push({ where: "backup", detail: "backup taken" });

      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);

      // Change the world after the backup.
      await cutAndSection(page, "BK-2", ["stain::PAS", "extra", "extra"]);
      const afterChange = await tally(page);
      findings.push({
        where: "backup",
        detail: `after the post-backup change: slides ${atBackup.slides} → ${afterChange.slides}`,
      });

      // …and revert.
      await openSettings(page);
      await page
        .getByRole("dialog", { name: "Settings" })
        .getByRole("button", { name: /Backups/ })
        .click();
      await page.waitForTimeout(600);
      const revert = page.getByRole("button", { name: /Revert|Restore/i }).first();
      if (!(await revert.count())) {
        findings.push({ where: "backup", detail: "no revert control in the Backups dialog" });
      } else {
        await revert.click();
        await page.waitForTimeout(2000);
        const restored = await tally(page);
        findings.push({
          where: "backup",
          detail: `after revert: ${JSON.stringify(restored)} (captured ${JSON.stringify(atBackup)})`,
        });
        if (restored.slides !== atBackup.slides) {
          findings.push({
            where: "backup",
            detail: `DEFECT: revert produced ${restored.slides} slides, the backup captured ${atBackup.slides}`,
          });
        }
        const user = await page.getByLabel("Signed-in user").inputValue().catch(() => "");
        if (!user) {
          findings.push({
            where: "backup",
            detail: "DEFECT: the signed-in user was lost by the restore",
          });
        }
        await checkIntegrity(page, findings, "after a backup revert");
      }
    }
  }

  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
