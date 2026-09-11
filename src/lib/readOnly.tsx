import { createContext, useContext } from "react";
import { SIGNED_OUT_REFUSAL, VIEWER_REFUSAL } from "./db";

/**
 * Whether this instance may write, and if not, why not.
 *
 * `db.ts` already REJECTS every write when either gate is set (see
 * `guardWrites`), so neither a viewer nor an unsigned user could actually change
 * anything — but the UI still offered the controls, fired the mutation, and
 * swallowed the rejection. That is what the #72 report describes as "perpetual
 * loading screens": the button spins on a promise that was never going to
 * resolve.
 *
 * This context lets the mutating surfaces hide or disable themselves instead, so
 * the data-layer guard becomes the backstop it was meant to be rather than the
 * first line of defence.
 *
 * There are two reasons a surface goes read-only and they are not the same
 * thing, which is why the reason travels with the flag (#128):
 *
 *   · **viewer** — this machine is a read-only mirror of someone else's
 *     database. Nothing the user does here will ever help; the work happens on
 *     the workstation.
 *   · **signed out** — this machine is a workstation, and the fix is one click
 *     away: say who you are. Telling that user to "go to the workstation" would
 *     be both wrong and baffling.
 *
 * Defaults to writable, so a component rendered outside the provider (tests,
 * Storybook) behaves like a signed-in workstation.
 */
export type ReadOnlyReason = "viewer" | "signed-out" | null;

export interface ReadOnlyState {
  readOnly: boolean;
  reason: ReadOnlyReason;
}

const ReadOnlyContext = createContext<ReadOnlyState>({ readOnly: false, reason: null });

export const ReadOnlyProvider = ReadOnlyContext.Provider;

/** The boolean every hide-or-disable site already asks for. */
export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext).readOnly;
}

export function useReadOnlyReason(): ReadOnlyReason {
  return useContext(ReadOnlyContext).reason;
}

/**
 * Specifically a viewer install — NOT merely "cannot write".
 *
 * The difference matters for the controls that manage the SESSION rather than
 * the lab record. Gating "Manage users" on plain read-only locked the signed-out
 * user out of the one dialogue that lets them sign in: the app came up unsigned,
 * hid the way in, and every spec sat waiting sixty seconds for a button that was
 * never going to appear. Session controls are viewer-gated; record controls are
 * read-only-gated.
 */
export function useIsViewer(): boolean {
  return useContext(ReadOnlyContext).reason === "viewer";
}

/** What to tell the user, in the words that match their situation. */
export function readOnlyMessage(reason: ReadOnlyReason): string {
  return reason === "signed-out" ? SIGNED_OUT_REFUSAL : VIEWER_REFUSAL;
}

/**
 * The same, where the viewer's version says something more specific about the
 * surface it is attached to ("slides are assigned on the workstation"). An
 * unsigned user gets the one sentence that is true everywhere: sign in.
 */
export function readOnlyNotice(reason: ReadOnlyReason, viewerDetail: string): string {
  return reason === "signed-out" ? SIGNED_OUT_REFUSAL : viewerDetail;
}
