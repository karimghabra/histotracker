import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useUndoStore } from "../lib/undo";

/**
 * Every mutation, and undo and redo with them, run one at a time.
 *
 * A correction is saved on blur, and clicking Undo is itself what blurs the box,
 * so the click arrives while the correction is still being written. Undo pops
 * whatever is on top — which at that instant is the action BEFORE the
 * correction, because the correction has not been recorded yet. A different edit
 * gets reverted, and the correction the user was cancelling then lands on top of
 * the restored database.
 *
 * The same window makes a take-back look like a no-op: the text the user is
 * retyping is still what the database reads back, because the write replacing it
 * has not run.
 *
 * The stand-in database holds one note and applies a write when the test lets it
 * finish, which is what makes the ordering observable.
 */
const db = vi.hoisted(() => ({
  note: "cut face down",
  writes: [] as string[],
  restored: [] as number[],
  finish: null as null | ((err?: Error) => void),
}));

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getSample: async () => ({ id: 1, sample_code: "EE-0001", embedding_notes: db.note }),
    snapshotDb: async () => new Uint8Array([1]),
    restoreDbPreservingSession: async (image: Uint8Array) => {
      db.restored.push(image[0]);
    },
    recordAuditEvent: async () => undefined,
    setSampleNote: (_id: number, _field: string, text: string) =>
      new Promise<void>((resolve, reject) => {
        db.finish = (err?: Error) => {
          if (err) {
            reject(err);
            return;
          }
          db.note = text.trim();
          db.writes.push(text.trim());
          resolve();
        };
      }),
  };
});

const { useActions } = await import("./useActions");

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

const labels = () => useUndoStore.getState().undoStack.map((s) => s.label);

/** Wait until the correction in flight has reached the write. */
const reachedTheWrite = () => waitFor(() => expect(db.finish).not.toBeNull());

beforeEach(() => {
  db.note = "cut face down";
  db.writes = [];
  db.restored = [];
  db.finish = null;
  useUndoStore.setState({ undoStack: [], redoStack: [] });
});

describe("editSampleNote — one at a time, in the order the user did them", () => {
  // Undo arrives mid-write because clicking it is what blurs the box. It has to
  // take back the correction the user was looking at, not the action underneath
  // it that the queued write has not yet covered.
  it("an undo issued while a correction is being written takes back that correction", async () => {
    useUndoStore.setState({
      undoStack: [{ label: "Edit EE-1 description", snapshot: new Uint8Array([7]) }],
      redoStack: [],
    });
    const { result } = renderHook(() => useActions(), { wrapper });

    let saved: Promise<void>;
    act(() => {
      saved = result.current.editSampleNote(1, "embedding_notes", "cut face UP");
    });
    await reachedTheWrite();

    let undone: Promise<string | null>;
    act(() => {
      undone = result.current.undo();
    });
    await act(async () => {
      db.finish!();
      await saved;
    });

    expect(await undone!).toBe("Edit EE-1 embedding notes");
    // The earlier action is still there to be undone next, untouched.
    expect(labels()).toEqual(["Edit EE-1 description"]);
    expect(db.writes).toEqual(["cut face UP"]);
  });

  // Taking a correction back by retyping the original, while the first save is
  // still queued: the no-op check has to read what the database will hold when
  // this correction runs, not the text the queued write is about to replace.
  it("writes a take-back typed while the first correction is still being saved", async () => {
    const { result } = renderHook(() => useActions(), { wrapper });

    let first: Promise<void>;
    let second: Promise<void>;
    act(() => {
      first = result.current.editSampleNote(1, "embedding_notes", "cut face UP");
    });
    await reachedTheWrite();
    const finishFirst = db.finish!;
    db.finish = null;

    act(() => {
      second = result.current.editSampleNote(1, "embedding_notes", "cut face down");
    });
    await act(async () => {
      finishFirst();
      await first;
    });

    await reachedTheWrite();
    await act(async () => {
      db.finish!();
      await second;
    });
    expect(db.writes).toEqual(["cut face UP", "cut face down"]);
    expect(db.note).toBe("cut face down");
    expect(labels()).toEqual(["Edit EE-1 embedding notes", "Edit EE-1 embedding notes"]);
  });

  it("does not write, or record anything, for a note that was not changed", async () => {
    const { result } = renderHook(() => useActions(), { wrapper });

    await act(async () => {
      await result.current.editSampleNote(1, "embedding_notes", "  cut face down  ");
    });

    expect(db.writes).toEqual([]);
    expect(labels()).toEqual([]);
  });

  // One failed save must not wedge every correction behind it, undo included.
  it("keeps taking corrections after a write fails", async () => {
    const { result } = renderHook(() => useActions(), { wrapper });

    let failed: Promise<void>;
    act(() => {
      failed = result.current.editSampleNote(1, "embedding_notes", "cut face UP");
    });
    await reachedTheWrite();
    await act(async () => {
      db.finish!(new Error("disk went away"));
      await expect(failed).rejects.toThrow("disk went away");
    });
    db.finish = null;

    let saved: Promise<void>;
    act(() => {
      saved = result.current.editSampleNote(1, "embedding_notes", "cut face sideways");
    });
    await reachedTheWrite();
    await act(async () => {
      db.finish!();
      await saved;
    });
    expect(db.writes).toEqual(["cut face sideways"]);
    expect(labels()).toEqual(["Edit EE-1 embedding notes"]);
  });
});
