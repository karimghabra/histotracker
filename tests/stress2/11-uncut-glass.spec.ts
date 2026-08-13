import {
  test,
  expect,
  sql,
  count,
  callDb,
  claim,
  boot,
  seed,
  embed,
  checkInvariants,
} from "./driver";

/**
 * Chasing down what the fuzzer found: a slide stained with no cut stamp.
 *
 * `stained-implies-cut` fired at step 87 on `AA-0002-B`. That is the #118 family
 * — acting on glass that does not physically exist yet — so it matters, but the
 * fuzzer drives `db.ts` directly and could in principle have reached a state the
 * UI cannot. This spec isolates each candidate path and checks whether the UI
 * can get there too, which is the difference between a defect and an artefact.
 */

async function blockReadyToCut(page: import("@playwright/test").Page): Promise<number> {
  await boot(page);
  await seed(page, { projects: 1, samplesPerProject: 2 });
  const blocks = await sql<{ id: number }>(page, `SELECT id FROM samples ORDER BY id`);
  for (const block of blocks) await embed(page, block.id);
  return blocks[0].id;
}

test("uncut glass: can a stain request pull an extra that has not been cut?", async ({
  page,
  consoleErrors,
  findings,
}) => {
  const sampleId = await blockReadyToCut(page);

  // A saved cutting plan that has NOT been sent: the slides exist as rows, the
  // group is still queued, and no blade has touched the block (#95/#118).
  await callDb(page, "createSectionRequests", [sampleId, [{ duplicates: 2, stains: "" }]]);
  const queued = await sql<{ id: number; stage: string; cut: string | null; purpose: string }>(
    page,
    `SELECT sl.id AS id, sr.current_stage AS stage, sl.stage_cut_at AS cut, sl.purpose AS purpose
       FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sr.sample_id = ?`,
    [sampleId],
  );
  expect(queued.length, "the plan produced slide rows").toBeGreaterThan(0);
  expect(queued[0].stage, "…and the group is still queued").toBe("needs_sectioning");
  expect(queued[0].cut, "…and nothing has been cut").toBeNull();

  const pulled = await callDb<{ target: string; slideId: number | null }>(
    page,
    "requestStainForSample",
    [{ sampleId, assayType: "stain", assayName: "H&E" }],
  );

  if (pulled.ok && pulled.value.target === "extra") {
    const slide = await sql<{ code: string; cut: string | null; stack: number | null; stage: string }>(
      page,
      `SELECT slide_code AS code, stage_cut_at AS cut, stack_id AS stack, current_stage AS stage
         FROM slides WHERE id = ?`,
      [pulled.value.slideId ?? -1],
    );
    await claim(
      findings,
      "uncut extra pulled into staining",
      `requestStainForSample pulled ${slide[0]?.code} into a staining rack (stack ${slide[0]?.stack}) ` +
        `while its cut group is still queued — the slide has no cut stamp, so the board now shows ` +
        `glass in Staining that nobody has cut. This is the #118 family: the plan is not the cut.`,
      async () => {
        // Second route: ask the question from the GROUP's side rather than the
        // slide's, and confirm the group really is still in the queue.
        const group = await sql<{ stage: string; n: number }>(
          page,
          `SELECT sr.current_stage AS stage, COUNT(sl.id) AS n
             FROM section_requests sr JOIN slides sl ON sl.section_request_id = sr.id
            WHERE sl.id = ? GROUP BY sr.id`,
          [pulled.value.slideId ?? -1],
        );
        const stillQueued = group[0]?.stage === "needs_sectioning";
        return {
          holds: stillQueued && !slide[0]?.cut,
          how: `the slide's group reads "${group[0]?.stage}" and its cut stamp is ${
            slide[0]?.cut ?? "null"
          } — checked from the group side, not the slide side`,
        };
      },
    );

    // And the consequence the fuzzer actually tripped over: stain it.
    const rack = slide[0]?.stack;
    if (rack != null) {
      await callDb(page, "syncAssayStackWorkflowStep", [rack, "stain", 0, true]);
      const after = await sql<{ code: string; stained: string | null; cut: string | null }>(
        page,
        `SELECT slide_code AS code, stage_stained_at AS stained, stage_cut_at AS cut
           FROM slides WHERE id = ?`,
        [pulled.value.slideId ?? -1],
      );
      if (after[0]?.stained && !after[0]?.cut) {
        findings.push({
          where: "uncut extra pulled into staining",
          severity: "defect",
          detail:
            `…and one rack tick later ${after[0].code} is recorded as STAINED on ` +
            `${after[0].stained} with no cut date. This is exactly the fuzzer's step-87 state.`,
          corroboration: "reproduced deterministically from a saved-but-unsent cutting plan",
        });
      }
    }
  } else {
    findings.push({
      where: "uncut extra pulled into staining",
      severity: "observation",
      detail: `the request did not pull an extra: ${
        pulled.ok ? JSON.stringify(pulled.value) : pulled.error
      }`,
    });
  }

  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("uncut glass: can a reassignment put an uncut slide into a live rack?", async ({
  page,
  consoleErrors,
  findings,
}) => {
  const sampleId = await blockReadyToCut(page);
  await callDb(page, "createSectionRequests", [
    sampleId,
    [{ duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" }],
  ]);
  const planned = await sql<{ id: number; code: string; cut: string | null }>(
    page,
    `SELECT sl.id AS id, sl.slide_code AS code, sl.stage_cut_at AS cut
       FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sr.sample_id = ? AND sr.current_stage = 'needs_sectioning'`,
    [sampleId],
  );
  expect(planned.length, "a planned, uncut slide exists").toBeGreaterThan(0);

  const moved = await callDb(page, "reassignSlide", [
    planned[0].id,
    { assayType: "stain", assayName: "PAS" },
  ]);
  const after = await sql<{ code: string; stack: number | null; cut: string | null; stage: string }>(
    page,
    `SELECT slide_code AS code, stack_id AS stack, stage_cut_at AS cut, current_stage AS stage
       FROM slides WHERE id = ?`,
    [planned[0].id],
  );

  if (moved.ok && after[0]?.stack != null && !after[0]?.cut) {
    await claim(
      findings,
      "uncut slide reassigned into a rack",
      `reassignSlide moved ${after[0].code} into staining rack ${after[0].stack} while it was ` +
        `still a planned, uncut slide — its stage is now "${after[0].stage}" with no cut date.`,
      async () => {
        // Second route: does the BOARD show it in Staining? A row in a rack that
        // the board does not draw would be a different (smaller) problem.
        const onBoard = await count(
          page,
          `SELECT COUNT(*) FROM slide_stacks st
             JOIN slides sl ON sl.stack_id = st.id
            WHERE st.closed_at IS NULL AND st.kind = 'stain' AND sl.stage_cut_at IS NULL`,
        );
        return {
          holds: onBoard > 0,
          how: `${onBoard} uncut slide(s) sit in open staining racks, counted from the rack side`,
        };
      },
    );
  } else {
    findings.push({
      where: "uncut slide reassigned into a rack",
      severity: "observation",
      detail: moved.ok
        ? `reassignment left the slide at stack ${after[0]?.stack}, cut ${after[0]?.cut}`
        : `refused: ${moved.error}`,
    });
  }

  await checkInvariants(page, findings, "after the reassignment probe");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
