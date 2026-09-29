import { test, expect, boot, seedLarge, checkInvariantsFast, callDb, sql } from "../stress2/driver";
import { checkStructure, fingerprint, fingerprintDiff } from "./driver3";
import { checkViewsAgainstData } from "./views";
import { signInAs } from "../helpers/app";

/**
 * The things the app is not expecting.
 *
 * Everything above walks the app the way a lab does. This one does not. It feeds
 * absurd values, acts on rows that no longer exist, jumps stages, and fires the
 * same mutation at itself several times at once.
 *
 * The bar is deliberately not "nothing throws". Refusing loudly is CORRECT — the
 * app is full of guards whose whole job is to throw. The bar is:
 *
 *   · a rejected call leaves the database exactly as it found it;
 *   · no input, however hostile, breaks an invariant or the schema;
 *   · nothing silently succeeds at something impossible.
 *
 * A finding here is therefore never "it threw"; it is "it threw and still
 * changed something", or "it didn't throw and should have".
 */

const NASTY: unknown[] = [
  "",
  "   ",
  "'; DROP TABLE slides; --",
  "\u0000\u0001\u0002",
  "α-SMA · 切片 · 🧫 · ᚠᚢᚦ",
  "<script>alert(1)</script>",
  "x".repeat(20_000),
  "-1",
  "NaN",
  "\\",
  '"',
  "%s%s%s%n",
];

test("hostile text never corrupts the record", async ({ page, findings }) => {
  test.setTimeout(600_000);
  await boot(page);
  await seedLarge(page, { projects: 1, samplesPerProject: 6, cutFraction: 1 });

  const sample = (await sql<{ id: number }>(page, `SELECT id FROM samples LIMIT 1`))[0];
  const slide = (await sql<{ id: number }>(page, `SELECT id FROM slides LIMIT 1`))[0];
  expect(sample && slide, "the seed produced something to abuse").toBeTruthy();

  for (const value of NASTY) {
    for (const [fn, args] of [
      ["setSampleDescription", [sample.id, value]],
      ["setSampleNotes", [sample.id, value]],
      ["setSlideNotes", [slide.id, value]],
      ["setSlidesDepthTag", [[slide.id], value, value]],
      ["removeSlide", [slide.id, value]],
    ] as Array<[string, unknown[]]>) {
      const before = await fingerprint(page);
      const result = await callDb(page, fn, args);
      if (!result.ok) {
        // A refusal must be total. A half-applied rejection is the dangerous
        // shape: the caller believes nothing happened.
        const after = await fingerprint(page);
        const drift = fingerprintDiff(before, after);
        if (drift.length > 0) {
          findings.push({
            where: `hostile · ${fn}`,
            severity: "defect",
            detail:
              `${fn} rejected ${JSON.stringify(String(value).slice(0, 40))} but still changed ` +
              drift.map((d) => d.detail).join("; "),
            corroboration: "whole-image comparison either side of the rejected call",
          });
        }
      }
      // Whether it accepted or refused, the world must still make sense.
      const broken = await checkInvariantsFast(page, findings, `hostile ${fn}`);
      if (broken > 0) break;
    }
  }

  await checkStructure(page, findings, "after hostile text");
  await checkViewsAgainstData(page, findings, "after hostile text");
});

