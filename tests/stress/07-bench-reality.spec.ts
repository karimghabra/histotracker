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
import { rackSlideCodes, reassignInRack } from "../helpers/rack";

/**
 * Bench reality: the things that actually happen to glass, and whether the
 * software can say so.
 *
 * A slide is a physical object. It breaks, it gets put in the wrong dish, it
 * comes out too pale, somebody changes their mind between the microtome and the
 * stainer, and every so often a slide is labelled with the wrong block. Each of
 * those is a correction the record has to be able to express — and a workflow
 * app is only as good as its worst correction, because that is the one the
 * technician works around with a pen and paper.
 *
 * Every scenario below is attempted through the UI and then checked in the
 * database. Where no affordance exists, the test records that as the finding.
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

/** Plant a state the app itself produced earlier — e.g. a slide stained last week. */
async function planted(page: import("@playwright/test").Page, statement: string, params: unknown[]) {
  await page.evaluate(
    ([s, p]) =>
      (window as unknown as { __SHIM_SQL__: (q: string, b?: unknown[]) => void }).__SHIM_SQL__(
        s as string,
        p as unknown[],
      ),
    [statement, params] as const,
  );
}

test("bench: a slide breaks in the rack, mid-protocol", async ({ page, consoleErrors, findings }) => {
  await boot(page);
  await addProject(page, "BR", "Broken");
  await newSamples(page, { quantity: 2, descriptions: ["b1", "b2"] });
  await runBatch(page, ["BR-1", "BR-2"], "Batch 1");
  await cutAndSection(page, "BR-1", ["stain::H&E", "extra"]);
  await cutAndSection(page, "BR-2", ["stain::H&E", "extra"]);

  // Two slides in one H&E rack; stain them, then break one.
  // Only the FIRST step: completing the whole protocol scatters the rack into
  // imaging, and "it broke in the rack" means the rack is still on the bench.
  expect(await openRack(page, "H&E")).toBe(true);
  await drawer(page).locator("ol li button:not(:has(svg.lucide-check))").first().click();
  await page.waitForTimeout(500);

  const select = drawer(page).getByRole("button", { name: /Select slides/ });
  if (!(await select.count())) {
    findings.push({ where: "B1 breakage", detail: "DEFECT: no way to remove one slide from a rack" });
  } else {
    await select.click();
    const pick = drawer(page).getByRole("checkbox", { name: /^Select BR-/ });
    const code = ((await pick.first().getAttribute("aria-label")) ?? "").replace("Select ", "");
    await pick.first().check();
    const remove = drawer(page).getByRole("button", { name: /^Remove \d+ slide/ });
    if (!(await remove.count())) {
      findings.push({ where: "B1 breakage", detail: "DEFECT: slides can be selected in a rack but not removed" });
    } else {
      await remove.click();
      const reason = page.getByLabel("Reason for removal");
      if (!(await reason.count())) {
        findings.push({ where: "B1 breakage", detail: "removal from a rack asks for no reason" });
      } else {
        await reason.fill("broke while loading the coverslipper");
        await page.getByRole("dialog").getByRole("button", { name: /^Remove/ }).last().click();
        await page.waitForTimeout(700);
      }
      const row = await sql<{ stage: string; stack_id: number | null; stained: string | null }>(
        page,
        `SELECT current_stage AS stage, stack_id, stage_stained_at AS stained
           FROM slides WHERE slide_code = ?`,
        [storedCode(code)],
      );
      findings.push({
        where: "B1 breakage",
        detail: `${code} after breaking: stage=${row[0]?.stage}, rack=${row[0]?.stack_id}, stained stamp ${
          row[0]?.stained ? "kept" : "cleared"
        }`,
      });
      if (row[0]?.stage !== "removed") {
        findings.push({ where: "B1 breakage", detail: "DEFECT: the broken slide was not recorded as removed" });
      }
      if (!row[0]?.stained) {
        findings.push({
          where: "B1 breakage",
          detail:
            "the slide's stained date was cleared by the removal — it WAS stained before it broke, " +
            "and that is part of what happened to it",
        });
      }
    }
  }

  await checkIntegrity(page, findings, "after a breakage");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("bench: a slide is stained with the wrong agent", async ({ page, consoleErrors, findings }) => {
  await boot(page);
  await addProject(page, "WR", "Wrong");
  await newSamples(page, { quantity: 2, descriptions: ["w1", "w2"] });
  await runBatch(page, ["WR-1", "WR-2"], "Batch 1");

  // WR-1-A is requested as PAS…
  await cutAndSection(page, "WR-1", ["stain::PAS", "extra"]);
  expect(await openRack(page, "PAS")).toBe(true);
  const requested = await sql<{ code: string; assay: string }>(
    page,
    `SELECT sl.slide_code AS code, sl.assay_name AS assay FROM slides sl
       JOIN slide_stacks st ON st.id = sl.stack_id WHERE st.assay_name = 'PAS'`,
  );
  const code = requested[0]?.code ?? "";

  // …and goes into the H&E dish by mistake. The bench truth is now: this slide
  // was REQUESTED as PAS and IS an H&E. Record it and see what survives.
  await drawer(page).locator("ol li button:not(:has(svg.lucide-check))").first().click();
  await page.waitForTimeout(500);
  // Through the selection, since 0.14.1 dropped the per-row dropdown. The
  // question this asks is unchanged: is there ANY way to correct the agent on a
  // slide that has already been stained?
  const correctable = await rackSlideCodes(page);
  if (correctable.length === 0) {
    findings.push({ where: "B2 wrong stain", detail: "DEFECT: no way to correct the agent on a stained slide" });
  } else {
    await reassignInRack(page, [correctable[0]], "stain:H&E");
    await page.waitForTimeout(700);
    const after = await sql<{ assay: string; stained: string | null; stack_id: number | null }>(
      page,
      `SELECT assay_name AS assay, stage_stained_at AS stained, stack_id FROM slides WHERE slide_code = ?`,
      [code],
    );
    findings.push({
      where: "B2 wrong stain",
      detail: `${code}: requested PAS, corrected to ${after[0]?.assay}; stained stamp ${
        after[0]?.stained ? "kept" : "cleared"
      }, now in rack ${after[0]?.stack_id}`,
    });

    // Is the ORIGINAL request still recoverable anywhere?
    const trace = await count(
      page,
      `SELECT COUNT(*) AS n FROM sample_timeline_events WHERE details LIKE '%PAS%' OR summary LIKE '%PAS%'`,
    );
    findings.push({
      where: "B2 wrong stain",
      detail: `traces of the original PAS request left on the timeline: ${trace}`,
    });
    if (trace === 0) {
      findings.push({
        where: "B2 wrong stain",
        detail:
          "DEFECT: `assay_name` is a single field holding BOTH what was asked for and what the slide " +
          "actually is. Correcting the agent overwrites the request, so the log can no longer say " +
          "the PAS that was ordered was never made — and the block still looks like its PAS was done.",
      });
    }
  }

  await checkIntegrity(page, findings, "after a wrong-stain correction");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("bench: a mis-tick, and a rack step re-ticked over an older stain date", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "TK", "Ticks");
  await newSamples(page, { quantity: 2, descriptions: ["t1", "t2"] });
  await runBatch(page, ["TK-1", "TK-2"], "Batch 1");
  await cutAndSection(page, "TK-1", ["stain::H&E", "extra"]);

  // -- mis-tick: tick Stained, then untick it -------------------------------
  expect(await openRack(page, "H&E")).toBe(true);
  const step = drawer(page).locator("ol li button").first();
  await step.click();
  await page.waitForTimeout(500);
  const afterTick = await count(
    page,
    `SELECT COUNT(*) AS n FROM slides WHERE stage_stained_at IS NOT NULL`,
  );
  await step.click();
  await page.waitForTimeout(500);
  const afterUntick = await count(
    page,
    `SELECT COUNT(*) AS n FROM slides WHERE stage_stained_at IS NOT NULL`,
  );
  findings.push({
    where: "B4 mis-tick",
    detail: `stained slides: ${afterTick} after ticking, ${afterUntick} after unticking (a mis-tick is ${
      afterUntick < afterTick ? "reversible" : "NOT reversible"
    })`,
  });
  await closeDrawer(page);

  // -- an older stain date, overwritten by a later rack tick ----------------
  // Plant the state the app itself produces: a slide stained days ago, then
  // moved into a rack that is ticked afterwards. `syncAssayStackWorkflowStep`
  // writes `SET stage_stained_at = ?` for EVERY slide of that assay in the
  // rack — no COALESCE — so the older date is a casualty.
  await cutAndSection(page, "TK-2", ["stain::H&E", "extra"]);
  const slides = await sql<{ id: number; code: string }>(
    page,
    `SELECT sl.id AS id, sl.slide_code AS code FROM slides sl
       JOIN slide_stacks st ON st.id = sl.stack_id
      WHERE st.assay_name = 'H&E' AND st.closed_at IS NULL ORDER BY sl.id`,
  );
  if (slides.length > 0) {
    const victim = slides[0];
    await planted(page, `UPDATE slides SET stage_stained_at = ? WHERE id = ?`, [
      "2020-01-02 09:00",
      victim.id,
    ]);
    const before = await sql<{ stained: string }>(
      page,
      `SELECT stage_stained_at AS stained FROM slides WHERE id = ?`,
      [victim.id],
    );

    // NOT page.reload(): the URL still carries ?freshdb=1 and the shim resets the
    // database on every load, so reloading here would wipe the very state just
    // planted. The planted row is already in the image the app is querying.
    if (await openRack(page, "H&E")) {
      const pending = drawer(page).locator("ol li button:not(:has(svg.lucide-check))").first();
      if (!(await pending.count())) {
        findings.push({ where: "B5 overwritten date", detail: "no pending protocol step to tick" });
      } else {
        await pending.click();
        await page.waitForTimeout(700);
      }
      const after = await sql<{ stained: string | null }>(
        page,
        `SELECT stage_stained_at AS stained FROM slides WHERE id = ?`,
        [victim.id],
      );
      findings.push({
        where: "B5 overwritten date",
        detail: `${victim.code} was stained ${before[0]?.stained}; after the rack's step was ticked it reads ${after[0]?.stained}`,
      });
      if (before[0]?.stained !== after[0]?.stained) {
        findings.push({
          where: "B5 overwritten date",
          detail:
            "DEFECT: ticking a rack's protocol step REWRITES the stained date of every slide in it, " +
            "including one that was stained earlier somewhere else. `syncAssayStackWorkflowStep` " +
            "issues `SET stage_stained_at = ?` with no COALESCE, so the true date of that slide's " +
            "staining is lost. Unticking sets it to NULL for the whole rack for the same reason.",
        });
      }
    }
    await closeDrawer(page);
  }

  await checkIntegrity(page, findings, "after the tick tests");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("bench: re-imaging, and losing a slide after it was analyzed", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await addProject(page, "IM", "Imaging");
  await newSamples(page, { quantity: 1, description: "i1" });
  await runBatch(page, ["IM-1"], "Batch 1");
  await cutAndSection(page, "IM-1", ["stain::H&E", "extra"]);

  expect(await openRack(page, "H&E")).toBe(true);
  await runProtocolSteps(page);
  await closeDrawer(page);

  const imaging = column(page, "Ready for Imaging");
  await imaging.locator("div[aria-selected]").first().click();
  const box = page.getByRole("checkbox", { name: /^Images captured for / }).first();
  await box.check();
  await page.waitForTimeout(400);

  // -- B6: the images were poor; untick and re-take.
  await box.uncheck();
  await page.waitForTimeout(400);
  const cleared = await count(
    page,
    `SELECT COUNT(*) AS n FROM slides WHERE stage_pictures_taken_at IS NOT NULL`,
  );
  findings.push({
    where: "B6 re-image",
    detail: `after unticking images captured, ${cleared} slide(s) still carry the stamp (${
      cleared === 0 ? "reversible" : "NOT reversible"
    })`,
  });
  await box.check();
  await page.waitForTimeout(300);

  for (let pass = 0; pass < 4; pass += 1) {
    const complete = page.getByRole("button", { name: /Complete Imaging|Analyz/ });
    if (!(await complete.count())) break;
    await complete.first().click();
    await page.waitForTimeout(700);
    const done = await count(page, `SELECT COUNT(*) AS n FROM slides WHERE stage_analyzed_at IS NOT NULL`);
    if (done > 0) break;
    await closeDrawer(page);
    const next = imaging.locator("div[aria-selected]").first();
    if (!(await next.count())) break;
    await next.click();
  }

  // -- B10: the slide is lost AFTER analysis. Can it still be recorded?
  const analyzed = await sql<{ id: number; code: string; stage: string }>(
    page,
    `SELECT id, slide_code AS code, current_stage AS stage FROM slides
      WHERE stage_analyzed_at IS NOT NULL LIMIT 1`,
  );
  if (analyzed.length === 0) {
    findings.push({ where: "B10 lost after analysis", detail: "nothing reached analyzed to test with" });
  } else {
    await closeDrawer(page);
    // Where can an analyzed slide be reached at all? Its stack is retired.
    const stack = await sql<{ closed: string | null }>(
      page,
      `SELECT st.closed_at AS closed FROM slide_stacks st
         JOIN slides sl ON sl.stack_id = st.id WHERE sl.id = ?`,
      [analyzed[0].id],
    );
    const boardCards = await column(page, "Ready for Imaging").locator("div[aria-selected]").count();
    findings.push({
      where: "B10 lost after analysis",
      detail: `${analyzed[0].code} is analyzed; its stack is ${
        stack[0]?.closed ? "retired" : "still open"
      }; Ready for Imaging now shows ${boardCards} card(s)`,
    });

    // The Logs drill-down is the only place it still appears — is there a
    // removal control there?
    await page.locator("nav").getByRole("button", { name: "Logs" }).click();
    await page.getByRole("cell", { name: "IM-1", exact: true }).click();
    await page.waitForTimeout(400);
    const logsText = (await page.locator("tbody").innerText()).replace(/\s+/g, " ");
    const hasRemove = /Remove/i.test(logsText);
    findings.push({
      where: "B10 lost after analysis",
      detail: `the Logs drill-down for the analyzed slide ${
        hasRemove ? "offers a Remove control" : "offers NO removal control"
      }`,
    });
    if (!hasRemove) {
      findings.push({
        where: "B10 lost after analysis",
        detail:
          "DEFECT: once a slide is analyzed its rack is retired and it leaves the board, so a slide " +
          "that is later broken or lost cannot be recorded as removed anywhere — the inventory keeps " +
          "claiming glass that no longer exists.",
      });
    }
  }

  await checkIntegrity(page, findings, "after imaging corrections");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("bench: capabilities that have no affordance at all", async ({ page, consoleErrors, findings }) => {
  await boot(page);
  await addProject(page, "NA", "NoAfford");
  await newSamples(page, { quantity: 2, descriptions: ["n1", "n2"] });
  await runBatch(page, ["NA-1", "NA-2"], "Batch 1");
  await cutAndSection(page, "NA-1", ["stain::H&E", "extra"]);

  // -- B7: the ribbon gave one more usable section than the plan called for.
  // The cut group's own drawer takes it now, so the slide joins the cut that
  // actually produced it instead of inventing a second trip to the microtome.
  await closeDrawer(page);
  const queuedCard = column(page, "Staining / IHC").locator("div[aria-selected]").first();
  const beforeAdd = await count(page, `SELECT COUNT(*) AS n FROM slides`);
  const sections = await sql<{ id: number }>(page, `SELECT id FROM section_requests ORDER BY id LIMIT 1`);
  if (sections.length > 0) {
    const added = await page.evaluate(async (sectionId) => {
      try {
        const mod = await import("/src/lib/db.ts");
        await (mod as { addSlideToSection: (id: number, t: unknown) => Promise<number> })
          .addSlideToSection(sectionId as number, { extra: true });
        return "ok";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }, sections[0].id);
    const afterAdd = await count(page, `SELECT COUNT(*) AS n FROM slides`);
    findings.push({
      where: "B7 one extra section",
      detail: `adding one more slide to an already-cut group: ${added} (${beforeAdd} → ${afterAdd} slides)`,
    });
    if (afterAdd !== beforeAdd + 1) {
      findings.push({ where: "B7 one extra section", detail: "DEFECT: the slide was not added" });
    }
    const late = await sql<{ code: string; cut: string | null }>(
      page,
      `SELECT slide_code AS code, stage_cut_at AS cut FROM slides ORDER BY id DESC LIMIT 1`,
    );
    if (!late[0]?.cut) {
      findings.push({
        where: "B7 one extra section",
        detail: "DEFECT: a slide added to an already-cut group carries no cut stamp",
      });
    }
  }
  void queuedCard;

  // -- B8: the slide was labelled with the wrong block.
  const twoBlocks = await sql<{ id: number; code: string }>(
    page,
    `SELECT id, sample_code AS code FROM samples ORDER BY id LIMIT 2`,
  );
  const victim = await sql<{ id: number; code: string; stained: string | null; sample: number }>(
    page,
    `SELECT sl.id AS id, sl.slide_code AS code, sl.stage_stained_at AS stained, sr.sample_id AS sample
       FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sl.current_stage <> 'removed' ORDER BY sl.id LIMIT 1`,
  );
  if (twoBlocks.length === 2 && victim.length === 1) {
    const target = twoBlocks.find((b) => b.id !== victim[0].sample);
    const outcome = await page.evaluate(
      async ([slideId, sampleId]) => {
        try {
          const mod = await import("/src/lib/db.ts");
          await (mod as {
            relabelSlideToSample: (s: number, t: number, r: string) => Promise<void>;
          }).relabelSlideToSample(slideId as number, sampleId as number, "labelled with the wrong block");
          return "ok";
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
      [victim[0].id, target?.id ?? -1] as const,
    );
    const after = await sql<{ code: string; sample: number; stained: string | null }>(
      page,
      `SELECT sl.slide_code AS code, sr.sample_id AS sample, sl.stage_stained_at AS stained
         FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id WHERE sl.id = ?`,
      [victim[0].id],
    );
    findings.push({
      where: "B8 wrong block",
      detail:
        `refiling ${victim[0].code} onto ${target?.code}: ${outcome}. It is now ${after[0]?.code} ` +
        `under sample ${after[0]?.sample} (was ${victim[0].sample}), stamps ${
          after[0]?.stained === victim[0].stained ? "intact" : "CHANGED"
        }`,
    });
    if (after[0]?.sample !== target?.id) {
      findings.push({ where: "B8 wrong block", detail: "DEFECT: the slide did not move blocks" });
    }
    const events = await count(
      page,
      `SELECT COUNT(*) AS n FROM sample_timeline_events WHERE event_type LIKE 'slide_relabelled%'`,
    );
    findings.push({ where: "B8 wrong block", detail: `${events} timeline events recorded the correction` });
    if (events < 2) {
      findings.push({
        where: "B8 wrong block",
        detail: "DEFECT: a relabel must be recorded on BOTH blocks",
      });
    }
  }

  // -- B9: a pale H&E is re-run through the stainer.
  const restains = await count(
    page,
    `SELECT COUNT(*) AS n FROM sample_timeline_events WHERE event_type = 'slide_restained'`,
  );
  findings.push({
    where: "B9 re-stain",
    detail:
      `a slide still carries ONE stage_stained_at — the FIRST one, which is the date that glass was ` +
      `actually stained — and a second run is recorded on the timeline instead (${restains} so far in ` +
      `this fixture). The column is the current state; the timeline is what happened.`,
  });

  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
