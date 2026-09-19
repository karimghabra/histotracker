import { create } from "zustand";

/**
 * One undoable step: a human label for the action and the range of the undo
 * journal its action wrote, `(mark, end]`. Undo replays that range (db.ts
 * revertJournalRange), so the UI just refetches; the replay returns the range it
 * wrote, which is the entry the other stack keeps.
 *
 * A freshly recorded action's range runs to the journal's head (`end` absent)
 * until the next action is recorded, which closes it at the next one's mark. So
 * an undo replays only its own entry's rows, never the rows every earlier undo in
 * a row wrote back, which would double the journal with each undo.
 */
export interface UndoEntry {
  label: string;
  mark: number;
  end?: number;
}

interface UndoState {
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  /** Record a freshly-performed action, marked where it began; clears redo. */
  record: (entry: UndoEntry) => void;
  /** Pop the newest undo entry and push the given entry (the mark that redoes it) onto redo. */
  commitUndo: (redoEntry: UndoEntry) => UndoEntry | undefined;
  /** Pop the newest redo entry and push the given entry (the mark that undoes it) onto undo. */
  commitRedo: (undoEntry: UndoEntry) => UndoEntry | undefined;
  clear: () => void;
}

const MAX = 100;

/**
 * The oldest undo-journal mark any entry on either stack still needs; journal rows
 * at or before it can be forgotten. With nothing to undo or redo, nothing is needed.
 */
export function oldestMark(): number {
  const { undoStack, redoStack } = useUndoStore.getState();
  const marks = [...undoStack, ...redoStack].map((e) => e.mark);
  return marks.length ? Math.min(...marks) : Number.MAX_SAFE_INTEGER;
}

export const useUndoStore = create<UndoState>((set, get) => ({
  undoStack: [],
  redoStack: [],
  record: (entry) =>
    set((s) => {
      const closed = s.undoStack.map((e, i) =>
        i === s.undoStack.length - 1 && e.end === undefined ? { ...e, end: entry.mark } : e,
      );
      return { undoStack: [...closed, entry].slice(-MAX), redoStack: [] };
    }),
  commitUndo: (redoEntry) => {
    const { undoStack, redoStack } = get();
    if (undoStack.length === 0) return undefined;
    const entry = undoStack[undoStack.length - 1];
    set({
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, redoEntry].slice(-MAX),
    });
    return entry;
  },
  commitRedo: (undoEntry) => {
    const { undoStack, redoStack } = get();
    if (redoStack.length === 0) return undefined;
    const entry = redoStack[redoStack.length - 1];
    set({
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, undoEntry].slice(-MAX),
    });
    return entry;
  },
  clear: () => set({ undoStack: [], redoStack: [] }),
}));
