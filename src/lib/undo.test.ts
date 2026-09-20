import { describe, it, expect, beforeEach } from "vitest";
import { useUndoStore, type UndoEntry } from "./undo";

const undoEntry = (label: string, n: number): UndoEntry => ({ label, mark: n, end: n + 1 });

describe("undo store: undo-journal mark bookkeeping", () => {
  beforeEach(() => useUndoStore.getState().clear());

  it("records an action's mark and clears the redo stack", () => {
    const s = useUndoStore.getState();
    s.record(undoEntry("A", 1));
    expect(useUndoStore.getState().undoStack.map((e) => e.label)).toEqual(["A"]);
    expect(useUndoStore.getState().redoStack).toHaveLength(0);
  });

  it("undo returns the recorded pre-state and moves the current state to redo", () => {
    const s = useUndoStore.getState();
    s.record(undoEntry("A", 1)); // A began at journal mark 1
    // Undoing A replays back to 1 from head 2; undo hands back A's mark and
    // stashes 2 under redo so the undo can itself be reversed.
    const entry = useUndoStore.getState().commitUndo(undoEntry("A", 2));
    expect(entry?.mark).toBe(1);
    expect(useUndoStore.getState().undoStack).toHaveLength(0);
    expect(useUndoStore.getState().redoStack[0].mark).toBe(2);
  });

  it("redo returns the post-state and stashes the current back onto undo", () => {
    const s = useUndoStore.getState();
    s.record(undoEntry("A", 1));
    useUndoStore.getState().commitUndo(undoEntry("A", 2)); // redo holds mark 2
    const entry = useUndoStore.getState().commitRedo(undoEntry("A", 3)); // the redo began at 3
    expect(entry?.mark).toBe(2); // redo replays back to the undo's own mark
    expect(useUndoStore.getState().redoStack).toHaveLength(0);
    expect(useUndoStore.getState().undoStack[0].mark).toBe(3);
  });

  it("a fresh action after an undo clears the redo history", () => {
    const s = useUndoStore.getState();
    s.record(undoEntry("A", 1));
    useUndoStore.getState().commitUndo(undoEntry("A", 2));
    expect(useUndoStore.getState().redoStack).toHaveLength(1);
    useUndoStore.getState().record(undoEntry("B", 3));
    expect(useUndoStore.getState().redoStack).toHaveLength(0);
  });

  it("keeps each entry at the range its own action wrote, whatever is recorded after it", () => {
    const s = useUndoStore.getState();
    // A wrote (1, 3]; rows 4 and 5 came from somewhere that is not an action.
    s.record({ label: "A", mark: 1, end: 3 });
    useUndoStore.getState().record({ label: "B", mark: 5, end: 9 });
    expect(useUndoStore.getState().undoStack).toEqual([
      { label: "A", mark: 1, end: 3 },
      { label: "B", mark: 5, end: 9 },
    ]);
  });

  it("returns undefined when there is nothing to undo/redo", () => {
    expect(useUndoStore.getState().commitUndo(undoEntry("x", 0))).toBeUndefined();
    expect(useUndoStore.getState().commitRedo(undoEntry("x", 0))).toBeUndefined();
  });
});
