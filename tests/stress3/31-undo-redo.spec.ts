import { test, expect, boot, seedLarge, checkInvariantsFast, rng } from "../stress2/driver";
import { MOVES, callMove } from "./moves";
import {
  census,
  checkStructure,
  fingerprint,
  fingerprintDiff,
  pressUndo,
  recordUndoPoint,
  undoDepths,
} from "./driver3";
import { checkViewsAgainstData } from "./views";

/**
 * Undo and redo, taken seriously.
 *
 * Undo here is not a per-row inverse — it swaps the ENTIRE SQLite image back
 * (`src/lib/undo.ts`). That design is very hard to get subtly wrong and very easy
 * to get catastrophically wrong, so the test that fits it is a whole-image
 * comparison: fingerprint the database, make a move, press the real Undo button,
 * fingerprint again, and insist on byte-identical workflow state.
 *
 * Four tables are excluded and each exclusion is deliberate — `driver3.ts`
 * explains why the session and the audit trail must survive a restore rather
 * than be rolled back with it.
 *
 * The button is the real one in the toolbar. Only the RECORDING half is
 * reproduced by the harness, because the explorer drives the data layer and
 * nothing else would fill the stack; the popping, the restore, the session
 * preservation and the refetch are all the app's own code.
 */

const SEED = Number(process.env.STRESS_SEED ?? 20260813);

test("undo returns the database to exactly what it was, move after move", async ({
  page,
  findings,
}) => {
  test.setTimeout(900_000);
  await boot(page);
  await seedLarge(page, { projects: 3, samplesPerProject: 12, cutFraction: 0.8 });

  const random = rng(SEED + 1);
  let checked = 0;

  for (let i = 0; i < 40 && checked < 24; i += 1) {
    const move = MOVES[Math.floor(random() * MOVES.length)];
    const planned = await move.plan(page, random);
    if (!planned || planned === "ui") continue;

    const before = await fingerprint(page);
    const recorded = await recordUndoPoint(page, move.label);
    if (!recorded) {
      findings.push({
        where: "undo",
        severity: "defect",
        detail: "snapshotDb() failed — the undo point could not be recorded at all",
        corroboration: "the call returned false rather than throwing into the page",
      });
      continue;
    }

    const outcome = await callMove(page, planned);
    if (outcome !== "ok") continue;

    const after = await fingerprint(page);
    if (fingerprintDiff(before, after).length === 0) {
      // The move was accepted but changed nothing. Not necessarily wrong (a
      // no-op tick, say), and undoing it proves nothing, so skip rather than
      // bank a vacuous pass — the exact failure v1 shipped four of.
      continue;
    }

    const pressed = await pressUndo(page, "Undo");
    expect(pressed, `Undo was enabled after "${move.label}"`).toBe(true);

    const restored = await fingerprint(page);
    const drift = fingerprintDiff(before, restored);
    if (drift.length > 0) {
      findings.push({
        where: `undo · ${move.label}`,
        severity: "defect",
        detail: `undo did not restore the database: ${drift.map((d) => d.detail).join("; ")}`,
        corroboration:
          "compared table-by-table against the pre-move image, excluding only the four " +
          "tables a restore is documented to preserve rather than roll back",
      });
    }

    // ...and forward again. Redo must land on the post-move image, not somewhere
    // between the two.
    const redone = await pressUndo(page, "Redo");
    if (redone) {
      const forward = await fingerprint(page);
      const forwardDrift = fingerprintDiff(after, forward);
      if (forwardDrift.length > 0) {
        findings.push({
          where: `redo · ${move.label}`,
          severity: "defect",
          detail: `redo did not restore the post-move state: ${forwardDrift
            .map((d) => d.detail)
            .join("; ")}`,
          corroboration: "compared against the image captured immediately after the move itself",
        });
      }
    } else {
      findings.push({
        where: `redo · ${move.label}`,
        severity: "defect",
        detail: "Redo was disabled immediately after an Undo, so the move cannot be reapplied",
        corroboration: "the control's own disabled state, read from the DOM",
      });
    }

    checked += 1;
  }

  console.log(`round-tripped ${checked} state-changing moves through undo and redo`);
  expect(checked, "the run actually exercised undo on real changes").toBeGreaterThan(8);
  await checkStructure(page, findings, "after undo round-trips");
});

