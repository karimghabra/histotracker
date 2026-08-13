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
 * The things a real user does that a scripted test never does.
 *
 * v1 drove every action once, in order, waiting politely for each to finish.
 * Nobody works like that. They double-click when the app feels slow, they paste
 * a paragraph into a name field, and they act on a card that moved a second ago.
 *
 * The double-submit case is not merely rude input: `db.ts` is full of
 * read-then-write sequences across `await` boundaries (`nextSlideLetter` reads a
 * high-water mark, then a later statement records it). JavaScript is
 * single-threaded but these interleave, so two overlapping calls can both read
 * the same mark. That is a real race on a real code path, and it is exactly what
 * a user generates by clicking twice.
 */

async function boardWithACut(page: import("@playwright/test").Page) {
  await boot(page);
  await seed(page, { projects: 1, samplesPerProject: 2 });
  const blocks = await sql<{ id: number }>(page, `SELECT id FROM samples ORDER BY id`);
  for (const block of blocks) await embed(page, block.id);
  await callDb(page, "createSectionRequests", [
    blocks[0].id,
    [{ duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" }],
  ]);
  const groups = await sql<{ id: number }>(page, `SELECT id FROM section_requests ORDER BY id`);
  for (const group of groups) {
    await callDb(page, "updateSectionStage", [group.id, "sectioned"]);
    await callDb(page, "updateSectionStage", [group.id, "stain_requested"]);
  }
  return { blocks, groups };
}

/** Fire the same call twice without awaiting the first — a double click. */
async function twiceAtOnce(
  page: import("@playwright/test").Page,
  fn: string,
  args: unknown[],
): Promise<{ results: string[] }> {
  const results = (await page.evaluate(
    async ([name, params]) => {
      const mod = (await import("/src/lib/db.ts")) as unknown as Record<
        string,
        (...a: unknown[]) => Promise<unknown>
      >;
      const target = mod[name as string];
      const attempt = async () => {
        try {
          await target(...(params as unknown[]));
          return "ok";
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      };
      // Deliberately NOT awaited in sequence: both start before either finishes.
      return Promise.all([attempt(), attempt()]);
    },
    [fn, args] as const,
  )) as string[];
  return { results };
}

test("abuse: clicking twice must not issue the same slide letter twice", async ({
  page,
  consoleErrors,
  findings,
}) => {
  const { groups } = await boardWithACut(page);

  const before = await count(page, `SELECT COUNT(*) FROM slides`);
  const { results } = await twiceAtOnce(page, "addSlideToSection", [groups[0].id, { extra: true }]);
  const after = await count(page, `SELECT COUNT(*) FROM slides`);

  const codes = await sql<{ code: string; n: number }>(
    page,
    `SELECT slide_code AS code, COUNT(*) AS n FROM slides GROUP BY slide_code HAVING COUNT(*) > 1`,
  );
  findings.push({
    where: "abuse · double click",
    severity: "observation",
    detail: `two overlapping "add a slide" calls → ${JSON.stringify(results)}; slides ${before} → ${after}`,
  });

  if (codes.length > 0) {
    await claim(
      findings,
      "abuse · double click",
      `two overlapping calls issued the same slide code: ${JSON.stringify(codes)}`,
      async () => {
        const dupes = await count(
          page,
          `SELECT COUNT(*) FROM (SELECT slide_code FROM slides GROUP BY slide_code HAVING COUNT(*) > 1)`,
        );
        return { holds: dupes > 0, how: `${dupes} duplicated code(s) counted a second way` };
      },
    );
  }

  // Whatever happened, the letter mark must still be ahead of every slide, or
  // the NEXT cut will reissue a letter (#73).
  const marks = await sql<{ code: string; issued: number; slides: number }>(
    page,
    `SELECT s.sample_code AS code, COALESCE(s.slides_issued, 0) AS issued, COUNT(sl.id) AS slides
       FROM samples s
       JOIN section_requests sr ON sr.sample_id = s.id
       JOIN slides sl ON sl.section_request_id = sr.id
      GROUP BY s.id`,
  );
  for (const mark of marks) {
    if (Number(mark.slides) > Number(mark.issued)) {
      findings.push({
        where: "abuse · double click",
        severity: "defect",
        detail:
          `${mark.code} holds ${mark.slides} slides but its high-water mark is ${mark.issued} — ` +
          `the next slide will reuse a letter (#73)`,
        corroboration: "counted from the slides side and the samples side together",
      });
    }
  }

  await checkInvariants(page, findings, "after a double click");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("abuse: overlapping stain requests on one block", async ({
  page,
  consoleErrors,
  findings,
}) => {
  const { blocks } = await boardWithACut(page);
  const { results } = await twiceAtOnce(page, "requestStainForSample", [
    { sampleId: blocks[1].id, assayType: "stain", assayName: "H&E" },
  ]);
  findings.push({
    where: "abuse · overlapping requests",
    severity: "observation",
    detail: `two overlapping stain requests → ${JSON.stringify(results)}`,
  });
  await checkInvariants(page, findings, "after overlapping requests");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("abuse: overlapping relabels of the same slide", async ({ page, consoleErrors, findings }) => {
  const { blocks } = await boardWithACut(page);
  const slide = await sql<{ id: number }>(page, `SELECT id FROM slides ORDER BY id LIMIT 1`);
  const { results } = await twiceAtOnce(page, "relabelSlideToSample", [
    slide[0].id,
    blocks[1].id,
    "abuse probe",
  ]);
  const landed = await sql<{ code: string; sample: number }>(
    page,
    `SELECT sl.slide_code AS code, sr.sample_id AS sample
       FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sl.id = ?`,
    [slide[0].id],
  );
  findings.push({
    where: "abuse · overlapping relabels",
    severity: "observation",
    detail: `→ ${JSON.stringify(results)}; the slide ended as ${landed[0]?.code} under sample ${landed[0]?.sample}`,
  });
  await checkInvariants(page, findings, "after overlapping relabels");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("abuse: hostile text in every field that takes text", async ({
  page,
  consoleErrors,
  findings,
}) => {
  await boot(page);
  await seed(page, { projects: 1, samplesPerProject: 1 });
  const project = await sql<{ id: number; code: string }>(page, `SELECT id, code FROM projects`);

  const hostile: Array<[string, string]> = [
    ["empty", ""],
    ["whitespace only", "   \t  "],
    ["quote and semicolon", `O'Brien; DROP TABLE slides;--`],
    ["angle brackets", `<script>alert(1)</script>`],
    ["newlines", "line one\nline two\r\nline three"],
    ["unicode", "α-SMA · 切片 · 🧫"],
    ["very long", "x".repeat(5000)],
    ["percent and underscore", "100%_LIKE_wildcards"],
  ];

  const outcomes: string[] = [];
  for (const [label, value] of hostile) {
    const made = await callDb(page, "addSample", [
      {
        project_id: project[0].id,
        sample_description: value,
        processing_type: "Short",
        fixative_agent: "Z-Fix",
        needs_decalcification: 0,
        cut_notes: value,
        slide_notes: value,
        stains: "",
        preselected_stains: [],
        overall_notes: value,
      },
      project[0].code,
    ]);
    outcomes.push(`${label}: ${made.ok ? "accepted" : `refused (${made.error.slice(0, 48)})`}`);
  }
  findings.push({
    where: "abuse · hostile text",
    severity: "observation",
    detail: `sample descriptions — ${outcomes.join("; ")}`,
  });

  // #88 says a blank description is refused. Whitespace is blank.
  const blanks = await count(
    page,
    `SELECT COUNT(*) FROM samples WHERE TRIM(sample_description) = ''`,
  );
  if (blanks > 0) {
    await claim(
      findings,
      "abuse · hostile text",
      `${blanks} sample(s) exist with an effectively empty description — #88 requires one`,
      async () => {
        const again = await count(
          page,
          `SELECT COUNT(*) FROM samples WHERE sample_description IS NULL OR LENGTH(TRIM(sample_description)) = 0`,
        );
        return { holds: again > 0, how: `${again} counted with a different predicate` };
      },
    );
  }

  // Nothing hostile may reach the schema: the table is still there and readable.
  const alive = await count(page, `SELECT COUNT(*) FROM slides`);
  findings.push({
    where: "abuse · hostile text",
    severity: "observation",
    detail: `after ${hostile.length} hostile inputs the slides table is still queryable (${alive} rows)`,
  });

  await checkInvariants(page, findings, "after hostile text");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("abuse: acting on things that have already moved or gone", async ({
  page,
  consoleErrors,
  findings,
}) => {
  const { blocks, groups } = await boardWithACut(page);
  const slide = await sql<{ id: number }>(page, `SELECT id FROM slides ORDER BY id LIMIT 1`);

  // Remove it, then try everything else on it. A stale drawer does exactly this.
  await callDb(page, "removeSlide", [slide[0].id, "gone"]);

  const attempts: Array<[string, unknown[]]> = [
    ["reassignSlide", [slide[0].id, { assayType: "stain", assayName: "PAS" }]],
    ["reassignSlide", [slide[0].id, { extra: true }]],
    ["relabelSlideToSample", [slide[0].id, blocks[1].id, "stale"]],
    ["setSlidePicturesTaken", [slide[0].id, true]],
    ["removeSlide", [slide[0].id, "again"]],
  ];
  const outcomes: string[] = [];
  for (const [fn, args] of attempts) {
    const r = await callDb(page, fn, args);
    outcomes.push(`${fn}: ${r.ok ? "ACCEPTED" : `refused (${r.error.slice(0, 44)})`}`);
  }
  findings.push({
    where: "abuse · stale references",
    severity: "observation",
    detail: `on a slide that was already removed — ${outcomes.join("; ")}`,
  });

  // Whatever each call decided, the removed slide must still read as removed and
  // hold no rack place. "Accepted" is only acceptable if it changed nothing.
  const state = await sql<{ stage: string; stack: number | null }>(
    page,
    `SELECT current_stage AS stage, stack_id AS stack FROM slides WHERE id = ?`,
    [slide[0].id],
  );
  if (state[0]?.stage !== "removed" || state[0]?.stack !== null) {
    await claim(
      findings,
      "abuse · stale references",
      `a removed slide was brought back by a stale action: stage=${state[0]?.stage}, stack=${state[0]?.stack}`,
      async () => {
        const back = await count(
          page,
          `SELECT COUNT(*) FROM slides WHERE id = ? AND (current_stage <> 'removed' OR stack_id IS NOT NULL)`,
          [slide[0].id],
        );
        return { holds: back > 0, how: `${back} row(s) match the resurrection predicate` };
      },
    );
  }

  // …and the same for a group that has already moved on.
  const staleGroup = await callDb(page, "updateSectionStage", [groups[0].id, "needs_sectioning"]);
  findings.push({
    where: "abuse · stale references",
    severity: "observation",
    detail: `moving a group BACKWARDS to needs_sectioning: ${
      staleGroup.ok ? "ACCEPTED" : `refused (${staleGroup.error.slice(0, 60)})`
    }`,
  });

  await checkInvariants(page, findings, "after stale actions");
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
