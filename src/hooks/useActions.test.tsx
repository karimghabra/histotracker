import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useUndoStore } from "../lib/undo";

/**
 * Correcting a note is saved on blur — and clicking Undo is itself what blurs
 * the box, so the click arrives while the correction is still being written.
 * Undo pops whatever is on top, which at that instant is the action BEFORE the
 * correction: a different edit gets reverted, and the correction the user was
 * cancelling then lands on top of the restored database.
 *
 * The toolbar refuses undo and redo while `pendingNoteSaves` is up, so what
 * matters here is that the flag covers the whole window in which the undo stack
 * does not yet know about the correction, that it always comes back down, and
 * that merely READING a note never raises it.
 *
 * The stand-in database holds one note and applies a write when the test lets
 * it finish, which is what makes the ordering between two overlapping saves
 * observable.
 */
const db = vi.hoisted(() => ({
  note: "cut face down",
  writes: [] as string[],
  finish: null as null | ((err?: Error) => void),
}));

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getSample: async () => ({ id: 1, sample_code: "EE-0001", embedding_notes: db.note }),
    snapshotDb: async () => new Uint8Array([1]),
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
const pending = () => useUndoStore.getState().pendingNoteSaves;

/** Wait until the correction in flight has reached the write. */
const reachedTheWrite = () => waitFor(() => expect(db.finish).not.toBeNull());

beforeEach(() => {
  db.note = "cut face down";
  db.writes = [];
  db.finish = null;
  useUndoStore.setState({ undoStack: [], redoStack: [], pendingNoteSaves: 0 });
});

describe("editSampleNote — undo must not be offered mid-write", () => {
  it("holds the flag until the correction is on the undo stack", async () => {
    const { result } = renderHook(() => useActions(), { wrapper });

    let saved: Promise<void>;
    act(() => {
      saved = result.current.editSampleNote(1, "embedding_notes", "cut face UP");
    });

    // The write is in flight: the stack still has nothing to undo BUT the
    // correction, so an undo here would pop the wrong action.
    await reachedTheWrite();
    expect(pending()).toBe(1);
    expect(labels()).toEqual([]);

    await act(async () => {
      db.finish!();
      await saved;
    });
    expect(pending()).toBe(0);
    expect(labels()).toEqual(["Edit EE-1 embedding notes"]);
  });

  it("lets go of the flag when the write fails", async () => {
    const { result } = renderHook(() => useActions(), { wrapper });

    let saved: Promise<void>;
    act(() => {
      saved = result.current.editSampleNote(1, "embedding_notes", "cut face UP");
    });
    await reachedTheWrite();

    await act(async () => {
      db.finish!(new Error("disk went away"));
      await expect(saved).rejects.toThrow("disk went away");
    });
    // Otherwise a single failed save leaves undo and redo greyed out for good.
    expect(pending()).toBe(0);
    expect(labels()).toEqual([]);
  });

  // Reading a note is focus-and-blur. Watched DURING the call, because the flag
  // is always back down by the time the call returns.
  it("never raises the flag for a note that was not changed", async () => {
    const { result } = renderHook(() => useActions(), { wrapper });
    let peak = 0;
    const unsubscribe = useUndoStore.subscribe((s) => {
      peak = Math.max(peak, s.pendingNoteSaves);
    });

    await act(async () => {
      await result.current.editSampleNote(1, "embedding_notes", "  cut face down  ");
    });
    unsubscribe();

    expect(peak).toBe(0);
    expect(db.writes).toEqual([]);
    expect(labels()).toEqual([]);
  });

  // Taking a correction back while it is still being written. Undo is greyed
  // out in exactly that window, so retyping the original IS the take-back the
  // interface leaves open — and it has to reach the database.
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

    // The user thinks better of it while the first save is still queued.
    act(() => {
      second = result.current.editSampleNote(1, "embedding_notes", "cut face down");
    });
    await act(async () => {
      finishFirst();
      await first;
    });

    // The take-back is not mistaken for a no-op against the text it replaced.
    await reachedTheWrite();
    await act(async () => {
      db.finish!();
      await second;
    });
    expect(db.writes).toEqual(["cut face UP", "cut face down"]);
    expect(db.note).toBe("cut face down");
    expect(labels()).toEqual(["Edit EE-1 embedding notes", "Edit EE-1 embedding notes"]);
  });
});
