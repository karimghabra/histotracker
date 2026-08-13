import {
  test,
  expect,
  sql,
  count,
  column,
  drawer,
  closeDrawer,
  openTile,
  dragOnto,
  boot,
  addProject,
  selectProject,
  newSamples,
  runBatch,
  sendForCutting,
  markSectioned,
  runProtocolSteps,
  checkIntegrity,
  tally,
} from "./lib";

/**
 * Fill the board up and drive the whole pipeline, three projects at once.
 *
 * The point is volume and variety, not one assertion: bulk intake, mixed Short
 * and Long protocols, blocks that share a run, blocks cut into different
 * mixtures of stains / IHC / extras, racks that pool slides from several
 * blocks, imaging and analysis, and the database checked for orphans at every
 * junction.
 */

test("fill: three projects, bulk intake, full pipeline, integrity at every junction", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);

  // -- Intake ---------------------------------------------------------------
  await addProject(page, "EE", "Enthesis Engineering");
  await addProject(page, "OG", "Osteogenesis");
  await addProject(page, "CT", "Cartilage Repair");

  // OG and CT are created first so EE ends up selected last; each project
  // numbers its own samples, which is the thing that most often goes wrong.
  await selectProject(page, "Osteogenesis");
  await newSamples(page, {
    quantity: 6,
    descriptions: ["og one", "og two", "og three", "og four", "og five", "og six"],
  });
  await selectProject(page, "Cartilage Repair");
  await newSamples(page, { quantity: 4, description: "shared ct", descriptions: ["", "", "", ""] });
  await selectProject(page, "Enthesis Engineering");
  await newSamples(page, {
    quantity: 8,
    descriptions: Array.from({ length: 8 }, (_, i) => `ee block ${i + 1}`),
  });

  expect(await count(page, "SELECT COUNT(*) AS n FROM projects")).toBe(3);
  expect(await count(page, "SELECT COUNT(*) AS n FROM samples")).toBe(18);

  // Each project numbers from 1 — a shared counter would show up here.
  const perProject = await sql<{ code: string; n: number; lo: string; hi: string }>(
    page,
    `SELECT p.code AS code, COUNT(*) AS n, MIN(s.sample_code) AS lo, MAX(s.sample_code) AS hi
       FROM samples s JOIN projects p ON p.id = s.project_id GROUP BY p.code ORDER BY p.code`,
  );
  expect(perProject.map((r) => `${r.code}:${r.n}`)).toEqual(["CT:4", "EE:8", "OG:6"]);
  for (const row of perProject) expect(row.lo.endsWith("1")).toBe(true);

  // #88 — nothing may be created without a description.
  const blank = await count(
    page,
    `SELECT COUNT(*) AS n FROM samples WHERE sample_description IS NULL OR TRIM(sample_description) = ''`,
  );
  if (blank > 0) {
    findings.push({ where: "intake", detail: `${blank} samples created with an empty description (#88)` });
  }

  await checkIntegrity(page, findings, "after intake");

  // -- Processing -----------------------------------------------------------
  // One run of five, one run of three: two batches alive at once, which is the
  // case the processor column was rebuilt for.
  await runBatch(page, ["EE-1", "EE-2", "EE-3", "EE-4", "EE-5"], "Batch 1");
  await runBatch(page, ["EE-6", "EE-7", "EE-8"], "Batch 2");

  expect(await count(page, "SELECT COUNT(*) AS n FROM processing_batches")).toBe(2);
  const embedded = await count(
    page,
    `SELECT COUNT(*) AS n FROM samples WHERE current_stage = 'embedded'`,
  );
  expect(embedded).toBe(8);
  await checkIntegrity(page, findings, "after processing");

  // -- Cutting --------------------------------------------------------------
  // A different plan per block: pure extras, pure stains, mixtures, IHC, and
  // one large plan. Every combination has to survive the same code path.
  const plans: Record<string, string[]> = {
    "EE-1": ["extra", "extra", "extra"],
    "EE-2": ["stain::H&E"],
    "EE-3": ["stain::H&E", "stain::H&E", "extra"],
    "EE-4": ["ihc::CD31", "ihc::CD3", "extra", "extra"],
    "EE-5": ["stain::PAS", "ihc::Ki-67", "extra"],
    "EE-6": ["stain::Masson's Trichrome", "extra"],
    "EE-7": Array.from({ length: 8 }, (_, i) => (i % 2 ? "extra" : "stain::Safranin O")),
    "EE-8": ["stain::Alcian Blue", "stain::Alcian Blue", "ihc::α-SMA", "extra"],
  };
  for (const [code, plan] of Object.entries(plans)) {
    await sendForCutting(page, code, plan);
  }

  const slideTotal = await count(page, "SELECT COUNT(*) AS n FROM slides");
  const planned = Object.values(plans).reduce((n, p) => n + p.length, 0);
  expect(slideTotal).toBe(planned);
  await checkIntegrity(page, findings, "after cutting");

  // Every block should now be waiting in Needs Sectioning, and NOT yet cut:
  // the plan is not the cut (#95/#118).
  const uncut = await count(
    page,
    `SELECT COUNT(*) AS n FROM slides WHERE stage_cut_at IS NOT NULL`,
  );
  if (uncut > 0) {
    findings.push({
      where: "after cutting",
      detail: `${uncut} slides carry a cut timestamp while their group is still queued (#95/#118)`,
    });
  }

  // -- Sectioning -----------------------------------------------------------
  const groups = await sql<{ id: number; code: string; n: number }>(
    page,
    `SELECT sr.id AS id, s.sample_code AS code, COUNT(sl.id) AS n
       FROM section_requests sr JOIN samples s ON s.id = sr.sample_id
       LEFT JOIN slides sl ON sl.section_request_id = sr.id
      GROUP BY sr.id ORDER BY sr.id`,
  );
  findings.push({
    where: "after cutting",
    detail: `${groups.length} cut groups created for 8 blocks (a block splits one plan into one group per agent)`,
  });

  // Mark every queued card sectioned, whatever it is called.
  await closeDrawer(page);
  const needs = column(page, "Needs Sectioning");
  for (let guard = 0; guard < 40; guard += 1) {
    const cards = needs.locator("div[aria-selected]");
    if ((await cards.count()) === 0) break;
    await cards.first().click();
    const mark = page.getByRole("button", { name: /Mark Sectioned/ });
    if (!(await mark.count())) {
      findings.push({ where: "sectioning", detail: "a Needs Sectioning card offers no Mark Sectioned" });
      await closeDrawer(page);
      break;
    }
    await mark.click();
    await closeDrawer(page);
  }
  await expect(needs.locator("div[aria-selected]")).toHaveCount(0, { timeout: 30_000 });

  const cutNow = await count(page, `SELECT COUNT(*) AS n FROM slides WHERE stage_cut_at IS NOT NULL`);
  expect(cutNow).toBe(slideTotal);
  await checkIntegrity(page, findings, "after sectioning");

  // Racks pool by agent across blocks: two blocks asking for Alcian Blue share
  // one rack. Assert that rather than assuming a rack per block.
  const racks = await sql<{ id: number; assay: string; n: number }>(
    page,
    `SELECT st.id AS id, st.assay_name AS assay, COUNT(sl.id) AS n
       FROM slide_stacks st LEFT JOIN slides sl ON sl.stack_id = st.id
      WHERE st.closed_at IS NULL GROUP BY st.id ORDER BY st.id`,
  );
  for (const rack of racks) {
    if (rack.n === 0) {
      findings.push({ where: "sectioning", detail: `open rack ${rack.id} (${rack.assay}) holds no slides` });
    }
  }

  // -- Staining -------------------------------------------------------------
  // Walk every rack by index rather than always taking the first: a rack that
  // cannot be advanced must not stall the ones behind it, and "which rack" is
  // the thing worth reporting.
  await closeDrawer(page);
  const staining = column(page, "Staining / IHC");
  const racksSeen = new Set<string>();
  for (let pass = 0; pass < 6; pass += 1) {
    const cards = staining.locator("div[aria-selected]");
    const n = await cards.count();
    if (n === 0) break;
    let advanced = 0;
    for (let i = 0; i < n; i += 1) {
      await closeDrawer(page);
      const card = staining.locator("div[aria-selected]").nth(i);
      if (!(await card.count())) break;
      const label = (await card.innerText()).split("\n")[0];
      await card.click();
      const acted = (await runProtocolSteps(page)) > 0;
      if (!acted && !racksSeen.has(label)) {
        racksSeen.add(label);
        const buttons = await drawer(page).getByRole("button").allInnerTexts();
        findings.push({
          where: "staining",
          detail: `rack "${label}" offers no protocol step; drawer buttons: ${JSON.stringify(
            buttons.map((b) => b.trim()).filter(Boolean),
          )}`,
        });
      }
      if (acted) advanced += 1;
      await closeDrawer(page);
    }
    if (advanced === 0) break;
  }

  const stuck = await sql<{ id: number; assay: string; stage: string; n: number }>(
    page,
    `SELECT st.id AS id, st.assay_name AS assay, st.current_stage AS stage, COUNT(sl.id) AS n
       FROM slide_stacks st LEFT JOIN slides sl ON sl.stack_id = st.id
      WHERE st.closed_at IS NULL AND st.current_stage NOT IN ('ready_for_imaging','pictures_taken','analyzed')
      GROUP BY st.id`,
  );
  for (const rack of stuck) {
    findings.push({
      where: "staining",
      detail: `rack ${rack.id} (${rack.assay}) left at stage "${rack.stage}" with ${rack.n} slides`,
    });
  }

  await checkIntegrity(page, findings, "after staining");
  const stainedNoCut = await count(
    page,
    `SELECT COUNT(*) AS n FROM slides WHERE stage_stained_at IS NOT NULL AND stage_cut_at IS NULL`,
  );
  expect(stainedNoCut).toBe(0);

  // -- Imaging and analysis -------------------------------------------------
  await closeDrawer(page);
  const imaging = column(page, "Ready for Imaging");
  const stacks = imaging.locator("div[aria-selected]");
  const stackCount = await stacks.count();
  findings.push({ where: "imaging", detail: `${stackCount} stacks reached Ready for Imaging` });

  for (let pass = 0; pass < 6; pass += 1) {
    const n = await imaging.locator("div[aria-selected]").count();
    if (n === 0) break;
    let acted = 0;
    for (let i = 0; i < n; i += 1) {
      await closeDrawer(page);
      const card = imaging.locator("div[aria-selected]").nth(i);
      if (!(await card.count())) break;
      const label = (await card.innerText()).split("\n")[0];
      await card.click();

      const boxes = page.getByRole("checkbox", { name: /^Images captured for / });
      const boxCount = await boxes.count();
      for (let b = 0; b < boxCount; b += 1) {
        const box = boxes.nth(b);
        if (!(await box.isChecked())) {
          await box.check();
          acted += 1;
        }
      }

      const analyzed = page.getByRole("button", { name: /Complete Imaging|Analyz/ });
      if ((await analyzed.count()) && (await analyzed.first().isEnabled())) {
        await analyzed.first().click();
        acted += 1;
      } else if (pass === 0) {
        const buttons = await drawer(page).getByRole("button").allInnerTexts();
        findings.push({
          where: "imaging",
          detail: `stack "${label}" (${boxCount} slides) offers no imaging completion; drawer buttons: ${JSON.stringify(
            buttons.map((b) => b.trim().replace(/\s+/g, " ")).filter(Boolean),
          )}`,
        });
      }
      await closeDrawer(page);
    }
    if (acted === 0) break;
  }

  await checkIntegrity(page, findings, "after imaging");

  // Where did every slide actually end up? A slide that never reaches imaging
  // is not necessarily wrong — an extra is inventory, not an assay — but an
  // ASSAY slide that stalls is.
  const byStage = await sql<{ purpose: string; stage: string; n: number }>(
    page,
    `SELECT purpose, current_stage AS stage, COUNT(*) AS n FROM slides
      GROUP BY purpose, current_stage ORDER BY purpose, current_stage`,
  );
  findings.push({
    where: "end state",
    detail: `slides by purpose/stage: ${byStage.map((r) => `${r.purpose}/${r.stage}=${r.n}`).join(", ")}`,
  });

  const imagedNotAnalyzed = await count(
    page,
    `SELECT COUNT(*) AS n FROM slides
      WHERE stage_pictures_taken_at IS NOT NULL AND stage_analyzed_at IS NULL`,
  );
  if (imagedNotAnalyzed > 0) {
    findings.push({
      where: "end state",
      detail: `${imagedNotAnalyzed} slides were imaged but never analyzed after Analyze was pressed on every stack`,
    });
  }

  const assayStalled = await count(
    page,
    `SELECT COUNT(*) AS n FROM slides
      WHERE purpose = 'stain' AND current_stage <> 'removed' AND stage_pictures_taken_at IS NULL`,
  );
  if (assayStalled > 0) {
    findings.push({
      where: "end state",
      detail: `${assayStalled} assay slides never reached imaging`,
    });
  }

  // The timeline is the posterity record. Which events did a full pipeline
  // actually write?
  const events = await sql<{ event_type: string; n: number }>(
    page,
    `SELECT event_type, COUNT(*) AS n FROM sample_timeline_events GROUP BY event_type ORDER BY n DESC`,
  );
  findings.push({
    where: "end state",
    detail: `timeline events written: ${
      events.map((e) => `${e.event_type}×${e.n}`).join(", ") || "none"
    }`,
  });

  const final = await tally(page);
  findings.push({ where: "totals", detail: JSON.stringify(final) });

  // The console must have stayed clean through all of it.
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
