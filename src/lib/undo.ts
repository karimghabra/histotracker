import { create } from "zustand";

/**
 * A point-in-time snapshot of the ENTIRE database plus a human label for the
 * action that produced it. `snapshot` is an opaque payload (a raw SQLite file
 * image — see db.ts DbImage); the store only shuffles them between the undo/redo
 * stacks. Undo/redo swap one back in wholesale, so the UI just refetches — there
 * is no per-row restore that could drift out of sync.
 */
export interface Snapshot {
  label: string;
  snapshot: unknown;
}

interface UndoState {
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  /**
   * Note corrections whose snapshot-and-write is still running.
   *
   * A note is saved on blur, and clicking Undo is itself what blurs the box —
   * so the click lands while the correction is still being written. Undo pops
   * whatever is on top, which at that moment is the PREVIOUS action: a
   * different edit gets reverted, and the correction the user was cancelling
   * then lands on top of the restored image. Undo and redo are offered only
   * when this is zero.
   */
  pendingNoteSaves: number;
  beginNoteSave: () => void;
  endNoteSave: () => void;
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
  pendingNoteSaves: 0,
  beginNoteSave: () => set((s) => ({ pendingNoteSaves: s.pendingNoteSaves + 1 })),
  endNoteSave: () => set((s) => ({ pendingNoteSaves: Math.max(0, s.pendingNoteSaves - 1) })),
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