test("a deep undo storm walks all the way back, and all the way forward", async ({
  page,
  findings,
}) => {
  test.setTimeout(1_200_000);
  await boot(page);
  await seedLarge(page, { projects: 3, samplesPerProject: 14, cutFraction: 0.8 });

  const base = await fingerprint(page);
  const random = rng(SEED + 2);
  const labels: string[] = [];

  // Thirty stacked moves. The store keeps 100, so nothing is being silently
  // trimmed here — that limit gets its own check below.
  for (let i = 0; labels.length < 30 && i < 90; i += 1) {
    const move = MOVES[Math.floor(random() * MOVES.length)];
    const planned = await move.plan(page, random);
    if (!planned || planned === "ui") continue;
    await recordUndoPoint(page, `${labels.length}:${move.label}`);
    if ((await callMove(page, planned)) === "ok") labels.push(move.label);
    else {
      // The move was refused, so the undo point we just pushed corresponds to no
      // change. Leave it: an undo entry for a no-op is exactly the situation a
      // user creates by cancelling out of something, and it must be harmless.
    }
  }

  const peak = await fingerprint(page);
  const peakCensus = await census(page);
  console.log(`30 moves deep: ${JSON.stringify(peakCensus)}`);

  let undone = 0;
  while (await pressUndo(page, "Undo")) {
    undone += 1;
    if (undone > 120) break;
  }
  console.log(`unwound ${undone} entries`);

  const unwound = await fingerprint(page);
  const backDrift = fingerprintDiff(base, unwound);
  if (backDrift.length > 0) {
    findings.push({
      where: "undo storm",
      severity: "defect",
      detail:
        `after unwinding every entry the database is not what it was at the start: ` +
        backDrift.map((d) => d.detail).join("; "),
      corroboration: `${undone} undo presses, each confirmed by the stack depth changing`,
    });
  }

  await checkInvariantsFast(page, findings, "fully unwound");
  await checkStructure(page, findings, "fully unwound");
  await checkViewsAgainstData(page, findings, "fully unwound", { refresh: false });

  let redone = 0;
  while (await pressUndo(page, "Redo")) {
    redone += 1;
    if (redone > 120) break;
  }
  console.log(`rewound ${redone} entries`);

  if (redone !== undone) {
    findings.push({
      where: "redo storm",
      severity: "defect",
      detail: `${undone} entries went back but only ${redone} came forward`,
      corroboration: "both counted by the stack depth moving, not by the click landing",
    });
  }

  const forward = await fingerprint(page);
  const forwardDrift = fingerprintDiff(peak, forward);
  if (forwardDrift.length > 0) {
    findings.push({
      where: "redo storm",
      severity: "defect",
      detail:
        `redoing everything did not return to the state before the unwind: ` +
        forwardDrift.map((d) => d.detail).join("; "),
      corroboration: "compared against the image captured at the deepest point of the walk",
    });
  }

  await checkInvariantsFast(page, findings, "fully rewound");
  await checkViewsAgainstData(page, findings, "fully rewound", { refresh: false });
});

test("a new action after an undo discards the redo branch", async ({ page, findings }) => {
  test.setTimeout(600_000);
  await boot(page);
  await seedLarge(page, { projects: 2, samplesPerProject: 8, cutFraction: 0.9 });

  const random = rng(SEED + 3);
  const perform = async (): Promise<boolean> => {
    for (let i = 0; i < 30; i += 1) {
      const move = MOVES[Math.floor(random() * MOVES.length)];
      const planned = await move.plan(page, random);
      if (!planned || planned === "ui") continue;
      await recordUndoPoint(page, move.label);
      if ((await callMove(page, planned)) === "ok") return true;
    }
    return false;
  };

  expect(await perform()).toBe(true);
  expect(await perform()).toBe(true);
  expect(await perform()).toBe(true);

  await pressUndo(page, "Undo");
  await pressUndo(page, "Undo");
  const mid = await undoDepths(page);
  expect(mid.redo, "two undos leave two entries to redo").toBe(2);

  // Branch: a fresh action on top of an undone one. The redone future no longer
  // exists, and offering it would restore an image that never followed from the
  // present.
  expect(await perform()).toBe(true);
  const afterBranch = await undoDepths(page);

  if (afterBranch.redo !== 0) {
    findings.push({
      where: "undo branch",
      severity: "defect",
      detail: `after acting on top of an undo, ${afterBranch.redo} redo entries survived — ` +
        `redoing one would swap in a database that never followed from the current state`,
      corroboration: "read from the store itself, and the Redo control's disabled state below",
    });
  }
  const redoEnabled = await page
    .getByTitle("Redo (Ctrl+Y)")
    .isEnabled()
    .catch(() => false);
  expect(redoEnabled, "the Redo control is greyed out once the branch is discarded").toBe(false);
});

test("undo restores a removed slide, record and all", async ({ page, findings }) => {
  test.setTimeout(600_000);
  await boot(page);
  await seedLarge(page, { projects: 1, samplesPerProject: 6, cutFraction: 1 });

  const target = await page.evaluate(() => {
    const select = (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] })
      .__SHIM_SELECT__;
    return (
      select(`SELECT id, slide_code FROM slides WHERE current_stage <> 'removed' LIMIT 1`) as Array<{
        id: number;
        slide_code: string;
      }>
    )[0];
  });
  expect(target, "the seed produced a slide to remove").toBeTruthy();

  const before = await fingerprint(page);
  await recordUndoPoint(page, `Remove ${target.slide_code}`);
  expect(await callMove(page, { fn: "removeSlide", args: [target.id, "dropped it"] })).toBe("ok");

  const removedNow = await page.evaluate(
    (id) =>
      (
        (
          window as unknown as { __SHIM_SELECT__: (s: string, p?: unknown[]) => unknown[] }
        ).__SHIM_SELECT__(`SELECT current_stage AS s FROM slides WHERE id = ?`, [id]) as Array<{
          s: string;
        }>
      )[0]?.s,
    target.id,
  );
  expect(removedNow, "the removal actually happened, so undoing it means something").toBe("removed");

  expect(await pressUndo(page, "Undo")).toBe(true);

  const restored = await fingerprint(page);
  const drift = fingerprintDiff(before, restored);
  if (drift.length > 0) {
    findings.push({
      where: "undo · removeSlide",
      severity: "defect",
      detail:
        `undoing a removal left the database changed: ${drift.map((d) => d.detail).join("; ")} — ` +
        `the removal writes a timeline event and burns nothing, so a clean undo must erase both`,
      corroboration: "whole-image comparison against the pre-removal state",
    });
  }
});
