import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ImagedSlide, usePendingImaging } from "./usePendingImaging";

const KEY = ["stack-slides", 1] as const;
const STAMP = "2026-09-28 10:00:00";

/**
 * A drawer's view of a two-slide rack: the query that feeds the boxes, over a
 * record the test owns.
 *
 * A read snapshots the record when it STARTS, so a read held open answers with
 * what was true before whatever happened while it was in flight - which is the
 * whole class of race this hook exists to be immune to.
 */
async function rack(initial: Record<number, string | null> = { 10: null, 11: null }) {
  const record = new Map(Object.entries(initial).map(([id, at]) => [Number(id), at]));
  let hold: Promise<void> | null = null;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const { result } = renderHook(
    () => {
      const { data = [] } = useQuery({
        queryKey: KEY,
        queryFn: async (): Promise<ImagedSlide[]> => {
          const rows = [...record].map(([id, at]) => ({ id, stage_pictures_taken_at: at }));
          if (hold) await hold;
          return rows;
        },
      });
      return { slides: data, imaging: usePendingImaging(KEY) };
    },
    { wrapper },
  );
  await waitFor(() => expect(result.current.slides).toHaveLength(record.size));
  return {
    record,
    shown: (id: number) =>
      result.current.imaging.imaged(result.current.slides.find((slide) => slide.id === id)!),
    mark: (id: number, value: boolean, write: () => Promise<unknown>) =>
      result.current.imaging.mark(id, value, write),
    /** Every read from now on hangs until the returned release is called. */
    holdReads: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        const pending = hold;
        hold = null;
        release();
        return pending;
      };
    },
    /** Anything else's invalidation landing: an undo, the board, another rack. */
    refetch: () => act(() => qc.invalidateQueries({ queryKey: KEY })),
    startRead: () => void qc.invalidateQueries({ queryKey: KEY }),
  };
}

