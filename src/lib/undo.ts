import { create } from "zustand";

/**
 * One undoable step: a human label for the action and the range of the undo
 * journal its action wrote, `(mark, end]`. Undo replays that range (db.ts
 * revertJournalRange), so the UI just refetches; the replay returns the range it
 * wrote, which is the entry the other stack keeps.
 *
 * The range is CLOSED when the entry is recorded: `mark` is the journal's head
 * before the action, `end` its head after. So an entry covers its own action and
 * nothing else - not the rows an earlier undo wrote back, which would double the
 * journal with every undo, and not a write that landed after it from outside the
 * action.
 *
 * What the replay then enforces, row by row: every inverse must change exactly
 * one row of the lab record, its own. It is guarded by what the action left in
 * that row, so a later write to it makes the inverse match nothing; a row whose
 * key has since been taken makes it raise a constraint; and a delete that would
 * cascade past its own row is counted through the journal it appends. Each is
 * refused whole, with nothing changed, rather than quietly erasing what it met
 * (src-tauri/src/undo_journal.rs).
 */
export interface UndoEntry {
  label: string;
  mark: number;
  end: number;
}

interface UndoState {
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  /** Record a freshly-performed action, with the journal range it wrote; clears redo. */
  record: (entry: UndoEntry) => void;
  /** Pop the newest undo entry and push the given entry (the mark that redoes it) onto redo. */
  commitUndo: (redoEntry: UndoEntry) => UndoEntry | undefined;
  /** Pop the newest redo entry and push the given entry (the mark that undoes it) onto undo. */
  commitRedo: (undoEntry: UndoEntry) => UndoEntry | undefined;
  /**
   * Drop the entry whose replay was refused.
   *
   * A refused replay is one a later write has overtaken, and no amount of asking
   * again will change that, so an entry left in place would be offered forever
   * and nothing behind it could ever be reached. Only that entry goes: the
   * refusal rolled back whole and wrote nothing, so every other step on either
   * stack is worth exactly what it was worth a moment before. From `"redo"` the
   * whole branch goes, because the steps behind the blocked one only follow once
   * it has been put back, and clearing the branch is also what drops it.
   */
  discardBlocked: (stack: "undo" | "redo") => void;
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
    set((s) => ({ undoStack: [...s.undoStack, entry].slice(-MAX), redoStack: [] })),
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
  discardBlocked: (stack) =>
    set((s) => (stack === "undo" ? { undoStack: s.undoStack.slice(0, -1) } : { redoStack: [] })),
  clear: () => set({ undoStack: [], redoStack: [] }),
}));
