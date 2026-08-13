import {
  test,
  expect,
  sql,
  callDb,
  boot,
  seed,
  embed,
  sentinelTime,
  isSentinel,
  write,
  checkInvariants,
  type Finding,
} from "./driver";

/**
 * Which stamps may a given action rewrite?
 *
 * This is the class that produced v1's near-miss. `nowTimestamp()` stores
 * minutes, so an overwrite performed during a test is INDISTINGUISHABLE from a
 * preserved value — v1 read "kept — good" off two identical strings and I nearly
 * shipped the overwrite. The only way to ask the question honestly is to plant a
 * value the code cannot produce (2019) and see whether it is still there.
 *
 * So: for every action that touches a stage stamp, plant sentinels on every
 * stamp of every slide, run the action, and classify each stamp as SURVIVED or
 * REWRITTEN. The expectations are written out per action, which turns "does this
 * function overwrite history?" from a question nobody asks into a table.
 */

const STAMPS = [
  "stage_cut_at",
  "stage_stain_requested_at",
  "stage_stained_at",
  "stage_coverslipped_at",
  "stage_ready_for_imaging_at",
  "stage_pictures_taken_at",
  "stage_analyzed_at",
] as const;

type Scenario = {
  name: string;
  /** Set the board up and return the ids the action will touch. */
  arrange: (page: import("@playwright/test").Page) => Promise<{
    run: () => Promise<{ ok: boolean; error?: string }>;
    /** Stamps this action is ENTITLED to write, on the slides it acts on. */
    mayWrite: string[];
    slideIds: number[];
  }>;
};

async function boardWithARack(page: import("@playwright/test").Page) {
  await boot(page);
  await seed(page, { projects: 1, samplesPerProject: 2 });
  const blocks = await sql<{ id: number }>(page, `SELECT id FROM samples ORDER BY id`);
  for (const block of blocks) await embed(page, block.id);
  await callDb(page, "createSectionRequests", [
    blocks[0].id,
    [{ duplicates: 2, stains: "H&E", assay_type: "stain", assay_name: "H&E" }],
  ]);
  const groups = await sql<{ id: number }>(page, `SELECT id FROM section_requests ORDER BY id`);
  for (const group of groups) {
    await callDb(page, "updateSectionStage", [group.id, "sectioned"]);
    await callDb(page, "updateSectionStage", [group.id, "stain_requested"]);
  }
  const slides = await sql<{ id: number; stack_id: number | null }>(
    page,
    `SELECT id, stack_id FROM slides ORDER BY id`,
  );
  return { blocks, slides };
}

/** Plant a distinguishable value in every stamp of every slide. */
async function plantSentinels(page: import("@playwright/test").Page): Promise<void> {
  const slides = await sql<{ id: number }>(page, `SELECT id FROM slides ORDER BY id`);
  for (const [index, slide] of slides.entries()) {
    const sets = STAMPS.map((s, i) => `${s} = '${sentinelTime(index * STAMPS.length + i)}'`).join(", ");
    await write(page, `UPDATE slides SET ${sets} WHERE id = ?`, [slide.id]);
  }
}

const SCENARIOS: Scenario[] = [
  {
    name: "ticking a rack's Stained step",
    arrange: async (page) => {
      const { slides } = await boardWithARack(page);
      const stack = slides.find((s) => s.stack_id != null)?.stack_id;
      return {
        slideIds: slides.map((s) => s.id),
        // It records staining. It has no business touching anything else, and —
        // per 0.13.0 — not even this one when a date is already there.
        mayWrite: [],
        run: async () => {
          const r = await callDb(page, "syncAssayStackWorkflowStep", [stack, "stain", 0, true]);
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        },
      };
    },
  },
  {
    name: "ticking a rack's Coverslipped step",
    arrange: async (page) => {
      const { slides } = await boardWithARack(page);
      const stack = slides.find((s) => s.stack_id != null)?.stack_id;
      return {
        slideIds: slides.map((s) => s.id),
        mayWrite: [],
        run: async () => {
          const r = await callDb(page, "syncAssayStackWorkflowStep", [stack, "stain", 1, true]);
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        },
      };
    },
  },
  {
    name: "ticking a cut group's Stained step",
    arrange: async (page) => {
      const { slides } = await boardWithARack(page);
      const groups = await sql<{ id: number }>(page, `SELECT id FROM section_requests ORDER BY id`);
      return {
        slideIds: slides.map((s) => s.id),
        mayWrite: [],
        run: async () => {
          const r = await callDb(page, "syncAssayWorkflowStep", [groups[0].id, "stain", 0, true]);
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        },
      };
    },
  },
  {
    name: "reassigning a slide to another agent",
    arrange: async (page) => {
      const { slides } = await boardWithARack(page);
      const target = slides[0];
      return {
        slideIds: [target.id],
        // It re-homes the slide, so the request stamp may be (re)set — but the
        // physical history of the glass is not its business.
        mayWrite: ["stage_stain_requested_at"],
        run: async () => {
          const r = await callDb(page, "reassignSlide", [
            target.id,
            { assayType: "stain", assayName: "PAS" },
          ]);
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        },
      };
    },
  },
  {
    name: "sending a slide back to extras",
    arrange: async (page) => {
      const { slides } = await boardWithARack(page);
      const target = slides[0];
      return {
        slideIds: [target.id],
        mayWrite: [],
        run: async () => {
          const r = await callDb(page, "reassignSlide", [target.id, { extra: true }]);
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        },
      };
    },
  },
  {
    name: "refiling a slide onto another block",
    arrange: async (page) => {
      const { blocks, slides } = await boardWithARack(page);
      const target = slides[0];
      return {
        slideIds: [target.id],
        // A relabel changes WHERE the glass is filed. It changes nothing about
        // what happened to it — that is the whole policy.
        mayWrite: [],
        run: async () => {
          const r = await callDb(page, "relabelSlideToSample", [
            target.id,
            blocks[1].id,
            "stamp probe",
          ]);
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        },
      };
    },
  },
  {
    name: "removing a slide",
    arrange: async (page) => {
      const { slides } = await boardWithARack(page);
      const target = slides[0];
      return {
        slideIds: [target.id],
        // #83: a removed slide keeps every timestamp it earned. That is the
        // difference between "cut, then lost" and "never existed".
        mayWrite: [],
        run: async () => {
          const r = await callDb(page, "removeSlide", [target.id, "stamp probe"]);
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        },
      };
    },
  },
  {
    name: "advancing a stack to imaging",
    arrange: async (page) => {
      const { slides } = await boardWithARack(page);
      const stack = slides.find((s) => s.stack_id != null)?.stack_id;
      return {
        slideIds: slides.map((s) => s.id),
        mayWrite: ["stage_ready_for_imaging_at"],
        run: async () => {
          const r = await callDb(page, "updateSlideStackStage", [stack, "ready_for_imaging"]);
          return r.ok ? { ok: true } : { ok: false, error: r.error };
        },
      };
    },
  },
];

