// The undo journal is bounded (ht-undo-snapshot-on-write-path).
//
// Every journaled change writes an inverse row, and those rows live inside the database file, so
// they ride in every backup and in every snapshot the workstation publishes. What that costs is
// BYTES, and a row can be a hundred bytes or several kilobytes, so the journal is trimmed at open
// to a five-megabyte ceiling, with a row count and an age as secondary guards. It is trimmed at the
// one moment nothing can be relying on a row: the undo stack is empty until the saved history is
// hydrated, and that is anchored to the journal's ends. On the real db.ts, a real SQLite file,
// relaunched the way the app relaunches.
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
const rows = (lab: Lab) => Number(lab.rows(`SELECT COUNT(*) AS n FROM undo_journal`)[0].n);
const bytes = (lab: Lab) =>
  Number(lab.rows(`SELECT COALESCE(SUM(LENGTH(CAST(stmt AS BLOB))), 0) AS n FROM undo_journal`)[0].n);
const CEILING = 5 * 1024 * 1024;

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

it("keeps only as much journal as the byte ceiling allows, whatever the row count", async () => {
  const lab = await openLab();
  running = lab.app;
  await lab.sample("a block", "in_ethanol");
  const db = await lab.db.getDb();
  // Seven megabytes in seven hundred rows: far inside the row guard, far past the ceiling.
  await db.execute(
    `WITH RECURSIVE counted(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counted WHERE n < 700)
     INSERT INTO undo_journal(stmt) SELECT 'heavy ' || n || ' ' || hex(zeroblob(5000)) FROM counted`,
  );
  expect(bytes(lab)).toBeGreaterThan(6 * 1024 * 1024);
  expect(rows(lab), "the row guard has nothing to say about this journal").toBeLessThan(20_000);

  await relaunch(lab);

  const widest = Number(lab.rows(`SELECT MAX(LENGTH(CAST(stmt AS BLOB))) AS n FROM undo_journal`)[0].n);
  expect(bytes(lab), "trimmed to the ceiling, give or take the row that straddles it").toBeLessThanOrEqual(
    CEILING + widest,
  );
  expect(bytes(lab), "and not past it, so the newest journal is kept").toBeGreaterThan(CEILING / 2);
  expect(
    lab.rows(`SELECT substr(stmt, 1, 10) AS head FROM undo_journal ORDER BY seq DESC LIMIT 1`)[0].head,
    "the newest row survives",
  ).toBe("heavy 700 ");
  expect(
    Number(lab.rows(`SELECT COUNT(*) AS n FROM undo_journal WHERE stmt LIKE 'heavy 1 %'`)[0].n),
    "and the oldest are the ones forgotten",
  ).toBe(0);
});

it("keeps the newest row even when it alone is past the ceiling, rather than emptying the journal", async () => {
  const lab = await openLab();
  running = lab.app;
  await lab.sample("a block", "in_ethanol");
  expect(rows(lab)).toBeGreaterThan(0);
  const db = await lab.db.getDb();
  // One row of six megabytes: nothing at the bench writes this, but the bound
  // must give way one row at a time rather than all at once.
  await db.execute(`INSERT INTO undo_journal(stmt) VALUES ('giant ' || hex(zeroblob(3000000)))`);

  await relaunch(lab);

  expect(rows(lab), "the journal is not emptied").toBe(1);
  expect(
    lab.rows(`SELECT substr(stmt, 1, 6) AS head FROM undo_journal`)[0].head,
    "and what survives is the newest row",
  ).toBe("giant ");
});
