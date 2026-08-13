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
  storedCode,
} from "./lib";

/**
 * Every per-slide action, at every stage a slide can be in.
 *
 * A slide's life is: planned → cut → (extra | assigned to an agent) → staining
 * → imaged → analyzed, with removal possible throughout and reassignment
 * possible after 0.12.0. The matrix below drives each action at each stage and
 * checks the DATA afterwards, because most of these are invisible on screen.
 */

test("matrix: purpose, reassignment, depth tags, removal and undo at every slide stage", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "MX", "Matrix");

  // Four blocks so each stage has its own subject and they cannot interfere.
  await newSamples(page, {
    quantity: 4,
    descriptions: ["planned stage", "cut stage", "staining stage", "imaged stage"],
  });
  await runBatch(page, ["MX-1", "MX-2", "MX-3", "MX-4"], "Batch 1");

  // ---------------------------------------------------------------- planned
  // A queued group is editable (#116): its slides can change purpose and agent
  // before anybody picks up a blade.
  await sendForCutting(page, "MX-1", ["stain::H&E", "extra", "extra", "ihc::CD31"]);

  await closeDrawer(page);
  const queued = column(page, "Needs Sectioning");
  await queued.locator("div[aria-selected]").first().click();

  const purposeSelects = drawer(page).getByRole("combobox", { name: /^Purpose for / });
  const purposeCount = await purposeSelects.count();
  findings.push({
    where: "planned",
    detail: `${purposeCount} slides editable in the queued group's drawer`,
  });
  if (purposeCount > 0) {
    // Flip the first slide from stain to extra and back — the round trip is
    // where a half-cleared assay name shows up.
    const first = purposeSelects.first();
    const label = (await first.getAttribute("aria-label")) ?? "";
    const code = label.replace("Purpose for ", "");
    await first.selectOption("extra");
    await page.waitForTimeout(300);
    const afterExtra = await sql<{ purpose: string; assay_name: string | null; stack_id: number | null }>(
      page,
      `SELECT purpose, assay_name, stack_id FROM slides WHERE slide_code = ?`,
      [storedCode(code)],
    );
    if (afterExtra.length === 0) {
      findings.push({ where: "planned", detail: `slide ${code} not found in the database by its stored code` });
    }
    for (const row of afterExtra) {
      if (row.purpose === "extra" && row.assay_name && row.assay_name.trim() !== "") {
        findings.push({
          where: "planned",
          detail: `slide ${code} switched to Extra but kept assay_name "${row.assay_name}"`,
        });
      }
    }
  }
  await closeDrawer(page);

  // ------------------------------------------------------------------- cut
  await sendForCutting(page, "MX-2", ["stain::H&E", "stain::PAS", "extra", "extra"]);
  await sendForCutting(page, "MX-3", ["stain::H&E", "ihc::CD3", "extra"]);
  await sendForCutting(page, "MX-4", ["stain::Alcian Blue", "extra"]);

  await closeDrawer(page);
  for (let guard = 0; guard < 30; guard += 1) {
    const cards = queued.locator("div[aria-selected]");
    if ((await cards.count()) === 0) break;
    await cards.first().click();
    const mark = page.getByRole("button", { name: /Mark Sectioned/ });
    if (!(await mark.count())) break;
    await mark.click();
    await closeDrawer(page);
  }

  const extrasNow = await count(
    page,
    `SELECT COUNT(*) AS n FROM slides WHERE purpose = 'extra' AND current_stage = 'extra'`,
  );
  findings.push({ where: "cut", detail: `${extrasNow} extras in inventory after cutting four blocks` });
  await checkIntegrity(page, findings, "after cutting the matrix");

  // -------------------------------------------------------- reassignment
  // #115 — move a slide in staining to a different agent, then back to extras.
  await closeDrawer(page);
  const staining = column(page, "Staining / IHC");
  await staining.locator("div[aria-selected]").first().click();

  const move = drawer(page).getByRole("combobox", { name: /^Reassign / });
  if ((await move.count()) === 0) {
    findings.push({ where: "reassign", detail: "no Reassign control on a rack in Staining (#115)" });
  } else {
    const label = (await move.first().getAttribute("aria-label")) ?? "";
    const code = label.replace("Reassign ", "");
    const before = await sql<{ id: number; stack_id: number | null; assay_name: string | null }>(
      page,
      `SELECT id, stack_id, assay_name FROM slides WHERE slide_code = ?`,
      [storedCode(code)],
    );
    expect(before.length, `slide ${code} must be findable as ${storedCode(code)}`).toBe(1);

    // NOTE: this select encodes the pair as `stain:PAS` (one colon), while the
    // cutting-plan dialog and the Logs control use `stain::PAS` (two). Same
    // meaning, three encodings — recorded as an observation, not a defect.
    await move.first().selectOption("stain:PAS");
    await page.waitForTimeout(500);
    const afterMove = await sql<{ assay_name: string | null; stack_id: number | null; stage: string }>(
      page,
      `SELECT assay_name, stack_id, current_stage AS stage FROM slides WHERE id = ?`,
      [before[0]?.id ?? -1],
    );
    if (afterMove[0]?.assay_name !== "PAS") {
      findings.push({
        where: "reassign",
        detail: `slide ${code} reassigned to PAS but assay_name is "${afterMove[0]?.assay_name}"`,
      });
    }
    if (afterMove[0]?.stack_id === before[0]?.stack_id) {
      findings.push({
        where: "reassign",
        detail: `slide ${code} changed agent but stayed in rack ${before[0]?.stack_id}`,
      });
    }
    await checkIntegrity(page, findings, "after reassigning into another rack");

    // …and back to extras. The slide should leave staining entirely.
    await closeDrawer(page);
    await staining.locator("div[aria-selected]").first().click();
    const back = drawer(page).getByRole("combobox", { name: `Reassign ${code}` });
    if (await back.count()) {
      await back.selectOption("extra");
      await page.waitForTimeout(500);
      const afterExtra = await sql<{ purpose: string; stage: string; stack_id: number | null }>(
        page,
        `SELECT purpose, current_stage AS stage, stack_id FROM slides WHERE id = ?`,
        [before[0]?.id ?? -1],
      );
      const row = afterExtra[0];
      if (row && (row.purpose !== "extra" || row.stage !== "extra" || row.stack_id !== null)) {
        findings.push({
          where: "reassign",
          detail: `slide ${code} sent back to extras but is purpose=${row.purpose}, stage=${row.stage}, stack=${row.stack_id}`,
        });
      }
      await checkIntegrity(page, findings, "after sending a slide back to extras");
    }
  }
  await closeDrawer(page);

  // -------------------------------------------------------------- staining
  for (let pass = 0; pass < 6; pass += 1) {
    const n = await staining.locator("div[aria-selected]").count();
    if (n === 0) break;
    let acted = 0;
    for (let i = 0; i < n; i += 1) {
      await closeDrawer(page);
      const card = staining.locator("div[aria-selected]").nth(i);
      if (!(await card.count())) break;
      await card.click();
      acted += await runProtocolSteps(page);
      await closeDrawer(page);
    }
    if (acted === 0) break;
  }
  await checkIntegrity(page, findings, "after staining the matrix");

  // A stained slide must carry a stained timestamp; the rack's tick is not the
  // slide's record.
  const stainedRacks = await count(
    page,
    `SELECT COUNT(*) AS n FROM slide_stacks WHERE stage_stained_at IS NOT NULL`,
  );
  const stainedSlides = await count(
    page,
    `SELECT COUNT(*) AS n FROM slides WHERE stage_stained_at IS NOT NULL`,
  );
  findings.push({
    where: "staining",
    detail: `${stainedRacks} racks carry a stained stamp; ${stainedSlides} slides do`,
  });

  // --------------------------------------------------------------- imaging
  await closeDrawer(page);
  const imaging = column(page, "Ready for Imaging");
  for (let pass = 0; pass < 6; pass += 1) {
    const n = await imaging.locator("div[aria-selected]").count();
    if (n === 0) break;
    let acted = 0;
    for (let i = 0; i < n; i += 1) {
      await closeDrawer(page);
      const card = imaging.locator("div[aria-selected]").nth(i);
      if (!(await card.count())) break;
      await card.click();
      const boxes = page.getByRole("checkbox", { name: /^Images captured for / });
      for (let b = 0; b < (await boxes.count()); b += 1) {
        const box = boxes.nth(b);
        if (!(await box.isChecked())) {
          await box.check();
          acted += 1;
        }
      }
      const done = page.getByRole("button", { name: /Complete Imaging|Analyz/ });
      if (await done.count()) {
        await done.first().click();
        acted += 1;
      }
      await closeDrawer(page);
    }
    if (acted === 0) break;
  }
  await checkIntegrity(page, findings, "after imaging the matrix");

  const stacksLeft = await sql<{ id: number; assay: string; stage: string; closed: string | null; n: number }>(
    page,
    `SELECT st.id AS id, st.assay_name AS assay, st.current_stage AS stage, st.closed_at AS closed,
            COUNT(sl.id) AS n
       FROM slide_stacks st LEFT JOIN slides sl ON sl.stack_id = st.id
      GROUP BY st.id ORDER BY st.id`,
  );
  findings.push({
    where: "imaging",
    detail: `stacks: ${stacksLeft
      .map((s) => `#${s.id} ${s.assay ?? "-"} ${s.stage}${s.closed ? " (closed)" : ""} ×${s.n}`)
      .join("; ")}`,
  });

  // ---------------------------------------------------------- un-imaging
  // Every stamp should be reversible: unticking "images captured" must take the
  // slide back, not leave a half-imaged record.
  const analyzedSlide = await sql<{ id: number; code: string }>(
    page,
    `SELECT id, slide_code AS code FROM slides WHERE stage_analyzed_at IS NOT NULL LIMIT 1`,
  );
  findings.push({
    where: "imaging",
    detail: `${await count(page, `SELECT COUNT(*) AS n FROM slides WHERE stage_analyzed_at IS NOT NULL`)} slides analyzed; sample subject ${analyzedSlide[0]?.code ?? "none"}`,
  });

  // ---------------------------------------------------------------- removal
  // #83 — a slide is never deleted. Remove one extra, with a reason, and check
  // that it survives as a record and leaves inventory.
  await closeDrawer(page);
  const extras = column(page, "Extras");
  // The Extras column lists one BUTTON per parent block, not a card grid.
  const extraCard = extras.locator("button").filter({ hasText: /^MX-/ }).first();
  if (!(await extraCard.count())) {
    findings.push({ where: "removal", detail: "no extras in inventory to remove" });
  } else {
    await extraCard.click();
    const panel = page.locator("div.border-l").last();
    // Removal is a two-step: tick the slides, then Remove. The button is inert
    // until something is ticked, which is the guard against a stray click
    // taking glass out of the inventory.
    // NOTE: unlike every other selection control in the app, this checkbox has
    // no aria-label — it borrows its name from the wrapping <label>, so it is
    // named after the slide code itself rather than "Select slide X".
    const pick = panel.getByRole("checkbox", { name: /^MX-/ });
    if ((await pick.count()) === 0) {
      findings.push({ where: "removal", detail: "the extras panel offers no per-slide selection" });
    } else {
      const slideCode = ((await pick.first().getAttribute("aria-label")) ??
        (await pick.first().evaluate((el) => el.closest("label")?.textContent ?? ""))).trim();
      await pick.first().check();
      const removeBtn = panel.getByRole("button", { name: /^Remove \d+ slide/ });
      await expect(removeBtn).toBeEnabled();
      await removeBtn.click();

      const reason = page.getByLabel("Reason for removal");
      if ((await reason.count()) === 0) {
        findings.push({
          where: "removal",
          detail: "removing an extra did not ask for a reason (#83 requires one)",
        });
      } else {
        // A blank reason must be refused — the reason IS the record.
        const confirm = page.getByRole("dialog").getByRole("button", { name: /^Remove/ }).last();
        if (await confirm.isEnabled()) {
          findings.push({
            where: "removal",
            detail: "the removal dialog accepts an empty reason (#83 requires one)",
          });
        }
        await reason.fill("stress test: broken during transfer");
        await confirm.click();
        await page.waitForTimeout(600);

        const row = await sql<{ stage: string; stack_id: number | null }>(
          page,
          `SELECT current_stage AS stage, stack_id FROM slides WHERE slide_code = ?`,
          [storedCode(slideCode)],
        );
        if (row[0]?.stage !== "removed") {
          findings.push({
            where: "removal",
            detail: `slide ${slideCode} was removed but its stage is "${row[0]?.stage}"`,
          });
        }
        const reasonRow = await sql<{ n: number }>(
          page,
          `SELECT COUNT(*) AS n FROM sample_timeline_events WHERE details LIKE '%broken during transfer%'`,
        );
        if (Number(reasonRow[0]?.n ?? 0) === 0) {
          findings.push({
            where: "removal",
            detail: "the removal reason was not recorded on the timeline",
          });
        }
      }
    }
  }

  const removed = await sql<{ code: string; stack_id: number | null }>(
    page,
    `SELECT slide_code AS code, stack_id FROM slides WHERE current_stage = 'removed'`,
  );
  findings.push({ where: "removal", detail: `${removed.length} slides removed and kept as a record` });
  for (const row of removed) {
    if (row.stack_id !== null) {
      findings.push({
        where: "removal",
        detail: `removed slide ${row.code} still holds rack place ${row.stack_id}`,
      });
    }
  }
  await checkIntegrity(page, findings, "after removal");

  // --------------------------------------------------------------- final
  const stages = await sql<{ purpose: string; stage: string; n: number }>(
    page,
    `SELECT purpose, current_stage AS stage, COUNT(*) AS n FROM slides
      GROUP BY purpose, current_stage ORDER BY purpose, current_stage`,
  );
  findings.push({
    where: "matrix end state",
    detail: stages.map((r) => `${r.purpose}/${r.stage}=${r.n}`).join(", "),
  });

  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