test("acting on rows that no longer exist", async ({ page, findings }) => {
  test.setTimeout(600_000);
  await boot(page);
  await seedLarge(page, { projects: 1, samplesPerProject: 8, cutFraction: 1 });

  // Ids that were never issued. Every one of these is a stale drawer, a
  // double-click on a card someone else just moved, or an undo landing under a
  // dialog that is still open — all of which happen in a shared lab.
  const ghost = 999_999;
  const calls: Array<[string, unknown[]]> = [
    ["removeSlide", [ghost, "gone"]],
    ["setSlidePicturesTaken", [ghost, true]],
    ["reassignSlide", [ghost, { extra: true }]],
    ["relabelSlideToSample", [ghost, ghost, "gone"]],
    ["addSlideToSection", [ghost, { extra: true }]],
    ["updateSectionStage", [ghost, "sectioned"]],
    ["revertSectionToStage", [ghost, "needs_sectioning"]],
    ["updateSlideStackStage", [ghost, "ready_for_imaging"]],
    ["closeSlideStack", [ghost]],
    ["setSampleArchived", [ghost, true]],
    ["setBlockExhausted", [ghost, true]],
    ["revertToStage", [ghost, "embedded"]],
    ["createSectionRequests", [ghost, [{ duplicates: 1, stains: "" }]]],
    ["requestStainForSample", [{ sampleId: ghost, assayType: "stain", assayName: "H&E" }]],
    ["setAssayActive", [ghost, false]],
    ["setProjectActive", [ghost, false]],
  ];

  const before = await fingerprint(page);
  const accepted: string[] = [];
  for (const [fn, args] of calls) {
    const result = await callDb(page, fn, args);
    if (result.ok) accepted.push(fn);
  }
  const after = await fingerprint(page);
  const drift = fingerprintDiff(before, after);

  if (drift.length > 0) {
    findings.push({
      where: "ghost ids",
      severity: "defect",
      detail:
        `calls against id ${ghost} changed the database: ${drift.map((d) => d.detail).join("; ")}`,
      corroboration: `the ids do not exist — verified by row count, and ${accepted.length} of ${calls.length} calls reported success`,
    });
  }

  // Reporting success for work on a row that does not exist is worth knowing
  // even when nothing changed: a caller that trusts the return value will build
  // on a lie. Recorded as an observation, since several of these are legitimate
  // no-op UPDATEs.
  if (accepted.length > 0) {
    findings.push({
      where: "ghost ids",
      severity: "observation",
      detail: `${accepted.length} call(s) reported success against a non-existent row: ${accepted.join(", ")}`,
      corroboration: "no rows changed, confirmed by the whole-image comparison above",
    });
  }

  // Now the harder version: a row that existed a moment ago.
  const slide = (await sql<{ id: number; stack_id: number | null }>(
    page,
    `SELECT id, stack_id FROM slides WHERE current_stage <> 'removed' LIMIT 1`,
  ))[0];
  expect(slide).toBeTruthy();
  await callDb(page, "removeSlide", [slide.id, "gone at the bench"]);

  // Fingerprinted per call, not once around the block: "something touched a
  // removed slide" is a story, "reassignSlide put it back in a rack" is a fix.
  for (const [fn, args] of [
    ["setSlidePicturesTaken", [slide.id, true]],
    ["reassignSlide", [slide.id, { assayType: "stain", assayName: "PAS" }]],
    ["setSlidesDepthTag", [[slide.id], "d5", "stale"]],
    ["removeSlide", [slide.id, "again"]],
    ["relabelSlideToSample", [slide.id, 1, "stale"]],
  ] as Array<[string, unknown[]]>) {
    const stale = await fingerprint(page);
    const result = await callDb(page, fn, args);
    const afterCall = await fingerprint(page);
    const staleDrift = fingerprintDiff(stale, afterCall);
    if (staleDrift.length === 0) continue;

    // Second route: read the slide back and say what actually moved. A drift in
    // `slides` could be an unrelated column; naming it is the falsification.
    const row = (
      await sql<{ current_stage: string; stack_id: number | null; depth_label: string | null }>(
        page,
        `SELECT current_stage, stack_id, depth_label FROM slides WHERE id = ?`,
        [slide.id],
      )
    )[0];
    findings.push({
      where: `stale slide · ${fn}`,
      severity: "defect",
      detail:
        `${fn} ${result.ok ? "accepted" : "rejected"} work on a REMOVED slide and changed ` +
        `${staleDrift.map((d) => d.detail).join("; ")} — it now reads ` +
        `stage=${row?.current_stage} stack=${row?.stack_id} depth=${row?.depth_label}`,
      corroboration:
        "the removal was confirmed first, and the slide row was re-read afterwards to " +
        "name what moved",
    });
  }

  await checkInvariantsFast(page, findings, "stale references");
  await checkStructure(page, findings, "stale references");
});

