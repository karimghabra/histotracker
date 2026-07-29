import { useEffect, useRef } from "react";

/** Idle window before a signed-in user is dropped. 30 minutes. */
export const IDLE_LOGOUT_MS = 30 * 60_000;

/** Activity that counts as "someone is still at this machine". */
const ACTIVITY_EVENTS = [
  "mousedown",
  "keydown",
  "wheel",
  "touchstart",
  "pointerdown",
] as const;

/**
 * Sign the active user out after a period of no interaction (issue #76).
 *
 * A shared bench machine tends to keep whoever signed in last attributed to
 * every subsequent change — including work done by the next person. Dropping the
 * session on idle makes the attribution recorded in the audit trail (and in the
 * published snapshot, #77) mean something.
 *
 * Deliberately NOT reset by mousemove: a nudged mouse or a re-render should not
 * count as presence. The timer restarts on real input, and the whole hook is
 * inert while `enabled` is false (nobody signed in, or a read-only viewer).
 */
export function useIdleLogout(
  enabled: boolean,
  onIdle: () => void,
  timeoutMs: number = IDLE_LOGOUT_MS,
): void {
  // Hold the callback in a ref so re-created closures don't restart the timer.
  const onIdleRef = useRef(onIdle);
  useEffect(() => {
    onIdleRef.current = onIdle;
  }, [onIdle]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => onIdleRef.current(), timeoutMs);
    };
    reset();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, reset, { passive: true });
    }
    return () => {
      clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, reset);
    };
  }, [enabled, timeoutMs]);
}
