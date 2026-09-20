// The undo journal is bounded (ht-undo-snapshot-on-write-path).
//
// Every journaled change writes an inverse row, and those rows live inside the database file, so
// they ride in every backup and in every snapshot the workstation publishes. What that costs is
// BYTES, and a row can be a hundred bytes or several kilobytes, so the journal is trimmed at open
// to a five-megabyte ceiling. A fortnight is the other bound, and that one is a retention window:
// a deleted row's contents sit in its inverse until the journal forgets it. It is trimmed at the
// one moment nothing can be relying on a row: the undo stack is empty until the saved history is
// hydrated, and that is anchored to the journal's ends. On the real db.ts, a real SQLite file,
// relaunched the way the app relaunches.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";
import { launch, quit, type App } from "../compat/app";
import { currentBuild } from "../compat/builds";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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

/** The app's own actions, bound to the db.ts this lab opened (as undo-lane does). */
async function appActions(): Promise<Any> {
  const { useActions } = await import("../../src/hooks/useActions");
  let actions: Any;
  const Probe = () => ((actions = useActions()), null);
  renderToString(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)));
  return actions;
}

const journal = (lab: Lab) => lab.rows(`SELECT seq, stmt FROM undo_journal ORDER BY seq`);
const floor = (lab: Lab) => Number(lab.rows(`SELECT COALESCE(MIN(seq), 0) AS n FROM undo_journal`)[0].n);
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

it("leaves a journal inside the bound exactly as it is", async () => {
  const lab = await openLab();
  running = lab.app;
  await lab.sample("a block", "in_ethanol");
  const before = journal(lab);
  expect(before.length).toBeGreaterThan(0);

  await relaunch(lab);

  expect(journal(lab), "every row an undo could still need is still there").toEqual(before);
});

it("keeps only as much journal as the byte ceiling allows", async () => {
  const lab = await openLab();
  running = lab.app;
  await lab.sample("a block", "in_ethanol");
  const db = await lab.db.getDb();
  // Seven megabytes in seven hundred rows, every one of them written today.
  await db.execute(
    `WITH RECURSIVE counted(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counted WHERE n < 700)
     INSERT INTO undo_journal(stmt) SELECT 'heavy ' || n || ' ' || hex(zeroblob(5000)) FROM counted`,
  );
  expect(bytes(lab)).toBeGreaterThan(6 * 1024 * 1024);

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

it("a walk back and forward forgets the journal rows it leaves behind", async () => {
  const lab = await openLab();
  running = lab.app;
  const id = await lab.sample("DESC-0", "embedded");
  const actions = await appActions();
  const { oldestMark } = await import("../../src/lib/undo");

  await actions.editSampleDescription(id, "DESC-B");
  await actions.editSampleNote(id, "cut_notes", "CUT-B");

  // Ctrl+Z, Ctrl+Z: each replay writes its own rows and strands the ones behind it.
  expect(await actions.undo()).toBeTruthy();
  expect(await actions.undo()).toBeTruthy();
  expect(floor(lab), "nothing older than the oldest step either stack still needs").toBeGreaterThan(oldestMark());

  // Ctrl+Y, Ctrl+Y: the same again in the other direction.
  expect(await actions.redo()).toBeTruthy();
  expect(await actions.redo()).toBeTruthy();
  expect(floor(lab), "still nothing older than the oldest step either stack needs").toBeGreaterThan(oldestMark());
});
