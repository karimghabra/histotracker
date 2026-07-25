import { create } from "zustand";

/**
 * A point-in-time snapshot of the ENTIRE database (the raw SQLite bytes) plus a
 * human label for the action that produced it. Undo/redo restore one of these
 * wholesale — the DB is the single source of truth, so swapping it back is all
 * that's needed and the UI simply refetches (issue #31: no per-row restore
 * closures that could drift from the DB).
 */
export interface Snapshot {
  label: string;
  bytes: number[];
}

interface UndoState {
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  /** Record the pre-mutation snapshot for a freshly-performed action; clears redo. */
  record: (snap: Snapshot) => void;
  /** Pop the newest undo entry and push the given (current) snapshot onto redo. */
  commitUndo: (redoSnap: Snapshot) => Snapshot | undefined;
  /** Pop the newest redo entry and push the given (current) snapshot onto undo. */
  commitRedo: (undoSnap: Snapshot) => Snapshot | undefined;
  clear: () => void;
}

const MAX = 100;

export const useUndoStore = create<UndoState>((set, get) => ({
  undoStack: [],
  redoStack: [],
  record: (snap) =>
    set((s) => ({ undoStack: [...s.undoStack, snap].slice(-MAX), redoStack: [] })),
  commitUndo: (redoSnap) => {
    const { undoStack, redoStack } = get();
    if (undoStack.length === 0) return undefined;
    const entry = undoStack[undoStack.length - 1];
    set({
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, redoSnap].slice(-MAX),
    });
    return entry;
  },
  commitRedo: (undoSnap) => {
    const { undoStack, redoStack } = get();
    if (redoStack.length === 0) return undefined;
    const entry = redoStack[redoStack.length - 1];
    set({
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, undoSnap].slice(-MAX),
    });
    return entry;
  },
  clear: () => set({ undoStack: [], redoStack: [] }),
}));
