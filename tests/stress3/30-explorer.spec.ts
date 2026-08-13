import { test, expect, boot, seedLarge, checkInvariantsFast, rng, sql } from "../stress2/driver";
import { MOVES, callMove } from "./moves";
import { census, checkStructure } from "./driver3";
import { checkViewsAgainstData, checkBoardSelfConsistency } from "./views";

/**
 * The explorer — many walkers, a wide move set, and the SCREEN in the loop.
 *
 * v2's swarm proved the store stays coherent. It could not have caught #117,
 * #118 or #119, all of which were a perfectly coherent database rendered
 * wrongly, because across five spec files v2 clicked exactly seven times and all
 * seven were signing in.
 *
 * So this walk keeps v2's method — seeded, invariant-checked after every round,
 * falsified before reporting — and adds two things:
 *
 *  1. Moves that reach ACROSS the workflow rather than along it. Renaming a
 *     project while its codes are in use, retiring an agent open racks depend on,
 *     archiving a block mid-cut, reverting a block's stage while its slides are
 *     downstream. Bugs live where one module's change invalidates another
 *     module's assumption, and no per-module test looks there.
 *  2. A view checkpoint every N moves: the board and the Logs are opened and
 *     compared against counts recomputed from the store.
 */

const SEED = Number(process.env.STRESS_SEED ?? 20260813);
const WALKERS = Number(process.env.STRESS_WALKERS ?? 10);
const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 26);
const VIEW_EVERY = Number(process.env.STRESS_VIEW_EVERY ?? 4);

test("explorer: ten walkers, twenty-one moves, the screen checked throughout", async ({
  page,
  findings,
  consoleErrors,
}) => {
  test.setTimeout(1_500_000);
  await boot(page);

  const built = await seedLarge(page, { projects: 5, samplesPerProject: 26, cutFraction: 0.75 });
  console.log(`seeded ${built.samples} blocks / ${built.slides} slides in ${built.ms}ms`);
  console.log(`seed=${SEED} walkers=${WALKERS} rounds=${ROUNDS}`);

  // A baseline check. If the board is already inconsistent before a single
  // walker moves, every later finding is unattributable — and that failure has
  // happened, which is why it is checked rather than assumed.
  const baseline = await checkViewsAgainstData(page, findings, "baseline");
  const baselineInvariants = await checkInvariantsFast(page, findings, "baseline");
  expect(
    baseline + baselineInvariants,
    "the seeded board must be consistent before the walk begins",
  ).toBe(0);

  const random = rng(SEED);
  const attempted = new Map<string, number>();
  const refused = new Map<string, number>();
  let performed = 0;

  for (let round = 0; round < ROUNDS; round += 1) {
    for (let walker = 0; walker < WALKERS; walker += 1) {
      const move = MOVES[Math.floor(random() * MOVES.length)];
      const planned = await move.plan(page, random);
      if (!planned || planned === "ui") continue;

      attempted.set(move.label, (attempted.get(move.label) ?? 0) + 1);
      const outcome = await callMove(page, planned);
      performed += 1;
      if (outcome !== "ok") {
        // A refusal is not a bug — most of them are the guards doing their job.
        // They are counted so the run can be read afterwards, and so a move that
        // is refused 100% of the time (i.e. is never actually exercising
        // anything) shows up rather than hiding as apparent coverage.
        refused.set(`${move.label}: ${outcome}`, (refused.get(`${move.label}: ${outcome}`) ?? 0) + 1);
      }
    }

    const broken = await checkInvariantsFast(page, findings, `round ${round}`);
    if (broken > 0) {
      console.log(`round ${round}: ${broken} invariant(s) broken`);
    }

    if (round % VIEW_EVERY === VIEW_EVERY - 1) {
      // The expensive, three-way check: database vs badge vs cards.
      await checkViewsAgainstData(page, findings, `round ${round} · views`);
    } else {
      // The cheap one, run every other round: whatever a column believes its
      // population to be, it must draw that many cards. No domain agreement
      // needed, so it cannot produce a false positive from a predicate I got
      // wrong.
      await checkBoardSelfConsistency(page, findings, `round ${round} · board`);
    }
  }

  await checkStructure(page, findings, "after the walk");

  const final = await census(page);
  console.log(
    `performed ${performed} moves → ${JSON.stringify(final)}\n` +
      `attempted: ${JSON.stringify(Object.fromEntries(attempted))}`,
  );
  const refusals = [...refused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
  console.log(`refusals (top):\n${refusals.map(([k, n]) => `  ${n}× ${k}`).join("\n")}`);

  // A move that never once succeeded is coverage the run did not actually have.
  for (const [label, tries] of attempted) {
    const refusedCount = [...refused.entries()]
      .filter(([k]) => k.startsWith(`${label}: `))
      .reduce((sum, [, n]) => sum + n, 0);
    if (tries >= 5 && refusedCount === tries) {
      findings.push({
        where: "coverage",
        severity: "observation",
        detail: `"${label}" was attempted ${tries}× and refused every time — this run did not exercise it`,
        corroboration: "counted from the outcome of each call, not inferred",
      });
    }
  }

  const uncaught = consoleErrors.filter((e) => e.startsWith("UNCAUGHT"));
  if (uncaught.length) {
    findings.push({
      where: "console",
      severity: "defect",
      detail: `${uncaught.length} uncaught error(s): ${uncaught.slice(0, 5).join(" | ")}`,
      corroboration: "captured from pageerror, which only fires on a genuinely unhandled throw",
    });
  }

  // The walk itself must not have destroyed the record. This is the app's
  // founding principle — nothing is ever deleted — so it is asserted, not merely
  // reported.
  const survived = await sql<{ n: number }>(page, `SELECT COUNT(*) AS n FROM slides`);
  expect(Number(survived[0]?.n ?? 0), "no slide row is ever destroyed").toBeGreaterThanOrEqual(
    built.slides,
  );
});
