import { useEffect, useRef, useState } from "react";
import { hashKey, useQueryClient, type QueryKey } from "@tanstack/react-query";

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
 * So the tick is held as an overlay the checkbox reads in front of the record,
 * and it is lifted when the record can be trusted to answer for it. Knowing WHEN
 * that is, is the whole of this hook, and three tempting rules are all wrong:
 *
 *   - "when the record agrees" never fires if the record ends up where it began
 *     (ticked, then unticked to correct a mis-click), leaving the overlay to
 *     override the next real change;
 *   - "when the record CHANGES" misses the same round trip made by an undo
 *     landing between the write and the read;
 *   - "when the write resolves" is too early, because the action fires its
 *     invalidation without awaiting it, so the read is still in flight and the
 *     box would hand itself back to the stale record and flicker again.
 *
 * The overlay is therefore lifted by a read this hook starts ITSELF, after the
 * write has committed, and awaits until a read has landed: the first
 * `refetchQueries` cancels a read already in flight, so what answers cannot be a
 * read that began before the write. Whatever those rows say is then the truth - this
 * write, or the truth after an undo that overtook it - and the box follows the
 * record again. Nothing is inferred by watching the record, so no sequence of
 * reads landing out of order can stick an overlay on. A write that does not land
 * lifts the overlay at once and rethrows, so the caller still shows the refusal.
 *
 * `queryKey` is the query that feeds the box, and doubles as the scope: when the
 * drawer moves to another rack it changes, and overlays about slides no longer on
 * screen are abandoned rather than carried across.
 */
const REREADS = 5;

export function usePendingImaging(queryKey: QueryKey) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const scope = hashKey(queryKey);
  // One token per slide: a `mark` that resolves late must not lift the overlay a
  // newer one has since put up on the same slide.
  const tokens = useRef(new Map<number, number>());
  const issued = useRef(0);

  useEffect(() => {
    tokens.current = new Map();
    setPending((current) => (current.size === 0 ? current : new Map()));
  }, [scope]);

  /** Show `value` for this slide at once, and write it; a write that fails gives the box back. */
  const mark = async (
    slideId: number,
    value: boolean,
    write: (value: boolean) => Promise<unknown>,
  ) => {
    issued.current += 1;
    const token = issued.current;
    tokens.current.set(slideId, token);
    setPending((current) => new Map(current).set(slideId, value));

    const lift = () => {
      if (tokens.current.get(slideId) !== token) return;
      tokens.current.delete(slideId);
      setPending((current) => {
        if (!current.has(slideId)) return current;
        const next = new Map(current);
        next.delete(slideId);
        return next;
      });
    };

    try {
      await write(value);
    } catch (reason) {
      lift();
      throw reason;
    }
    // A read that fails leaves the record wherever it already was, which the box
    // should show either way, so it lifts the overlay rather than surfacing as
    // though the write had been refused.
    //
    // The awaited promise resolving is not a read landing: a later fetch that
    // cancels this one resolves it empty. So it is asked again until the query
    // has taken data since, joining the read now in flight - which began after
    // this one, so after the write - rather than cancelling it. The attempts are
    // bounded so an invalidation storm cannot hold the overlay up for good.
    const landed = () => qc.getQueryState(queryKey)?.dataUpdateCount ?? 0;
    const before = landed();
    for (let attempt = 0; attempt < REREADS && landed() === before; attempt += 1) {
      await qc
        .refetchQueries({ queryKey, exact: true }, { cancelRefetch: attempt === 0 })
        .catch(() => undefined);
    }
    lift();
  };

  return {
    /** What this slide's checkbox should show: the overlay if one is up, else the record. */
    imaged: (slide: ImagedSlide) => pending.get(slide.id) ?? Boolean(slide.stage_pictures_taken_at),
    mark,
  };
}
