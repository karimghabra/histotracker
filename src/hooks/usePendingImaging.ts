import { useCallback, useEffect, useState } from "react";

/** All the pending view needs of a slide: which one it is, and whether the record says imaged. */
export interface ImagedSlide {
  id: number;
  stage_pictures_taken_at: string | null;
}

/**
 * The imaging tick a technician has just made, shown until the record catches
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
 * So the intent is shown while the record is still behind it, and dropped the
 * moment the record agrees - not when the write resolves, because the action
 * fires its invalidation without awaiting it and returns while the refetch is
 * still in flight. A write that does not land gives the box straight back to the
 * truth, and rethrows, so the caller still shows the refusal.
 *
 * `scopeKey` is whatever the checklist is a checklist OF (the open rack, the
 * open cut group): changing it means these intents are about slides no longer on
 * screen, so they are abandoned rather than carried across.
 */
export function usePendingImaging(slides: ImagedSlide[], scopeKey: number) {
  const [pending, setPending] = useState<ReadonlyMap<number, boolean>>(() => new Map());

  useEffect(() => {
    setPending((current) => (current.size === 0 ? current : new Map()));
  }, [scopeKey]);

  useEffect(() => {
    setPending((current) => {
      if (current.size === 0) return current;
      const next = new Map(current);
      for (const slide of slides) {
        if (next.get(slide.id) === Boolean(slide.stage_pictures_taken_at)) next.delete(slide.id);
      }
      return next.size === current.size ? current : next;
    });
  }, [slides]);

  /** Show `value` for this slide at once, and write it; a write that fails gives the box back. */
  const mark = useCallback(
    async (slideId: number, value: boolean, write: (value: boolean) => Promise<unknown>) => {
      setPending((current) => new Map(current).set(slideId, value));
      try {
        await write(value);
      } catch (reason) {
        setPending((current) => {
          if (!current.has(slideId)) return current;
          const next = new Map(current);
          next.delete(slideId);
          return next;
        });
        throw reason;
      }
    },
    [],
  );

  return {
    /** What this slide's checkbox should show: the outstanding intent, or the record. */
    imaged: (slide: ImagedSlide) => pending.get(slide.id) ?? Boolean(slide.stage_pictures_taken_at),
    mark,
  };
}