test("stamps: no action rewrites history it has no business touching", async ({
  page,
  consoleErrors,
  findings,
}) => {
  const table: string[] = [];

  for (const scenario of SCENARIOS) {
    const arranged = await scenario.arrange(page);
    await plantSentinels(page);

    const before = await sql<Record<string, unknown>>(
      page,
      `SELECT id, ${STAMPS.join(", ")} FROM slides WHERE id IN (${arranged.slideIds.join(",")})`,
    );
    const outcome = await arranged.run();
    const after = await sql<Record<string, unknown>>(
      page,
      `SELECT id, ${STAMPS.join(", ")} FROM slides WHERE id IN (${arranged.slideIds.join(",")})`,
    );

    const rewritten = new Set<string>();
    for (const row of after) {
      const was = before.find((b) => b.id === row.id);
      if (!was) continue;
      for (const stamp of STAMPS) {
        // The ONLY honest test: it started as a sentinel, so anything else is a
        // rewrite. Comparing two same-minute values would prove nothing.
        if (isSentinel(was[stamp]) && !isSentinel(row[stamp])) rewritten.add(stamp);
      }
    }

    const illegal = [...rewritten].filter((s) => !arranged.mayWrite.includes(s));
    table.push(
      `${scenario.name}: ${outcome.ok ? "ok" : `refused (${outcome.error?.slice(0, 60)})`} · ` +
        `rewrote {${[...rewritten].join(", ") || "nothing"}} · allowed {${
          arranged.mayWrite.join(", ") || "nothing"
        }}`,
    );

    if (illegal.length > 0) {
      findings.push({
        where: `stamps · ${scenario.name}`,
        severity: "defect",
        detail:
          `rewrote ${illegal.join(", ")} on glass that already carried a date. ` +
          `A stamp is the record of when something physically happened; an action that ` +
          `did not do that thing must not restate when it did.`,
        corroboration:
          "planted 2019 sentinels, which nowTimestamp() cannot produce — so this is a " +
          "rewrite, not two values that happen to share a minute",
      });
    }
  }

  findings.push({
    where: "stamps",
    severity: "observation",
    detail: `what each action rewrote:\n      ${table.join("\n      ")}`,
  });

  await checkInvariants(page, findings, "after the stamp probes");
  expect(
    findings.filter((f) => f.severity === "defect" && f.where.startsWith("stamps ·")),
    "no action may rewrite a stamp it did not earn",
  ).toEqual([]);
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("stamps: unticking clears only what this rack wrote", async ({
  page,
  consoleErrors,
  findings,
}) => {
  // The other half of the 0.12.0 defect, and the half a naive test misses: an
  // untick used to null the column for the WHOLE rack, including dates the rack
  // never wrote. Two slides, one with history, one without.
  const { slides } = await boardWithARack(page);
  const stack = slides.find((s) => s.stack_id != null)?.stack_id;
  const [withHistory, fresh] = slides;

  await write(page, `UPDATE slides SET stage_stained_at = ? WHERE id = ?`, [
    sentinelTime(3),
    withHistory.id,
  ]);
  await write(page, `UPDATE slides SET stage_stained_at = NULL WHERE id = ?`, [fresh.id]);

  await callDb(page, "syncAssayStackWorkflowStep", [stack, "stain", 0, true]);
  await callDb(page, "syncAssayStackWorkflowStep", [stack, "stain", 0, false]);

  const after = await sql<{ id: number; stained: string | null }>(
    page,
    `SELECT id, stage_stained_at AS stained FROM slides WHERE id IN (?, ?)`,
    [withHistory.id, fresh.id],
  );
  const kept = after.find((r) => r.id === withHistory.id)?.stained;
  const cleared = after.find((r) => r.id === fresh.id)?.stained;

  findings.push({
    where: "stamps · untick",
    severity: isSentinel(kept) && cleared === null ? "observation" : "defect",
    detail:
      `the slide that arrived already stained reads ${kept ?? "null"} ` +
      `(planted ${sentinelTime(3)}); the slide this rack stamped reads ${cleared ?? "null"}`,
    corroboration: "sentinel planted in 2019; nowTimestamp() cannot write that value",
  });

  expect(isSentinel(kept), "an untick must not erase a date this rack never wrote").toBe(true);
  expect(cleared, "…and must clear the one it did").toBeNull();
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