/** A write that has not come back yet, and the handle that lets it. */
function held() {
  let settle!: (ok: boolean) => void;
  const done = new Promise<void>((resolve, reject) => {
    settle = (ok) => (ok ? resolve() : reject(new Error("refused")));
  });
  return { write: () => done, land: () => settle(true), refuse: () => settle(false) };
}

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("usePendingImaging (#191)", () => {
  it("shows the tick from the click until the record has been re-read", async () => {
    const view = await rack();
    expect(view.shown(10)).toBe(false);

    const writing = held();
    let marked!: Promise<void>;
    act(() => {
      marked = view.mark(10, true, writing.write);
    });
    // The click itself, before anything has been written anywhere.
    expect(view.shown(10)).toBe(true);
    // Its neighbour is untouched.
    expect(view.shown(11)).toBe(false);

    // The write lands, but the read that would prove it has not come back.
    const release = view.holdReads();
    await act(async () => {
      view.record.set(10, STAMP);
      writing.land();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.shown(10)).toBe(true);

    await act(async () => {
      release();
      await marked;
    });
    expect(view.shown(10)).toBe(true);

    // From here the record is the answer: an undo elsewhere is followed.
    view.record.set(10, null);
    await view.refetch();
    await waitFor(() => expect(view.shown(10)).toBe(false));
  });

  it("hands the box back to the record when the write is refused, and rethrows", async () => {
    const view = await rack();
    const writing = held();
    let marked!: Promise<void>;
    act(() => {
      marked = view.mark(10, true, writing.write);
    });
    expect(view.shown(10)).toBe(true);

    const caught = vi.fn();
    await act(async () => {
      writing.refuse();
      await marked.catch(caught);
    });
    expect(caught).toHaveBeenCalledOnce();
    expect(view.shown(10)).toBe(false);
  });

  it("unticking is shown at once the same way", async () => {
    const view = await rack({ 10: STAMP });
    expect(view.shown(10)).toBe(true);
    await act(() => view.mark(10, false, async () => void view.record.set(10, null)));
    expect(view.shown(10)).toBe(false);
  });

  it("a tick taken back before the record moved leaves nothing to override a later change", async () => {
    const view = await rack();
    await act(() => view.mark(10, true, async () => void view.record.set(10, STAMP)));
    await act(() => view.mark(10, false, async () => void view.record.set(10, null)));
    expect(view.shown(10)).toBe(false);

    // The record ends where it began, so nothing about it CHANGED - and the box
    // must still follow it when it turns imaged from elsewhere.
    view.record.set(10, STAMP);
    await view.refetch();
    await waitFor(() => expect(view.shown(10)).toBe(true));
  });

  it("a tick that lands but is undone before the re-read follows the record", async () => {
    const view = await rack();
    const writing = held();
    let marked!: Promise<void>;
    act(() => {
      marked = view.mark(10, true, writing.write);
    });
    await act(async () => {
      view.record.set(10, STAMP);
      writing.land();
      // Ctrl+Z replays before this tick's own re-read has run.
      view.record.set(10, null);
      await marked;
    });
    expect(view.shown(10)).toBe(false);
  });

  it("a read already in flight when the box is ticked cannot answer for the tick", async () => {
    const view = await rack();
    // Another action's read has snapshotted the record, and not come back yet.
    const release = view.holdReads();
    view.startRead();
    await settle();

    const writing = held();
    let marked!: Promise<void>;
    act(() => {
      marked = view.mark(10, true, writing.write);
    });
    expect(view.shown(10)).toBe(true);

    await act(async () => {
      view.record.set(10, STAMP);
      writing.land();
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      await marked;
    });
    expect(view.shown(10)).toBe(true);
  });

  it("a tick whose own re-read is cancelled by a later one stays up until a read lands", async () => {
    const view = await rack();
    const release = view.holdReads();
    let markA!: Promise<void>;
    await act(async () => {
      markA = view.mark(10, true, async () => void view.record.set(10, STAMP));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.shown(10)).toBe(true);

    // The next tick's write invalidates the query, cancelling A's re-read
    // before it can land.
    let markB!: Promise<void>;
    await act(async () => {
      markB = view.mark(11, true, async () => {
        view.record.set(11, STAMP);
        view.startRead();
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    expect(view.shown(10)).toBe(true);
    expect(view.shown(11)).toBe(true);

    await act(async () => {
      release();
      await Promise.all([markA, markB]);
    });
    expect(view.shown(10)).toBe(true);
    expect(view.shown(11)).toBe(true);
  });

  it("a slower earlier tick on the same slide does not take down a later one", async () => {
    const view = await rack();
    const first = held();
    const second = held();
    let firstMark!: Promise<void>;
    let secondMark!: Promise<void>;
    act(() => {
      firstMark = view.mark(10, true, first.write);
    });
    act(() => {
      secondMark = view.mark(10, false, second.write);
    });
    expect(view.shown(10)).toBe(false);

    // The first tick finishes last, against a record that still reads imaged
    // because the second write has not run yet.
    await act(async () => {
      view.record.set(10, STAMP);
      first.land();
      await firstMark;
    });
    expect(view.shown(10)).toBe(false);

    await act(async () => {
      view.record.set(10, null);
      second.land();
      await secondMark;
    });
    expect(view.shown(10)).toBe(false);
  });

  it("moving the drawer to another rack abandons what was outstanding", async () => {
    const record = new Map<number, string | null>([[10, null]]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    const { result, rerender } = renderHook(
      ({ stackId }: { stackId: number }) => usePendingImaging(["stack-slides", stackId]),
      { wrapper, initialProps: { stackId: 1 } },
    );
    const slide = { id: 10, stage_pictures_taken_at: record.get(10) ?? null };
    const writing = held();
    act(() => {
      void result.current.mark(10, true, writing.write).catch(() => undefined);
    });
    expect(result.current.imaged(slide)).toBe(true);
    rerender({ stackId: 2 });
    expect(result.current.imaged(slide)).toBe(false);
  });
});
