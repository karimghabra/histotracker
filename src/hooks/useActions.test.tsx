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
 * does not yet know about the correction, and that it always comes back down.
 */
const write = vi.hoisted(() => ({
  finish: null as null | ((err?: Error) => void),
}));

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getSample: async () => ({ id: 1, sample_code: "EE-0001", embedding_notes: "cut face down" }),
    snapshotDb: async () => new Uint8Array([1]),
    setSampleNote: () =>
      new Promise<void>((resolve, reject) => {
        write.finish = (err?: Error) => (err ? reject(err) : resolve());
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

beforeEach(() => {
  write.finish = null;
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
    await waitFor(() => expect(write.finish).not.toBeNull());
    expect(pending()).toBe(1);
    expect(labels()).toEqual([]);

    await act(async () => {
      write.finish!();
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
    await waitFor(() => expect(write.finish).not.toBeNull());

    await act(async () => {
      write.finish!(new Error("disk went away"));
      await expect(saved).rejects.toThrow("disk went away");
    });
    // Otherwise a single failed save leaves undo and redo greyed out for good.
    expect(pending()).toBe(0);
    expect(labels()).toEqual([]);
  });

  it("does not raise the flag for a note that was not changed", async () => {
    const { result } = renderHook(() => useActions(), { wrapper });

    await act(async () => {
      await result.current.editSampleNote(1, "embedding_notes", "  cut face down  ");
    });
    expect(pending()).toBe(0);
    expect(labels()).toEqual([]);
  });
});
