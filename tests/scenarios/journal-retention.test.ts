// The undo journal is bounded (ht-undo-snapshot-on-write-path).
//
// Every journaled change writes an inverse row, and those rows live inside the database file, so
// they ride in every backup and in every snapshot the workstation publishes. A hundred undo steps
// of bulk work is tens of thousands of rows. The journal is therefore trimmed at open, by age and
// by count, at the one moment nothing can be relying on a row: the undo stack is empty until the
// saved history is hydrated, and that is anchored to the journal's ends. On the real db.ts, a real
// SQLite file, relaunched the way the app relaunches.
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";
import { launch, quit, type App } from "../compat/app";
import { currentBuild } from "../compat/builds";

let running: App | null = null;
afterEach(async () => {
  if (running) await quit(running);
  running = null;
});

/** Close the lab and open its file again, as the next launch does. */
async function relaunch(lab: Lab): Promise<App> {
  const machine = lab.app.machine;
  await quit(lab.app);
  running = await launch(currentBuild(), machine);
  return running;
}

const journal = (lab: Lab) => lab.rows(`SELECT seq, stmt FROM undo_journal ORDER BY seq`);

it("forgets journal rows older than the age bound, and keeps the recent ones", async () => {
  const lab = await openLab();
  running = lab.app;
  await lab.sample("a block", "in_ethanol"); // real rows, written now
  const recent = journal(lab).length;
  expect(recent).toBeGreaterThan(0);

  const db = await lab.db.getDb();
  for (const days of [15, 40]) {
    await db.execute(`INSERT INTO undo_journal(stmt, at) VALUES (?, datetime('now', ?))`, [
      `stale ${days}`,
      `-${days} days`,
    ]);
  }
  expect(journal(lab).length).toBe(recent + 2);

  await relaunch(lab);

  const left = journal(lab).map((r) => String(r.stmt));
  expect(left.filter((s) => s.startsWith("stale")), "both stale rows are gone").toEqual([]);
  expect(left.length, "and this week's rows are untouched").toBe(recent);
});

it("keeps only the newest rows once the journal outgrows the count bound", async () => {
  const lab = await openLab();
  running = lab.app;
  await lab.sample("a block", "in_ethanol");
  const db = await lab.db.getDb();
  // One heavy week: more rows than the bound keeps, all of them recent.
  await db.execute(
    `WITH RECURSIVE counted(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counted WHERE n < 20100)
     INSERT INTO undo_journal(stmt) SELECT 'bulk ' || n FROM counted`,
  );
  expect(journal(lab).length).toBeGreaterThan(20_100);

  await relaunch(lab);

  const left = journal(lab).map((r) => String(r.stmt));
  expect(left.length, "trimmed to the bound").toBe(20_000);
  expect(left.at(-1), "the newest row survives").toBe("bulk 20100");
  expect(left.includes("bulk 1"), "the oldest rows are the ones forgotten").toBe(false);
});

it("leaves a journal inside the bound exactly as it is", async () => {
  const lab = await openLab();
  running = lab.app;
  await lab.sample("a block", "in_ethanol");
  const before = journal(lab);
  expect(before.length).toBeGreaterThan(0);

  await relaunch(lab);

  expect(journal(lab), "every row an undo could still need is still there").toEqual(before);
});
