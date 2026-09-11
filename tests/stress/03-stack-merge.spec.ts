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
  newSamples,
  runBatch,
  sendForCutting,
  runProtocolSteps,
  checkIntegrity,
  storedCode,
} from "./lib";
import { rackSlideCodes, reassignFirstInRack, reassignInRack } from "../helpers/rack";

/**
 * How slides merge with EXISTING stacks.
 *
 * Two different merges happen in this app and they are governed by different
 * rules, which is the interesting part:
 *
 *  - **The loading rack** (`getOpenStainRack`): slides for the same agent pool
 *    into one cross-sample rack. #81 hardened this so a rack that has started
 *    its protocol can never absorb a newcomer — the guard reads the SLIDES, so
 *    it holds whichever of the two checkbox paths did the work.
 *  - **The per-sample stack** (`getOpenSampleStack`): when a rack scatters at
 *    imaging, each sample's slides converge into one stack per sample per
 *    stage. This one matches on (sample, stage, open) and has NO equivalent
 *    "untouched" guard.
 *
 * Everything below drives real merges through the UI and then reads the
 * database, because a merge is invisible until it has already happened.
 */

/** Open racks, with their member counts and whether any member is worked. */
async function racks(page: import("@playwright/test").Page) {
  return sql<{
    id: number;
    kind: string;
    assay: string | null;
    sample_id: number | null;
    stage: string;
    closed: string | null;
    n: number;
    worked: number;
  }>(
    page,
    `SELECT st.id AS id, st.kind AS kind, st.assay_name AS assay, st.sample_id AS sample_id,
            st.current_stage AS stage, st.closed_at AS closed,
            COUNT(sl.id) AS n,
            SUM(CASE WHEN sl.stage_stained_at IS NOT NULL
                       OR sl.stage_coverslipped_at IS NOT NULL
                       OR sl.stage_pictures_taken_at IS NOT NULL THEN 1 ELSE 0 END) AS worked
       FROM slide_stacks st LEFT JOIN slides sl ON sl.stack_id = st.id
      GROUP BY st.id ORDER BY st.id`,
  );
}

const openRacksFor = async (page: import("@playwright/test").Page, assay: string) =>
  count(
    page,
    `SELECT COUNT(*) AS n FROM slide_stacks
      WHERE kind = 'stain' AND assay_name = ? AND closed_at IS NULL`,
    [assay],
  );

/** Cut a block and immediately mark its queued groups sectioned. */
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

/** Open a staining rack by the agent name shown on its card. */
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

