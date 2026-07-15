import { create } from "zustand";

export interface Command {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

interface UndoState {
  undoStack: Command[];
  redoStack: Command[];
  /** Register a freshly-performed command. Clears the redo history. */
  record: (cmd: Command) => void;
  popUndo: () => Command | undefined;
  popRedo: () => Command | undefined;
  clear: () => void;
}

const MAX = 100;

export const useUndoStore = create<UndoState>((set, get) => ({
  undoStack: [],
  redoStack: [],
  record: (cmd) =>
    set((s) => ({ undoStack: [...s.undoStack, cmd].slice(-MAX), redoStack: [] })),
  popUndo: () => {
    const { undoStack, redoStack } = get();
    if (undoStack.length === 0) return undefined;
    const cmd = undoStack[undoStack.length - 1];
    set({ undoStack: undoStack.slice(0, -1), redoStack: [...redoStack, cmd].slice(-MAX) });
    return cmd;
  },
  popRedo: () => {
    const { undoStack, redoStack } = get();
    if (redoStack.length === 0) return undefined;
    const cmd = redoStack[redoStack.length - 1];
    set({ redoStack: redoStack.slice(0, -1), undoStack: [...undoStack, cmd].slice(-MAX) });
    return cmd;
  },
  clear: () => set({ undoStack: [], redoStack: [] }),
}));
