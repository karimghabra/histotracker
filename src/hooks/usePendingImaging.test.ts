import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ImagedSlide, usePendingImaging } from "./usePendingImaging";

const KEY = ["stack-slides", 1] as const;
const STAMP = "2026-09-28 10:00:00";

/** A drawer's view of a two-slide rack: the query that feeds the boxes, over a record the test owns. */
async function rack(initial: Record<number, string | null> = { 10: null, 11: null }) {
  const record = new Map(Object.entries(initial).map(([id, at]) => [Number(id), at]));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const { result } = renderHook(
    () => {
      const { data = [] } = useQuery({
        queryKey: KEY,
        queryFn: async (): Promise<ImagedSlide[]> =>
          [...record].map(([id, at]) => ({ id, stage_pictures_taken_at: at })),
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
    /** The action's own invalidation, or anything else's, landing. */
    refetch: () => act(() => qc.invalidateQueries({ queryKey: KEY })),
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

describe("usePendingImaging (#191)", () => {
  it("shows the tick while the write is in flight, and until the record is re-read", async () => {
    const view = await rack();
    expect(view.shown(10)).toBe(false);

    const writing = held();
    let marked!: Promise<void>;
    act(() => {
      marked = view.mark(10, true, writing.write);
    });
    expect(view.shown(10)).toBe(true);
    // Its neighbour is untouched.
    expect(view.shown(11)).toBe(false);

    // The write lands, but the query that feeds the box has not refetched yet.
    await act(async () => {
      view.record.set(10, STAMP);
      writing.land();
      await marked;
    });
    expect(view.shown(10)).toBe(true);

    await view.refetch();
    expect(view.shown(10)).toBe(true);
    // From here the record is the answer: an undo elsewhere is followed.
    view.record.set(10, null);
    await view.refetch();
    expect(view.shown(10)).toBe(false);
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
    await act(() => view.mark(10, false, async () => view.record.set(10, null)));
    expect(view.shown(10)).toBe(false);
  });

  it("a tick taken back before the refetch leaves nothing to override a later change", async () => {
    const view = await rack();
    await act(() => view.mark(10, true, async () => view.record.set(10, STAMP)));
    await act(() => view.mark(10, false, async () => view.record.set(10, null)));
    // The row is back where it started, so the refetch reads the same rows.
    await view.refetch();
    expect(view.shown(10)).toBe(false);

    // Then the record turns imaged from elsewhere (an undo, the bulk action).
    view.record.set(10, STAMP);
    await view.refetch();
    expect(view.shown(10)).toBe(true);
  });

  it("a tick that lands but is undone before the refetch follows the record", async () => {
    const view = await rack();
    await act(() => view.mark(10, true, async () => view.record.set(10, STAMP)));
    expect(view.shown(10)).toBe(true);
    // Ctrl+Z replays before the tick's own refetch has come back.
    view.record.set(10, null);
    await view.refetch();
    expect(view.shown(10)).toBe(false);
  });
});
