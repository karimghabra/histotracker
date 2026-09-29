import { useCallback, useEffect, useRef, useState } from "react";

/** All the pending view needs of a slide: which one it is, and whether the record says imaged. */
export interface ImagedSlide {
  id: number;
  stage_pictures_taken_at: string | null;
}

interface Intent {
  value: boolean;
  /** What the record said when the intent was made; once it says anything else, it has caught up. */
  from: boolean;
}

const recorded = (slide: ImagedSlide) => Boolean(slide.stage_pictures_taken_at);

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
  const [pending, setPending] = useState<ReadonlyMap<number, Intent>>(() => new Map());
  const slidesRef = useRef(slides);
  slidesRef.current = slides;

  useEffect(() => {
    setPending((current) => (current.size === 0 ? current : new Map()));
  }, [scopeKey]);

  useEffect(() => {
    setPending((current) => {
      if (current.size === 0) return current;
      const next = new Map(current);
      for (const slide of slides) {
        const intent = next.get(slide.id);
        if (intent && recorded(slide) !== intent.from) next.delete(slide.id);
      }
      return next.size === current.size ? current : next;
    });
  }, [slides]);

  /** Show `value` for this slide at once, and write it; a write that fails gives the box back. */
  const mark = useCallback(
    async (slideId: number, value: boolean, write: (value: boolean) => Promise<unknown>) => {
      const slide = slidesRef.current.find((s) => s.id === slideId);
      const from = slide ? recorded(slide) : !value;
      setPending((current) => {
        const next = new Map(current);
        if (value === from) next.delete(slideId);
        else next.set(slideId, { value, from });
        return next;
      });
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
    imaged: (slide: ImagedSlide) => {
      const intent = pending.get(slide.id);
      return intent && recorded(slide) === intent.from ? intent.value : recorded(slide);
    },
    mark,
  };
}
