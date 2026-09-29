import { useReducer } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { nowTimestamp } from "../lib/utils";

/** All the pending view needs of a slide: which one it is, and whether the record says imaged. */
export interface ImagedSlide {
  id: number;
  stage_pictures_taken_at: string | null;
}

/**
 * The imaging tick a technician has just made, shown before the record catches
 * up with it (#191).
 *
 * "Images captured" is the only checkbox in the app whose truth is a database
 * column rather than local state, and that column is written by an action that
 * goes through the write lane, journals its undo entry and only then invalidates
 * the query that feeds the box. React restores a controlled input to its prop as
 * soon as the change event returns, so in the interval between the click and
 * that refetch the box the user just ticked shows UNTICKED: measured at ~70 ms
 * on an empty database in headless Chromium, and longer on a lab database with
 * other writes queued ahead of it. It reads as a control that ignored the click,
 * and a second click inside the window records the opposite of what was meant.
 *
 * So the tick is written into the cached rows of `queryKey`, the query that
 * feeds the box, in the change handler itself: an optimistic update, with no
 * second copy of the intent to outlive it. The next read of the query, whether
 * the action's own invalidation or an undo's, replaces it with the record. The
 * box reads that cache directly and re-renders from the handler, because the
 * query's own observers hear of the change only on a later tick, after React has
 * already put the box back. A
 * write that does not land puts the row back and re-reads it, and rethrows, so
 * the caller still shows the refusal.
 */
export function usePendingImaging(queryKey: QueryKey) {
  const qc = useQueryClient();
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  /** Show `value` for this slide at once, and write it; a write that fails gives the box back. */
  const mark = async (slideId: number, value: boolean, write: (value: boolean) => Promise<unknown>) => {
    const setRow = (at: string | null) =>
      qc.setQueryData<ImagedSlide[]>(queryKey, (rows) =>
        rows?.map((row) => (row.id === slideId ? { ...row, stage_pictures_taken_at: at } : row)),
      );
    const was =
      qc.getQueryData<ImagedSlide[]>(queryKey)?.find((row) => row.id === slideId)
        ?.stage_pictures_taken_at ?? null;
    setRow(value ? nowTimestamp() : null);
    rerender();
    try {
      await write(value);
    } catch (reason) {
      setRow(was);
      rerender();
      void qc.invalidateQueries({ queryKey, exact: true });
      throw reason;
    }
  };

  return {
    /** What this slide's checkbox should show. */
    imaged: (slide: ImagedSlide) => {
      const cached = qc.getQueryData<ImagedSlide[]>(queryKey)?.find((row) => row.id === slide.id);
      return Boolean((cached ?? slide).stage_pictures_taken_at);
    },
    mark,
  };
}
