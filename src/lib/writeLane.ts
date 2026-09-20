/**
 * The one lane every undoable action, and every undo and redo, runs in, one at a
 * time and in the order the user asked for them.
 *
 * Ordering is decided SYNCHRONOUSLY, at the call: `inLane` takes its place behind
 * whatever is already queued before it returns, with no await in between. That is
 * the whole point. A textarea's blur fires its save on the Undo button's mousedown,
 * and the click's undo arrives a moment later; both have to be in line in that
 * order before either does any work. A queue entered after an await (an earlier
 * attempt awaited a read first) lets the undo overtake the save it was meant to
 * cancel.
 *
 * Everything an action does belongs inside its slot, its preliminary reads too, so
 * a comparison against the current state sees every write queued before it.
 *
 * A failed slot does not block the lane: the next one runs either way.
 */
let tail: Promise<unknown> = Promise.resolve();

export function inLane<T>(work: () => Promise<T>): Promise<T> {
  const slot = tail.then(work, work);
  tail = slot.catch(() => undefined);
  return slot;
}

/**
 * `fn`, in the lane: the same call, taking its place in line at the moment it is
 * made. The one way a caller says "this write belongs in the lane", whether it is
 * an action (useActions) or a dialog's mutation (useData).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function laned<A extends any[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => inLane(() => fn(...args));
}