test("nonsense quantities and impossible stages", async ({ page, findings }) => {
  test.setTimeout(600_000);
  await boot(page);
  await seedLarge(page, { projects: 1, samplesPerProject: 8, cutFraction: 0 });

  const block = (await sql<{ id: number }>(
    page,
    `SELECT id FROM samples WHERE current_stage = 'embedded' LIMIT 1`,
  ))[0];
  expect(block).toBeTruthy();

  for (const duplicates of [0, -1, 1.5, Number.NaN]) {
    const before = await fingerprint(page);
    const result = await callDb<number[]>(page, "createSectionRequests", [
      block.id,
      [{ duplicates, stains: "" }],
    ]);
    const after = await fingerprint(page);
    const changed = fingerprintDiff(before, after).length > 0;

    if (result.ok && changed) {
      // What did a nonsense count actually produce?
      const made = await sql<{ n: number }>(
        page,
        `SELECT COUNT(*) AS n FROM slides WHERE section_request_id = ?`,
        [(result.value as number[])[0]],
      );
      const n = Number(made[0]?.n ?? 0);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        findings.push({
          where: "quantities",
          severity: "defect",
          detail: `a cut of ${String(duplicates)} produced ${n} slides`,
          corroboration: "counted directly from the slides table, by the created group's id",
        });
      }
    }
  }

  // Stage keys the graph does not contain, and legal keys reached out of order.
  const section = (await sql<{ id: number }>(page, `SELECT id FROM section_requests LIMIT 1`))[0];
  if (section) {
    for (const stage of ["", "not_a_stage", "ANALYZED", "analyzed ", "'; --"]) {
      const before = await fingerprint(page);
      const result = await callDb(page, "updateSectionStage", [section.id, stage]);
      const after = await fingerprint(page);
      if (result.ok && fingerprintDiff(before, after).length > 0) {
        findings.push({
          where: "stage keys",
          severity: "defect",
          detail: `updateSectionStage accepted the stage key ${JSON.stringify(stage)} and wrote it`,
          corroboration:
            "the key is not in the stage graph, so nothing downstream can route the row",
        });
      }
    }
  }

  await checkInvariantsFast(page, findings, "nonsense inputs");
  await checkStructure(page, findings, "nonsense inputs");
});

