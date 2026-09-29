import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { type ImagedSlide, usePendingImaging } from "./usePendingImaging";

const slide = (id: number, at: string | null = null): ImagedSlide => ({
  id,
  stage_pictures_taken_at: at,
});

/** A write that has not come back yet, and the handle that lets it. */
function held() {
  let settle!: (ok: boolean) => void;
  const done = new Promise<void>((resolve, reject) => {
    settle = (ok) => (ok ? resolve() : reject(new Error("refused")));
  });
  return { write: () => done, land: () => settle(true), refuse: () => settle(false) };
}

describe("usePendingImaging (#191)", () => {
  it("shows the tick while the write is in flight, and while the record is still behind it", async () => {
    const { result, rerender } = renderHook(
      ({ slides }) => usePendingImaging(slides, 1),
      { initialProps: { slides: [slide(10), slide(11)] } },
    );
    expect(result.current.imaged(slide(10))).toBe(false);

    const writing = held();
    let marked!: Promise<void>;
    act(() => {
      marked = result.current.mark(10, true, writing.write);
    });
    expect(result.current.imaged(slide(10))).toBe(true);
    // Its neighbour is untouched.
    expect(result.current.imaged(slide(11))).toBe(false);

    // The write lands, but the query that feeds the box has not refetched yet:
    // the record still says no, so the box must still say yes.
    await act(async () => {
      writing.land();
      await marked;
    });
    expect(result.current.imaged(slide(10))).toBe(true);

    // The refetch arrives. From here the record is the answer, so a later change
    // to it (an undo elsewhere) is not overridden by the spent intent.
    const imaged = slide(10, "2026-09-28 10:00:00");
    rerender({ slides: [imaged, slide(11)] });
    expect(result.current.imaged(imaged)).toBe(true);
    rerender({ slides: [slide(10), slide(11)] });
    expect(result.current.imaged(slide(10))).toBe(false);
  });

  it("hands the box back to the record when the write is refused, and rethrows", async () => {
    const { result } = renderHook(() => usePendingImaging([slide(10)], 1));
    const writing = held();
    let marked!: Promise<void>;
    act(() => {
      marked = result.current.mark(10, true, writing.write);
    });
    expect(result.current.imaged(slide(10))).toBe(true);

    const caught = vi.fn();
    await act(async () => {
      writing.refuse();
      await marked.catch(caught);
    });
    expect(caught).toHaveBeenCalledOnce();
    expect(result.current.imaged(slide(10))).toBe(false);
  });

  it("unticking is held the same way round", async () => {
    const imaged = slide(10, "2026-09-28 10:00:00");
    const { result } = renderHook(() => usePendingImaging([imaged], 1));
    expect(result.current.imaged(imaged)).toBe(true);
    await act(() => result.current.mark(10, false, async () => undefined));
    expect(result.current.imaged(imaged)).toBe(false);
  });

  it("abandons intents when the drawer moves to another rack", async () => {
    const { result, rerender } = renderHook(
      ({ scope }) => usePendingImaging([slide(10)], scope),
      { initialProps: { scope: 1 } },
    );
    await act(() => result.current.mark(10, true, async () => undefined));
    expect(result.current.imaged(slide(10))).toBe(true);
    rerender({ scope: 2 });
    expect(result.current.imaged(slide(10))).toBe(false);
  });
});
