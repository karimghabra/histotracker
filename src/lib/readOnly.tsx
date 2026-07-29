import { createContext, useContext } from "react";

/**
 * Whether this instance is a read-only viewer (issue #72).
 *
 * `db.ts` already REJECTS every write when the viewer flag is set (see
 * `guardWrites`), so a viewer could never actually change anything — but the UI
 * still offered the controls, fired the mutation, and swallowed the rejection.
 * That is what the report describes as "perpetual loading screens": the button
 * spins on a promise that was never going to resolve.
 *
 * This context lets the mutating surfaces hide or disable themselves instead, so
 * the data-layer guard becomes the backstop it was meant to be rather than the
 * first line of defence. Defaults to false, so a component rendered outside the
 * provider (tests, Storybook) behaves like the workstation.
 */
const ReadOnlyContext = createContext(false);

export const ReadOnlyProvider = ReadOnlyContext.Provider;

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}
