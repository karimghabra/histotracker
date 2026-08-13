import {
  test,
  expect,
  sql,
  count,
  column,
  drawer,
  closeDrawer,
  boot,
  addProject,
  selectProject,
  newSamples,
  runBatch,
  sendForCutting,
  runProtocolSteps,
  checkIntegrity,
  storedCode,
} from "./lib";

/**
 * The consequences of a merge, rather than the merge itself.
 *
 * 03 establishes WHERE slides land. This asks what happens next: whether a
 * newcomer that merged into a part-finished stack can be swept through a step
 * it never had, whether the second protocol checkbox path guards the rack the
 * same way the first does, and whether pooling across projects keeps each
 * sample's slides straight when the rack scatters.
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

async function openRack(page: import("@playwright/test").Page, assay: string): Promise<boolean> {
  await closeDrawer(page);
  const card = column(page, "Staining / IHC")
    .locator("div[aria-selected]")
    .filter({ hasText: assay })
    .first();
  if ((await card.count()) === 0) return false;
  await card.click();
  return (await drawer(page).count()) > 0;
}

test("merge consequence: can a newcomer be swept through imaging it never had?", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "SW", "Sweep");
  await newSamples(page, { quantity: 2, descriptions: ["s1", "s2"] });
  await runBatch(page, ["SW-1", "SW-2"], "Batch 1");

  await cutAndSection(page, "SW-1", ["stain::H&E", "ihc::CD31", "extra"]);

  // H&E reaches imaging first; tick its images.
  expect(await openRack(page, "H&E")).toBe(true);
  await runProtocolSteps(page);
  await closeDrawer(page);

  const imaging = column(page, "Ready for Imaging");
  await imaging.locator("div[aria-selected]").first().click();
  const boxes = page.getByRole("checkbox", { name: /^Images captured for / });
  for (let i = 0; i < (await boxes.count()); i += 1) {
    const box = boxes.nth(i);
    if (!(await box.isChecked())) await box.check();
  }
  await page.waitForTimeout(300);
  await closeDrawer(page);

  // CD31 now scatters into the SAME per-sample stack, unimaged.
  expect(await openRack(page, "CD31")).toBe(true);
  await runProtocolSteps(page);
  await closeDrawer(page);

  const before = await sql<{ id: number; n: number; imaged: number }>(
    page,
    `SELECT st.id AS id, COUNT(sl.id) AS n,
            SUM(CASE WHEN sl.stage_pictures_taken_at IS NOT NULL THEN 1 ELSE 0 END) AS imaged
       FROM slide_stacks st JOIN slides sl ON sl.stack_id = st.id
      WHERE st.kind = 'sample' AND st.closed_at IS NULL GROUP BY st.id`,
  );
  findings.push({
    where: "sweep",
    detail: `stack before Complete Imaging: ${before
      .map((s) => `#${s.id} ${s.imaged}/${s.n} imaged`)
      .join(", ")}`,
  });

  // THE QUESTION: with one slide imaged and one not, is Complete Imaging still
  // offered — and does it drag the unimaged slide through to analyzed?
  await imaging.locator("div[aria-selected]").first().click();
  const complete = page.getByRole("button", { name: /Complete Imaging|Analyz/ });
  const offered = (await complete.count()) > 0;
  const enabled = offered ? await complete.first().isEnabled() : false;
  findings.push({
    where: "sweep",
    detail: `with an unimaged slide in the stack, Complete Imaging is ${
      offered ? (enabled ? "offered and ENABLED" : "offered but disabled") : "not offered"
    }`,
  });

  // Per-slide evidence, so the report can name the glass.
  const perSlideBefore = await sql<{ code: string; imaged: string | null; analyzed: string | null }>(
    page,
    `SELECT sl.slide_code AS code, sl.stage_pictures_taken_at AS imaged,
            sl.stage_analyzed_at AS analyzed
       FROM slides sl JOIN slide_stacks st ON st.id = sl.stack_id
      WHERE st.kind = 'sample' AND st.closed_at IS NULL ORDER BY sl.slide_code`,
  );
  findings.push({
    where: "sweep",
    detail: `per-slide BEFORE: ${perSlideBefore
      .map((s) => `${s.code} images=${s.imaged ? "yes" : "NO"}`)
      .join(", ")}`,
  });

  if (offered && enabled) {
    await complete.first().click();
    await page.waitForTimeout(600);

    const perSlideAfter = await sql<{ code: string; imaged: string | null; analyzed: string | null }>(
      page,
      `SELECT slide_code AS code, stage_pictures_taken_at AS imaged, stage_analyzed_at AS analyzed
         FROM slides WHERE slide_code IN (${perSlideBefore.map(() => "?").join(",")})
        ORDER BY slide_code`,
      perSlideBefore.map((s) => s.code),
    );
    findings.push({
      where: "sweep",
      detail: `per-slide AFTER: ${perSlideAfter
        .map((s) => `${s.code} images=${s.imaged ? "yes" : "NO"} analyzed=${s.analyzed ? "yes" : "NO"}`)
        .join(", ")}`,
    });
    const backfilled = perSlideBefore
      .filter((b) => !b.imaged)
      .filter((b) => perSlideAfter.find((a) => a.code === b.code)?.imaged);
    if (backfilled.length > 0) {
      findings.push({
        where: "sweep",
        detail:
          `DEFECT: Complete Imaging back-filled an images-captured stamp onto ${backfilled.length} ` +
          `slide(s) that were never ticked (${backfilled.map((s) => s.code).join(", ")}). ` +
          `They merged into a per-sample stack AFTER its imaging session, so the record now ` +
          `asserts photographs that were never taken.`,
      });
    }
    const swept = await sql<{ code: string; imaged: string | null; analyzed: string | null }>(
      page,
      `SELECT slide_code AS code, stage_pictures_taken_at AS imaged, stage_analyzed_at AS analyzed
         FROM slides WHERE stage_analyzed_at IS NOT NULL AND stage_pictures_taken_at IS NULL`,
    );
    if (swept.length > 0) {
      findings.push({
        where: "sweep",
        detail:
          `DEFECT: ${swept.length} slide(s) are recorded as ANALYZED with no images ever taken ` +
          `(${swept.map((s) => s.code).join(", ")}). They merged into a per-sample stack that was ` +
          `already imaged, and Complete Imaging advanced the whole stack.`,
      });
    } else {
      findings.push({
        where: "sweep",
        detail: "Complete Imaging did not analyze the unimaged newcomer",
      });
    }
    const stillOpen = await sql<{ id: number; n: number; imaged: number; closed: string | null }>(
      page,
      `SELECT st.id AS id, st.closed_at AS closed, COUNT(sl.id) AS n,
              SUM(CASE WHEN sl.stage_pictures_taken_at IS NOT NULL THEN 1 ELSE 0 END) AS imaged
         FROM slide_stacks st JOIN slides sl ON sl.stack_id = st.id
        WHERE st.kind = 'sample' GROUP BY st.id`,
    );
    findings.push({
      where: "sweep",
      detail: `stacks after: ${stillOpen
        .map((s) => `#${s.id} ${s.imaged}/${s.n} imaged${s.closed ? " closed" : ""}`)
        .join(", ")}`,
    });
  }

  await checkIntegrity(page, findings, "after the sweep test");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("merge: the cut-group checkbox path guards the loading rack too", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "CG", "CutGroup");
  await newSamples(page, { quantity: 3, descriptions: ["g1", "g2", "g3"] });
  await runBatch(page, ["CG-1", "CG-2", "CG-3"], "Batch 1");

  await cutAndSection(page, "CG-1", ["stain::H&E", "extra"]);

  // There are TWO sets of protocol checkboxes: the rack drawer's, and a second
  // set in the CUT GROUP drawer. #81 was reported twice because the first fix
  // only closed the rack path. Drive the cut-group path here.
  await closeDrawer(page);
  const groupCard = column(page, "Staining / IHC").locator("div[aria-selected]").first();
  const usedRackDrawer = await groupCard.count();
  let steppedVia = "none";
  if (usedRackDrawer) {
    await groupCard.click();
    const op = page.getByLabel("Active operator");
    if (await op.count()) await op.fill("Alex");
    const step = drawer(page).locator("ol li button:not(:has(svg.lucide-check))").first();
    if (await step.count()) {
      await step.click();
      steppedVia = "rack drawer";
      await page.waitForTimeout(400);
    }
    await closeDrawer(page);
  }
  findings.push({ where: "cut-group path", detail: `first step ticked via: ${steppedVia}` });

  await cutAndSection(page, "CG-2", ["stain::H&E", "extra"]);
  const racksNow = await sql<{ id: number; n: number; worked: number }>(
    page,
    `SELECT st.id AS id, COUNT(sl.id) AS n,
            SUM(CASE WHEN sl.stage_stained_at IS NOT NULL THEN 1 ELSE 0 END) AS worked
       FROM slide_stacks st JOIN slides sl ON sl.stack_id = st.id
      WHERE st.assay_name = 'H&E' AND st.closed_at IS NULL GROUP BY st.id ORDER BY st.id`,
  );
  findings.push({
    where: "cut-group path",
    detail: `H&E racks after a worked rack met a newcomer: ${racksNow
      .map((r) => `#${r.id} ×${r.n} (${r.worked} worked)`)
      .join(", ")}`,
  });
  const mixed = racksNow.find((r) => Number(r.worked) > 0 && Number(r.worked) < Number(r.n));
  if (mixed) {
    findings.push({
      where: "cut-group path",
      detail: `rack #${mixed.id} mixes ${mixed.worked} stained with ${
        Number(mixed.n) - Number(mixed.worked)
      } unstained slides`,
    });
  }

  await checkIntegrity(page, findings, "after the cut-group path test");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("merge: a rack pooled across two projects scatters back to the right samples", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "AA", "Alpha");
  await addProject(page, "BB", "Beta");

  await selectProject(page, "Alpha");
  await newSamples(page, { quantity: 2, descriptions: ["a1", "a2"] });
  await selectProject(page, "Beta");
  await newSamples(page, { quantity: 2, descriptions: ["b1", "b2"] });

  await selectProject(page, "Alpha");
  await runBatch(page, ["AA-1", "AA-2"], "Batch 1");
  await selectProject(page, "Beta");
  await runBatch(page, ["BB-1", "BB-2"], "Batch 2");

  // Four blocks from two projects, all asking for H&E → one rack.
  await selectProject(page, "Alpha");
  await cutAndSection(page, "AA-1", ["stain::H&E", "extra"]);
  await cutAndSection(page, "AA-2", ["stain::H&E"]);
  await selectProject(page, "Beta");
  await cutAndSection(page, "BB-1", ["stain::H&E", "extra"]);
  await cutAndSection(page, "BB-2", ["stain::H&E"]);

  const pooled = await sql<{ id: number; n: number; projects: number }>(
    page,
    `SELECT st.id AS id, COUNT(sl.id) AS n, COUNT(DISTINCT s.project_id) AS projects
       FROM slide_stacks st
       JOIN slides sl ON sl.stack_id = st.id
       JOIN section_requests sr ON sr.id = sl.section_request_id
       JOIN samples s ON s.id = sr.sample_id
      WHERE st.assay_name = 'H&E' AND st.closed_at IS NULL GROUP BY st.id`,
  );
  findings.push({
    where: "cross-project pooling",
    detail: `H&E racks: ${pooled.map((r) => `#${r.id} ×${r.n} across ${r.projects} project(s)`).join(", ")}`,
  });
  expect(pooled.length, "four fresh H&E slides from two projects pool into one rack").toBe(1);
  expect(Number(pooled[0].projects), "the rack is genuinely cross-project").toBe(2);

  // Scatter it. Each SAMPLE must get its own imaging stack — four of them.
  expect(await openRack(page, "H&E")).toBe(true);
  await runProtocolSteps(page);
  await closeDrawer(page);

  const scattered = await sql<{ id: number; sample_id: number; n: number; samples: number }>(
    page,
    `SELECT st.id AS id, st.sample_id AS sample_id, COUNT(sl.id) AS n,
            COUNT(DISTINCT sr.sample_id) AS samples
       FROM slide_stacks st
       JOIN slides sl ON sl.stack_id = st.id
       JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE st.kind = 'sample' AND st.closed_at IS NULL GROUP BY st.id ORDER BY st.id`,
  );
  findings.push({
    where: "cross-project pooling",
    detail: `after the scatter: ${scattered
      .map((s) => `#${s.id} (sample ${s.sample_id}) ×${s.n} from ${s.samples} sample(s)`)
      .join("; ")}`,
  });

  for (const stack of scattered) {
    if (Number(stack.samples) !== 1) {
      findings.push({
        where: "cross-project pooling",
        detail: `DEFECT: per-sample stack #${stack.id} holds slides from ${stack.samples} different samples`,
      });
    }
    const mismatched = await count(
      page,
      `SELECT COUNT(*) AS n FROM slides sl
         JOIN section_requests sr ON sr.id = sl.section_request_id
        WHERE sl.stack_id = ? AND sr.sample_id <> ?`,
      [stack.id, stack.sample_id],
    );
    if (mismatched > 0) {
      findings.push({
        where: "cross-project pooling",
        detail: `DEFECT: stack #${stack.id} is labelled sample ${stack.sample_id} but holds ${mismatched} slide(s) from another sample`,
      });
    }
  }
  expect(scattered.length, "four samples get four imaging stacks").toBe(4);

  await checkIntegrity(page, findings, "after the cross-project scatter");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("merge: undo of a merge puts the racks back the way they were", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "UN", "Undo");
  await newSamples(page, { quantity: 3, descriptions: ["u1", "u2", "u3"] });
  await runBatch(page, ["UN-1", "UN-2", "UN-3"], "Batch 1");

  await cutAndSection(page, "UN-1", ["stain::H&E", "extra"]);
  await cutAndSection(page, "UN-2", ["stain::PAS", "extra"]);

  const before = await sql<{ id: number; assay: string; n: number }>(
    page,
    `SELECT st.id AS id, st.assay_name AS assay, COUNT(sl.id) AS n
       FROM slide_stacks st JOIN slides sl ON sl.stack_id = st.id
      WHERE st.closed_at IS NULL GROUP BY st.id ORDER BY st.id`,
  );

  // Move the H&E slide into the PAS rack, then undo.
  expect(await openRack(page, "H&E")).toBe(true);
  const move = drawer(page).getByRole("combobox", { name: /^Reassign / });
  const label = (await move.first().getAttribute("aria-label")) ?? "";
  const code = label.replace("Reassign ", "");
  await move.first().selectOption("stain:PAS");
  await page.waitForTimeout(600);
  await closeDrawer(page);

  const merged = await sql<{ stack_id: number; assay: string }>(
    page,
    `SELECT stack_id, assay_name AS assay FROM slides WHERE slide_code = ?`,
    [storedCode(code)],
  );

  await page.getByTitle("Undo (Ctrl+Z)").click({ force: true });
  await page.waitForTimeout(900);

  const after = await sql<{ id: number; assay: string; n: number }>(
    page,
    `SELECT st.id AS id, st.assay_name AS assay, COUNT(sl.id) AS n
       FROM slide_stacks st JOIN slides sl ON sl.stack_id = st.id
      WHERE st.closed_at IS NULL GROUP BY st.id ORDER BY st.id`,
  );
  const restored = await sql<{ stack_id: number; assay: string }>(
    page,
    `SELECT stack_id, assay_name AS assay FROM slides WHERE slide_code = ?`,
    [storedCode(code)],
  );

  findings.push({
    where: "undo of a merge",
    detail:
      `before: ${before.map((r) => `#${r.id} ${r.assay} ×${r.n}`).join(", ")} | ` +
      `merged into stack ${merged[0]?.stack_id} as ${merged[0]?.assay} | ` +
      `after undo: ${after.map((r) => `#${r.id} ${r.assay} ×${r.n}`).join(", ")} ` +
      `(slide back in stack ${restored[0]?.stack_id} as ${restored[0]?.assay})`,
  });

  if (restored[0]?.assay !== "H&E") {
    findings.push({
      where: "undo of a merge",
      detail: `DEFECT: undo left the slide assigned to ${restored[0]?.assay}, not H&E`,
    });
  }
  const sameShape =
    before.length === after.length &&
    before.every((b, i) => after[i]?.assay === b.assay && Number(after[i]?.n) === Number(b.n));
  if (!sameShape) {
    findings.push({
      where: "undo of a merge",
      detail: "DEFECT: the racks did not return to their pre-merge shape after undo",
    });
  }

  await checkIntegrity(page, findings, "after undoing a merge");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
