// Reverting to a backup leaves nothing to undo (ht-undo-snapshot-on-write-path).
//
// An undo entry is a range of the live journal, and a reverted file brings its own, so a mark
// taken from the old one would replay the wrong rows. The captain's ruling: a revert clears Undo
// and Redo, and the way back from one is the safety backup every revert takes first. On the real
// db.ts and backup.ts, against a real SQLite file.
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

it("a revert leaves nothing to undo or redo: the safety backup is the way back", async () => {
  lab = await openLab();
  await lab.sample("in the backup");
  const backup = await lab.app.backup.createBackup("manual", 10);
  // Two actions, the newer one taken back: one step to undo, one to redo. Recording
  // is what clears the redo branch, so the undo has to come last or the Redo half of
  // this test would be asserting against a stack that was already empty.
  const { useUndoStore } = await import("../../src/lib/undo");
  useUndoStore.getState().record({ label: "an action before the revert", mark: 0, end: 1 });
  useUndoStore.getState().record({ label: "another action", mark: 2, end: 3 });
  useUndoStore.getState().commitUndo({ label: "another action", mark: 3, end: 4 });
  expect(useUndoStore.getState().undoStack, "one step to undo when the revert lands").toHaveLength(1);
  expect(useUndoStore.getState().redoStack, "and one to redo").toHaveLength(1);

  await lab.app.backup.revertToBackup(backup.name);

  expect(useUndoStore.getState().undoStack).toEqual([]);
  expect(useUndoStore.getState().redoStack).toEqual([]);
  const safety = (await lab.app.backup.listBackups()).filter((b: { reason: string }) => b.reason === "prerestore");
  expect(safety, "the revert took its safety backup first").toHaveLength(1);
});