test("merge: loading racks pool by agent, and stop accepting the moment work starts", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "MG", "Merge");
  await newSamples(page, {
    quantity: 6,
    descriptions: ["m1", "m2", "m3", "m4", "m5", "m6"],
  });
  await runBatch(page, ["MG-1", "MG-2", "MG-3"], "Batch 1");
  await runBatch(page, ["MG-4", "MG-5", "MG-6"], "Batch 2");

  // -- A. two blocks, same agent, same moment → ONE rack ---------------------
  await cutAndSection(page, "MG-1", ["stain::H&E", "extra"]);
  await cutAndSection(page, "MG-2", ["stain::H&E", "extra"]);

  expect(await openRacksFor(page, "H&E"), "two fresh H&E slides must pool into one rack").toBe(1);
  const pooled = await count(
    page,
    `SELECT COUNT(*) AS n FROM slides sl JOIN slide_stacks st ON st.id = sl.stack_id
      WHERE st.assay_name = 'H&E' AND st.closed_at IS NULL`,
  );
  expect(pooled, "both H&E slides are in the one rack").toBe(2);
  findings.push({ where: "A pooling", detail: `1 H&E rack holding ${pooled} slides from 2 blocks` });

  // The rack must be cross-sample, i.e. a stain rack, not a per-sample stack.
  const kind = await sql<{ kind: string; sample_id: number | null }>(
    page,
    `SELECT kind, sample_id FROM slide_stacks WHERE assay_name = 'H&E' AND closed_at IS NULL`,
  );
  expect(kind[0]?.kind).toBe("stain");

  // -- B. start the protocol, then send a third block to the same agent -----
  // #81: a rack that has begun work must never absorb a newcomer.
  expect(await openRack(page, "H&E")).toBe(true);
  const firstStep = drawer(page).locator("ol li button:not(:has(svg.lucide-check))").first();
  await firstStep.click();
  await page.waitForTimeout(400);
  await closeDrawer(page);

  await cutAndSection(page, "MG-3", ["stain::H&E", "extra"]);
  const racksAfter = await openRacksFor(page, "H&E");
  if (racksAfter !== 2) {
    findings.push({
      where: "B mid-protocol",
      detail: `after ticking a step, a third H&E slide should get a FRESH rack — expected 2 open H&E racks, found ${racksAfter} (#81)`,
    });
  }
  expect(racksAfter, "a part-stained rack must not absorb a newcomer (#81)").toBe(2);

  // …and the newcomer must be alone, not silently joined to the worked rack.
  const perRack = await sql<{ id: number; n: number; worked: number }>(
    page,
    `SELECT st.id AS id, COUNT(sl.id) AS n,
            SUM(CASE WHEN sl.stage_stained_at IS NOT NULL THEN 1 ELSE 0 END) AS worked
       FROM slide_stacks st JOIN slides sl ON sl.stack_id = st.id
      WHERE st.assay_name = 'H&E' AND st.closed_at IS NULL GROUP BY st.id ORDER BY st.id`,
  );
  findings.push({
    where: "B mid-protocol",
    detail: `H&E racks now: ${perRack.map((r) => `#${r.id} ×${r.n} (${r.worked} worked)`).join(", ")}`,
  });
  for (const rack of perRack) {
    if (Number(rack.n) > 0 && Number(rack.worked) > 0 && Number(rack.worked) !== Number(rack.n)) {
      findings.push({
        where: "B mid-protocol",
        detail: `rack #${rack.id} mixes ${rack.worked} worked and ${Number(rack.n) - Number(rack.worked)} unworked slides — the bench cannot tell them apart`,
      });
    }
  }

  await checkIntegrity(page, findings, "after the mid-protocol merge test");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("merge: reassigning a slide into an agent that already has a rack", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "RS", "Reassign");
  await newSamples(page, { quantity: 4, descriptions: ["r1", "r2", "r3", "r4"] });
  await runBatch(page, ["RS-1", "RS-2", "RS-3", "RS-4"], "Batch 1");

  await cutAndSection(page, "RS-1", ["stain::H&E", "extra"]);
  await cutAndSection(page, "RS-2", ["stain::PAS", "extra"]);
  await cutAndSection(page, "RS-3", ["stain::PAS", "extra"]);

  // PAS has one fresh loading rack with two slides; H&E has one with one.
  expect(await openRacksFor(page, "PAS")).toBe(1);

  // -- C. reassign an untouched slide into an untouched rack → should JOIN ---
  expect(await openRack(page, "H&E")).toBe(true);
  // One selection, not a per-row dropdown (0.14.1).
  const movedCode = (await reassignFirstInRack(page, "stain:PAS")) ?? "";
  await page.waitForTimeout(600);
  await closeDrawer(page);

  const pasRacks = await openRacksFor(page, "PAS");
  const movedRow = await sql<{ stack_id: number; assay: string }>(
    page,
    `SELECT stack_id, assay_name AS assay FROM slides WHERE slide_code = ?`,
    [storedCode(movedCode)],
  );
  findings.push({
    where: "C reassign into a fresh rack",
    detail: `${movedCode} → PAS: ${pasRacks} open PAS rack(s), slide sits in stack ${movedRow[0]?.stack_id}`,
  });
  expect(pasRacks, "an untouched slide joins the untouched rack rather than making a second").toBe(1);

  // The rack it LEFT must be retired, not left open and empty.
  const emptyOpen = await count(
    page,
    `SELECT COUNT(*) AS n FROM slide_stacks st
      WHERE st.closed_at IS NULL AND st.kind = 'stain'
        AND NOT EXISTS (SELECT 1 FROM slides sl WHERE sl.stack_id = st.id)`,
  );
  if (emptyOpen > 0) {
    findings.push({
      where: "C reassign into a fresh rack",
      detail: `${emptyOpen} open stain rack(s) left with no slides after the move`,
    });
  }
  expect(emptyOpen).toBe(0);

  // -- D. start PAS's protocol, then reassign another slide into PAS --------
  // The #81 guard has to hold for the reassignment route too, not just cutting.
  expect(await openRack(page, "PAS")).toBe(true);
  await drawer(page).locator("ol li button:not(:has(svg.lucide-check))").first().click();
  await page.waitForTimeout(400);
  await closeDrawer(page);

  await cutAndSection(page, "RS-4", ["stain::Alcian Blue", "extra"]);
  expect(await openRack(page, "Alcian Blue")).toBe(true);
  // One selection, not a per-row dropdown (0.14.1).
  const code2 = (await reassignFirstInRack(page, "stain:PAS")) ?? "";
  await page.waitForTimeout(600);
  await closeDrawer(page);

  const pasAfter = await sql<{ id: number; n: number; worked: number; closed: string | null }>(
    page,
    `SELECT st.id AS id, st.closed_at AS closed, COUNT(sl.id) AS n,
            SUM(CASE WHEN sl.stage_stained_at IS NOT NULL THEN 1 ELSE 0 END) AS worked
       FROM slide_stacks st LEFT JOIN slides sl ON sl.stack_id = st.id
      WHERE st.assay_name = 'PAS' GROUP BY st.id ORDER BY st.id`,
  );
  findings.push({
    where: "D reassign into a worked rack",
    detail: `${code2} → PAS. PAS racks: ${pasAfter
      .map((r) => `#${r.id} ×${r.n} (${r.worked} worked)${r.closed ? " closed" : ""}`)
      .join(", ")}`,
  });

  const landedIn = await sql<{ stack_id: number }>(
    page,
    `SELECT stack_id FROM slides WHERE slide_code = ?`,
    [storedCode(code2)],
  );
  const target = pasAfter.find((r) => r.id === landedIn[0]?.stack_id);
  if (target && Number(target.worked) > 0) {
    findings.push({
      where: "D reassign into a worked rack",
      detail:
        `an UNSTAINED slide was moved into PAS rack #${target.id}, which already has ` +
        `${target.worked} stained slide(s). The rack's protocol is part-done, so the ` +
        `newcomer inherits a rack that reads as further along than it is (#81 covers ` +
        `the cutting route; this is the reassignment route).`,
    });
  }

  await checkIntegrity(page, findings, "after reassigning into a worked rack");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("merge: a stained slide moved into a fresh rack, and what that rack accepts next", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "PZ", "Poison");
  await newSamples(page, { quantity: 4, descriptions: ["p1", "p2", "p3", "p4"] });
  await runBatch(page, ["PZ-1", "PZ-2", "PZ-3", "PZ-4"], "Batch 1");

  // PZ-1 → H&E, stained. PZ-2 → PAS, untouched.
  await cutAndSection(page, "PZ-1", ["stain::H&E", "extra"]);
  await cutAndSection(page, "PZ-2", ["stain::PAS", "extra"]);

  expect(await openRack(page, "H&E")).toBe(true);
  await drawer(page).locator("ol li button:not(:has(svg.lucide-check))").first().click();
  await page.waitForTimeout(400);

  // Now move that STAINED slide into the untouched PAS rack.
  // One selection, not a per-row dropdown (0.14.1).
  const [code] = await rackSlideCodes(page);
  const stampBefore = await sql<{ stained: string | null }>(
    page,
    `SELECT stage_stained_at AS stained FROM slides WHERE slide_code = ?`,
    [storedCode(code)],
  );
  await reassignInRack(page, [code], "stain:PAS");
  await page.waitForTimeout(600);
  await closeDrawer(page);

  const after = await sql<{ stack_id: number; stained: string | null; assay: string }>(
    page,
    `SELECT stack_id, stage_stained_at AS stained, assay_name AS assay FROM slides WHERE slide_code = ?`,
    [storedCode(code)],
  );
  findings.push({
    where: "E stained slide moved",
    detail: `${code} was stained (${stampBefore[0]?.stained ? "stamped" : "no stamp"}), moved to PAS; now assay=${after[0]?.assay}, stamp ${after[0]?.stained ? "kept" : "cleared"}, rack ${after[0]?.stack_id}`,
  });

  // The question this test exists for: can a FRESH slide still join that PAS
  // rack, now that a stained slide sits in it? getOpenStainRack refuses any
  // rack with a worked member, so the answer should be no — which means one
  // reassignment permanently closes an otherwise-empty-handed rack to newcomers.
  await cutAndSection(page, "PZ-3", ["stain::PAS", "extra"]);
  const pasRacks = await sql<{ id: number; n: number; worked: number }>(
    page,
    `SELECT st.id AS id, COUNT(sl.id) AS n,
            SUM(CASE WHEN sl.stage_stained_at IS NOT NULL THEN 1 ELSE 0 END) AS worked
       FROM slide_stacks st JOIN slides sl ON sl.stack_id = st.id
      WHERE st.assay_name = 'PAS' AND st.closed_at IS NULL GROUP BY st.id ORDER BY st.id`,
  );
  findings.push({
    where: "E stained slide moved",
    detail:
      `after a stained slide joined the PAS rack, a new PAS slide produced ` +
      `${pasRacks.length} open PAS rack(s): ${pasRacks
        .map((r) => `#${r.id} ×${r.n} (${r.worked} worked)`)
        .join(", ")}`,
  });
  if (pasRacks.length > 1) {
    findings.push({
      where: "E stained slide moved",
      detail:
        "reassigning ONE already-stained slide into a loading rack shuts that rack to " +
        "every later slide of the same agent — the bench now has two racks for one " +
        "agent with no visible reason why",
    });
  }

  await checkIntegrity(page, findings, "after the stained-slide move");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("merge: per-sample stacks converge at imaging, including a half-imaged one", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "CV", "Converge");
  await newSamples(page, { quantity: 2, descriptions: ["c1", "c2"] });
  await runBatch(page, ["CV-1", "CV-2"], "Batch 1");

  // One block, two agents → two racks, which will scatter into ONE per-sample
  // imaging stack. They arrive at different times on purpose.
  await cutAndSection(page, "CV-1", ["stain::H&E", "ihc::CD31", "extra"]);

  // Take H&E all the way to Ready for Imaging first.
  expect(await openRack(page, "H&E")).toBe(true);
  await runProtocolSteps(page);
  await closeDrawer(page);

  const afterFirst = await racks(page);
  findings.push({
    where: "F converge",
    detail: `after the first rack scattered: ${afterFirst
      .map((s) => `#${s.id} ${s.kind}/${s.assay ?? s.sample_id} ${s.stage}${s.closed ? " closed" : ""} ×${s.n}`)
      .join("; ")}`,
  });

  // Tick images on the slides that arrived first, so the per-sample stack is
  // HALF imaged before the second rack scatters into it.
  await closeDrawer(page);
  const imaging = column(page, "Ready for Imaging");
  const firstStack = imaging.locator("div[aria-selected]").first();
  expect(await firstStack.count(), "the first rack should have reached imaging").toBeGreaterThan(0);
  await firstStack.click();
  const boxes = page.getByRole("checkbox", { name: /^Images captured for / });
  const imagedFirst = await boxes.count();
  for (let i = 0; i < imagedFirst; i += 1) {
    const box = boxes.nth(i);
    if (!(await box.isChecked())) await box.check();
  }
  await page.waitForTimeout(300);
  await closeDrawer(page);

  const stackBefore = await sql<{ id: number; n: number; imaged: number }>(
    page,
    `SELECT st.id AS id, COUNT(sl.id) AS n,
            SUM(CASE WHEN sl.stage_pictures_taken_at IS NOT NULL THEN 1 ELSE 0 END) AS imaged
       FROM slide_stacks st JOIN slides sl ON sl.stack_id = st.id
      WHERE st.kind = 'sample' AND st.closed_at IS NULL GROUP BY st.id`,
  );
  findings.push({
    where: "F converge",
    detail: `half-imaged per-sample stack(s): ${stackBefore
      .map((s) => `#${s.id} ${s.imaged}/${s.n} imaged`)
      .join(", ")}`,
  });

  // Now bring the SECOND rack through. Its slides are freshly stained and have
  // no images — do they land in the half-imaged stack?
  expect(await openRack(page, "CD31")).toBe(true);
  await runProtocolSteps(page);
  await closeDrawer(page);

  const stackAfter = await sql<{ id: number; n: number; imaged: number }>(
    page,
    `SELECT st.id AS id, COUNT(sl.id) AS n,
            SUM(CASE WHEN sl.stage_pictures_taken_at IS NOT NULL THEN 1 ELSE 0 END) AS imaged
       FROM slide_stacks st JOIN slides sl ON sl.stack_id = st.id
      WHERE st.kind = 'sample' AND st.closed_at IS NULL GROUP BY st.id`,
  );
  findings.push({
    where: "F converge",
    detail: `after the second rack scattered: ${stackAfter
      .map((s) => `#${s.id} ${s.imaged}/${s.n} imaged`)
      .join(", ")}`,
  });

  const merged = stackAfter.find((s) => Number(s.n) > imagedFirst);
  if (merged) {
    findings.push({
      where: "F converge",
      detail:
        `slides that have never been imaged merged into per-sample stack #${merged.id}, ` +
        `which already had ${merged.imaged} imaged slide(s). getOpenSampleStack matches on ` +
        `(sample, stage, open) only — it has no equivalent of the #81 "untouched" guard that ` +
        `protects loading racks, so a stack part-way through imaging still accepts newcomers.`,
    });
  } else {
    findings.push({
      where: "F converge",
      detail: "the second rack did NOT merge into the half-imaged stack — a separate stack was made",
    });
  }

  // Whatever the answer, nothing may land in a CLOSED stack.
  await checkIntegrity(page, findings, "after imaging convergence");

  // Finish imaging and check the analyzed stack cannot absorb anything later.
  await closeDrawer(page);
  for (let pass = 0; pass < 4; pass += 1) {
    const n = await imaging.locator("div[aria-selected]").count();
    if (n === 0) break;
    let acted = 0;
    for (let i = 0; i < n; i += 1) {
      await closeDrawer(page);
      const card = imaging.locator("div[aria-selected]").nth(i);
      if (!(await card.count())) break;
      await card.click();
      const bx = page.getByRole("checkbox", { name: /^Images captured for / });
      for (let b = 0; b < (await bx.count()); b += 1) {
        const box = bx.nth(b);
        if (!(await box.isChecked())) {
          await box.check();
          acted += 1;
        }
      }
      const done = page.getByRole("button", { name: /Complete Imaging|Analyz/ });
      if ((await done.count()) && (await done.first().isEnabled())) {
        await done.first().click();
        acted += 1;
      }
      await closeDrawer(page);
    }
    if (acted === 0) break;
  }

  // A second wave for the SAME sample, after its stack was analyzed and closed.
  await cutAndSection(page, "CV-1", ["stain::Safranin O"]);
  expect(await openRack(page, "Safranin O")).toBe(true);
  await runProtocolSteps(page);
  await closeDrawer(page);

  const closedAbsorb = await count(
    page,
    `SELECT COUNT(*) AS n FROM slides sl JOIN slide_stacks st ON st.id = sl.stack_id
      WHERE st.closed_at IS NOT NULL AND sl.current_stage NOT IN ('analyzed','removed')`,
  );
  if (closedAbsorb > 0) {
    findings.push({
      where: "G closed stack",
      detail: `${closedAbsorb} live slide(s) ended up inside a CLOSED stack — nothing on the board will show them again`,
    });
  }
  expect(closedAbsorb, "a retired stack must never absorb live slides").toBe(0);

  const finalStacks = await racks(page);
  findings.push({
    where: "G closed stack",
    detail: `final stacks: ${finalStacks
      .map((s) => `#${s.id} ${s.kind}/${s.assay ?? s.sample_id} ${s.stage}${s.closed ? " closed" : ""} ×${s.n}`)
      .join("; ")}`,
  });

  await checkIntegrity(page, findings, "after the second wave");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("merge: what the bench SEES on a rack that mixes worked and unworked glass", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "MX", "MixedRack");
  await newSamples(page, { quantity: 3, descriptions: ["x1", "x2", "x3"] });
  await runBatch(page, ["MX-1", "MX-2", "MX-3"], "Batch 1");

  await cutAndSection(page, "MX-1", ["stain::H&E", "extra"]);
  await cutAndSection(page, "MX-2", ["stain::PAS", "extra"]);

  // Stain the H&E slide, then move it into the untouched PAS rack.
  expect(await openRack(page, "H&E")).toBe(true);
  await drawer(page).locator("ol li button:not(:has(svg.lucide-check))").first().click();
  await page.waitForTimeout(400);
  // One selection, not a per-row dropdown (0.14.1).
  const moved = (await reassignFirstInRack(page, "stain:PAS")) ?? "";
  await page.waitForTimeout(700);
  await closeDrawer(page);

  // What does the PAS rack's CARD say now?
  const card = column(page, "Staining / IHC")
    .locator("div[aria-selected]")
    .filter({ hasText: "PAS" })
    .first();
  const cardText = (await card.innerText()).replace(/\s+/g, " ").trim();
  findings.push({ where: "mixed rack card", detail: `PAS card reads: "${cardText}"` });

  await card.click();
  const panelText = (await drawer(page).innerText()).replace(/\s+/g, " ").trim();
  findings.push({
    where: "mixed rack panel",
    detail: `PAS panel reads: "${panelText.slice(0, 400)}"`,
  });

  // …and what the database says about the same rack.
  const rows = await sql<{ code: string; stained: string | null }>(
    page,
    `SELECT sl.slide_code AS code, sl.stage_stained_at AS stained
       FROM slides sl JOIN slide_stacks st ON st.id = sl.stack_id
      WHERE st.assay_name = 'PAS' AND st.closed_at IS NULL ORDER BY sl.slide_code`,
  );
  findings.push({
    where: "mixed rack data",
    detail: `PAS rack holds ${rows.map((r) => `${r.code}${r.stained ? " STAINED" : " unstained"}`).join(", ")}`,
  });

  const stainedCount = rows.filter((r) => r.stained).length;
  if (stainedCount > 0 && stainedCount < rows.length) {
    const showsProgress = /\d+\s*\/\s*\d+/.test(cardText) || /\d+\s*\/\s*\d+/.test(panelText);
    findings.push({
      where: "mixed rack",
      detail:
        `the rack holds ${stainedCount} stained and ${rows.length - stainedCount} unstained slide(s) ` +
        `after ${moved} was moved in. The rack's own protocol checklist is a SINGLE state for the ` +
        `whole rack, so it cannot express this: ${
          showsProgress
            ? "the card shows a fraction, but it is the rack's checklist, not the per-slide truth"
            : "nothing on the card or panel distinguishes the stained slide from the unstained ones"
        }.`,
    });
  }

  // Ticking the rack's step now: does the already-stained slide keep its date?
  const before = rows.find((r) => r.stained);
  const pending = drawer(page).locator("ol li button:not(:has(svg.lucide-check))");
  if ((await pending.count()) > 0) {
    await pending.first().click();
    await page.waitForTimeout(600);
    const after = await sql<{ code: string; stained: string | null }>(
      page,
      `SELECT slide_code AS code, stage_stained_at AS stained FROM slides WHERE slide_code = ?`,
      [before?.code ?? ""],
    );
    findings.push({
      where: "mixed rack",
      detail: `re-ticking the rack's Stained step: ${before?.code} was ${before?.stained}, now ${after[0]?.stained} (${
        before?.stained === after[0]?.stained ? "kept — good" : "OVERWRITTEN"
      })`,
    });
    if (before?.stained && after[0]?.stained && before.stained !== after[0].stained) {
      findings.push({
        where: "mixed rack",
        detail:
          "DEFECT: a slide's original stained date was overwritten by a later rack-level tick — " +
          "the log now reports the wrong day for work that was already done",
      });
    }
  }
  await closeDrawer(page);

  await checkIntegrity(page, findings, "after the mixed-rack test");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
