// Reverting to a backup, on the real db.ts: the moments while the file is being replaced, and
// what Undo can reach afterwards.
//
// A revert closes the database, overwrites the file, and opens it again, and the overwrite takes
// time on a lab-sized database. Anything that asks for the database in that window must get the
// NEW file. It used to reopen the OLD one, and the revert's own reopen then handed that stale
// connection back; in the browser harness the next write put the old state over the revert, which
// is how a plain Undo, which went through the same restore, silently did nothing.
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";
import { world } from "../compat/world";

let lab: Lab | null = null;
afterEach(async () => {
  world().beforeSaveFile = undefined;
  await lab?.close();
  lab = null;
});

it("a read made while a revert is replacing the file waits for, and reads, the reverted database", async () => {
  lab = await openLab();
  const l = lab;
  await l.sample("in the backup");
  const backup = await l.app.backup.createBackup("manual", 10);
  await l.sample("after the backup");
  expect((await l.db.listAllSamples()).length).toBe(2);

  // Inside the window: the old connection is closed and the new file is not yet in place.
  let during: Promise<unknown[]> | null = null;
  world().beforeSaveFile = async () => {
    world().beforeSaveFile = undefined;
    during = l.db.listAllSamples();
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  await l.app.backup.revertToBackup(backup.name);

  expect(during, "the read ran inside the window").not.toBeNull();
  expect((await during!).length, "the read made mid-revert saw the reverted database").toBe(1);
  expect((await l.db.listAllSamples()).length, "and the live connection is the reverted file's").toBe(1);
  expect(l.rows(`SELECT COUNT(*) AS n FROM samples`)[0].n).toBe(1);
});

it("a revert leaves nothing to undo or redo: the safety backup is the way back", async () => {
  lab = await openLab();
  await lab.sample("in the backup");
  const backup = await lab.app.backup.createBackup("manual", 10);
  const { useUndoStore } = await import("../../src/lib/undo");
  useUndoStore.getState().record({ label: "an action before the revert", mark: 0 });
  useUndoStore.getState().commitUndo({ label: "an action before the revert", mark: 1 });
  useUndoStore.getState().record({ label: "another action", mark: 1 });
  expect(useUndoStore.getState().undoStack).toHaveLength(1);

  await lab.app.backup.revertToBackup(backup.name);

  expect(useUndoStore.getState().undoStack).toEqual([]);
  expect(useUndoStore.getState().redoStack).toEqual([]);
  const safety = (await lab.app.backup.listBackups()).filter((b: { reason: string }) => b.reason === "prerestore");
  expect(safety, "the revert took its safety backup first").toHaveLength(1);
});
