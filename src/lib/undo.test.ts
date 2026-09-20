import { describe, it, expect, beforeEach } from "vitest";
import { useUndoStore, type Snapshot } from "./undo";

const snap = (label: string, n: number): Snapshot => ({ label, snapshot: [n] });

describe("undo store — whole-DB snapshot bookkeeping", () => {
  beforeEach(() => useUndoStore.getState().clear());

  it("records a pre-mutation snapshot and clears the redo stack", () => {
    const s = useUndoStore.getState();
    s.record(snap("A", 1));
    expect(useUndoStore.getState().undoStack.map((e) => e.label)).toEqual(["A"]);
    expect(useUndoStore.getState().redoStack).toHaveLength(0);
  });

  it("undo returns the recorded pre-state and moves the current state to redo", () => {
    const s = useUndoStore.getState();
    s.record(snap("A", 1)); // pre-A state = bytes [1]
    // Current state after A is [2]; undo should hand back the pre-A snapshot and
    // stash [2] under redo so it can be replayed.
    const entry = useUndoStore.getState().commitUndo(snap("A", 2));
    expect(entry?.snapshot).toEqual([1]);
    expect(useUndoStore.getState().undoStack).toHaveLength(0);
    expect(useUndoStore.getState().redoStack[0].snapshot).toEqual([2]);
  });

  it("redo returns the post-state and stashes the current back onto undo", () => {
    const s = useUndoStore.getState();
    s.record(snap("A", 1));
    useUndoStore.getState().commitUndo(snap("A", 2)); // now at [1], redo has [2]
    const entry = useUndoStore.getState().commitRedo(snap("A", 1)); // current is [1]
    expect(entry?.snapshot).toEqual([2]); // redo restores the post-state
    expect(useUndoStore.getState().redoStack).toHaveLength(0);
    expect(useUndoStore.getState().undoStack[0].snapshot).toEqual([1]);
  });

  it("a fresh action after an undo clears the redo history", () => {
    const s = useUndoStore.getState();
    s.record(snap("A", 1));
    useUndoStore.getState().commitUndo(snap("A", 2));
    expect(useUndoStore.getState().redoStack).toHaveLength(1);
    useUndoStore.getState().record(snap("B", 3));
    expect(useUndoStore.getState().redoStack).toHaveLength(0);
  });

  it("returns undefined when there is nothing to undo/redo", () => {
    expect(useUndoStore.getState().commitUndo(snap("x", 0))).toBeUndefined();
    expect(useUndoStore.getState().commitRedo(snap("x", 0))).toBeUndefined();
  });
});