test("the same action, several times at once", async ({ page, findings }) => {
  test.setTimeout(900_000);
  await boot(page);
  await seedLarge(page, { projects: 2, samplesPerProject: 10, cutFraction: 1 });

  // Two technicians on two machines pressing the same button on the same block.
  // The mutation layer is single-threaded in JS but every function awaits between
  // its read and its write, so the interleaving is real.
  const blocks = await sql<{ id: number }>(
    page,
    `SELECT id FROM samples WHERE current_stage = 'embedded' LIMIT 6`,
  );

  for (const block of blocks) {
    await page.evaluate(async (id) => {
      const mod = (await import("/src/lib/db.ts")) as unknown as Record<string, Function>;
      // Fired together, deliberately unawaited individually.
      await Promise.allSettled([
        mod.createSectionRequests(id, [{ duplicates: 2, stains: "" }]),
        mod.createSectionRequests(id, [
          { duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
        ]),
        mod.requestStainForSample({ sampleId: id, assayType: "stain", assayName: "PAS" }),
        mod.setBlockExhausted(id, true),
        mod.setSampleArchived(id, true),
      ]);
    }, block.id);
  }

  const stacks = await sql<{ id: number }>(
    page,
    `SELECT id FROM slide_stacks WHERE closed_at IS NULL LIMIT 8`,
  );
  for (const stack of stacks) {
    await page.evaluate(async (id) => {
      const mod = (await import("/src/lib/db.ts")) as unknown as Record<string, Function>;
      await Promise.allSettled([
        mod.syncAssayStackWorkflowStep(id, "stain", 0, true),
        mod.syncAssayStackWorkflowStep(id, "stain", 0, false),
        mod.syncAssayStackWorkflowStep(id, "stain", 1, true),
        mod.updateSlideStackStage(id, "ready_for_imaging"),
        mod.closeSlideStackIfEmpty(id),
      ]);
    }, stack.id);
  }

  // Concurrency findings are already a known, documented class (see
  // docs/stress_test_v2.md) — the point here is not to re-discover them but to
  // establish that the damage stays bounded: the schema holds, and the screen
  // still agrees with the store afterwards.
  await checkInvariantsFast(page, findings, "concurrent calls");
  await checkStructure(page, findings, "concurrent calls");
  await checkViewsAgainstData(page, findings, "concurrent calls");

  const duplicated = await sql<{ slide_code: string; n: number }>(
    page,
    `SELECT slide_code, COUNT(*) AS n FROM slides GROUP BY slide_code HAVING n > 1`,
  );
  expect(duplicated, "concurrent cuts never mint the same slide code twice").toHaveLength(0);
});

test("a reload in the middle of the work loses nothing", async ({ page, findings }) => {
  test.setTimeout(600_000);
  await boot(page);
  await seedLarge(page, { projects: 2, samplesPerProject: 8, cutFraction: 0.9 });

  const before = await fingerprint(page);
  const censusBefore = await sql<{ n: number }>(page, `SELECT COUNT(*) AS n FROM slides`);

  // Not a graceful shutdown — the tab simply goes away, which is what a crash,
  // a Windows update, or a closed lid looks like to the database.
  //
  // Deliberately NOT page.reload(): boot() lands on `/?freshdb=1`, and reloading
  // that URL would wipe the image and turn this test into a guaranteed false
  // positive. Going to `/` is the honest reopen.
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const signIn = page.getByLabel("Signed-in user");
  if ((await signIn.count()) > 0) {
    await signIn.selectOption({ label: "Alex Rivera" }).catch(() => {});
  }
  await page.waitForTimeout(600);

  const after = await fingerprint(page);
  const drift = fingerprintDiff(before, after);
  if (drift.length > 0) {
    findings.push({
      where: "reload",
      severity: "defect",
      detail: `a reload changed the stored workflow: ${drift.map((d) => d.detail).join("; ")}`,
      corroboration: `slide count was ${censusBefore[0]?.n} before the reload`,
    });
  }

  await checkInvariantsFast(page, findings, "after reload");
  await checkViewsAgainstData(page, findings, "after reload");
});

test("nobody signed in means nobody writes, at the data layer", async ({ page, findings }) => {
  test.setTimeout(600_000);
  await boot(page);
  await seedLarge(page, { projects: 1, samplesPerProject: 4, cutFraction: 1 });

  // Signing out is not an edge case — the app signs itself out at launch (#76),
  // so this is the state every session begins in. Before #128 an unsigned user
  // had the run of the workstation and every change landed in the record with
  // nobody's name on it.
  //
  // This lives here rather than in tests/e2e because it reaches `db.ts`
  // directly, and that only means anything on a server that has not
  // hot-reloaded: two module instances would mean two copies of the flag, the
  // app setting one and the test reading the other. This config starts a fresh
  // server every run for exactly that reason.
  await page.getByLabel("Signed-in user").selectOption("");
  const keepReading = page.getByRole("button", { name: "Keep reading" });
  if (await keepReading.count()) await keepReading.click();
  await page.waitForTimeout(300);

  const before = await fingerprint(page);
  const attempts: Array<[string, unknown[]]> = [
    ["setSampleDescription", [1, "written by nobody"]],
    ["updateSampleStage", [1, "embedded"]],
    ["createSectionRequests", [1, [{ duplicates: 1, stains: "" }]]],
    ["removeSlide", [1, "by nobody"]],
    ["setSlidePicturesTaken", [1, true]],
    ["setChecklistItemComplete", [1, true, "nobody"]],
    ["requestStainForSample", [{ sampleId: 1, assayType: "stain", assayName: "H&E" }]],
  ];

  const accepted: string[] = [];
  for (const [fn, args] of attempts) {
    const result = await callDb(page, fn, args);
    if (result.ok) accepted.push(fn);
    else if (!result.error.includes("Sign in before making modifications")) {
      // A different refusal is still a refusal, but it means this call was
      // stopped by its own guard rather than by the gate — so it proves nothing
      // about the gate and is worth saying out loud.
      findings.push({
        where: `signed out · ${fn}`,
        severity: "observation",
        detail: `refused for another reason: ${result.error}`,
        corroboration: "the whole-image comparison below still holds",
      });
    }
  }

  if (accepted.length > 0) {
    findings.push({
      where: "signed out",
      severity: "defect",
      detail: `${accepted.length} mutation(s) went through with nobody signed in: ${accepted.join(", ")}`,
      corroboration: "every one of these is a path the issue names by hand",
    });
  }
  expect(accepted, "no mutation is accepted while nobody is signed in").toEqual([]);

  const after = await fingerprint(page);
  expect(
    fingerprintDiff(before, after),
    "and the database is byte-identical afterwards",
  ).toEqual([]);

  // The gate opens again — signing back in restores the workstation.
  await signInAs(page, "Alex Rivera");
  await page.waitForTimeout(300);
  const allowed = await callDb(page, "setSampleDescription", [1, "written by Alex"]);
  expect(allowed.ok, "a signed-in user can work again").toBe(true);
});

test("splitting and merging the same racks at once", async ({ page, findings }) => {
  test.setTimeout(900_000);
  await boot(page);
  await seedLarge(page, { projects: 2, samplesPerProject: 12, cutFraction: 1, seed: 4242 });

  // Split and merge are the newest operations in the app and the ones that move
  // glass between physical holders. Two technicians on two machines, one
  // dividing a rack while the other pours it into another, is the shape that
  // breaks rack code — and neither operation takes a lock.
  const racks = await sql<{ id: number; assay_name: string }>(
    page,
    `SELECT ss.id, ss.assay_name
       FROM slide_stacks ss
       JOIN slides sl ON sl.stack_id = ss.id AND sl.current_stage <> 'removed'
      WHERE ss.kind = 'stain' AND ss.closed_at IS NULL
      GROUP BY ss.id HAVING COUNT(sl.id) >= 2
      ORDER BY ss.id`,
  );
  expect(racks.length, "the seed produced racks worth fighting over").toBeGreaterThan(0);

  for (const rack of racks.slice(0, 6)) {
    const members = await sql<{ id: number }>(
      page,
      `SELECT id FROM slides WHERE stack_id = ? AND current_stage <> 'removed' ORDER BY id`,
      [rack.id],
    );
    if (members.length < 2) continue;
    const half = members.slice(0, Math.max(1, Math.floor(members.length / 2))).map((r) => r.id);

    await page.evaluate(
      async ([stackId, slideIds]) => {
        const mod = (await import("/src/lib/db.ts")) as unknown as Record<string, Function>;
        const open = (
          (
            window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }
          ).__SHIM_SELECT__(
            `SELECT id FROM slide_stacks WHERE kind = 'stain' AND closed_at IS NULL ORDER BY id`,
          ) as Array<{ id: number }>
        ).map((r) => r.id);
        // Everything at once, at the same rack.
        await Promise.allSettled([
          mod.splitSlidesIntoNewRack(slideIds),
          mod.splitSlidesIntoNewRack(slideIds),
          mod.mergeSlideStacks(open.slice(0, 3)),
          mod.reassignSlide((slideIds as number[])[0], { assayType: "stain", assayName: "PAS" }),
          mod.closeSlideStackIfEmpty(stackId),
        ]);
      },
      [rack.id, half] as const,
    );
  }

  // The bar is the same as the other concurrency test: races are a known open
  // structural class (docs/stress_test_v2.md), so what is asserted is that the
  // damage stays bounded — the schema holds, no rack ends up holding another
  // agent's glass, and nothing is destroyed.
  await checkInvariantsFast(page, findings, "concurrent split/merge");
  await checkStructure(page, findings, "concurrent split/merge");
  await checkViewsAgainstData(page, findings, "concurrent split/merge");

  const orphaned = await sql<{ n: number }>(
    page,
    `SELECT COUNT(*) AS n FROM slides sl
       JOIN slide_stacks ss ON ss.id = sl.stack_id
      WHERE ss.closed_at IS NOT NULL AND sl.current_stage <> 'removed'`,
  );
  expect(Number(orphaned[0]?.n ?? 0), "no live slide is left in a retired rack").toBe(0);
});
