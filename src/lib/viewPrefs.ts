/**
 * Filters that survive moving between the Board and the Logs (#104).
 *
 * Both views unmount when you switch to the other, so every filter lived in
 * `useState` that was thrown away and rebuilt at "all" — go to the Logs to check
 * something, come back, and the column you had narrowed to one project is wide
 * open again.
 *
 * Scope is deliberately the SIGNED-IN SESSION, not the machine and not the
 * database:
 *   - not the database, because a filter is one person's view of the bench, not
 *     a fact about the lab, and it must not sync to anybody else;
 *   - not for ever, because the next person at a shared machine should not
 *     inherit a board that silently hides most of it. `clearViewPrefs()` runs on
 *     sign-out.
 *
 * Values are stored as one JSON blob under one key so a new filter needs no new
 * plumbing, and every read is total: an unknown key, a corrupt blob or a value
 * of the wrong shape all fall back to the caller's default rather than throwing
 * inside a render.
 */
const KEY = "histometer-view-filters";

type Prefs = Record<string, unknown>;

function readAll(): Prefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Prefs) : {};
  } catch {
    return {};
  }
}

/**
 * `isValid` is the ONLY validation, deliberately. An earlier version also
 * required the stored value to share a `typeof` with the fallback, which looks
 * like cheap insurance and silently broke every union: a column filter is
 * `number | "all"`, so a remembered project id (number) never matched its "all"
 * fallback (string) and the filter reset on every view switch — the exact bug
 * this module exists to fix.
 */
export function readViewPref<T>(key: string, fallback: T, isValid?: (value: unknown) => boolean): T {
  const value = readAll()[key];
  if (value === undefined) return fallback;
  if (isValid && !isValid(value)) return fallback;
  return value as T;
}

export function writeViewPref(key: string, value: unknown): void {
  try {
    const all = readAll();
    all[key] = value;
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* a full or unavailable localStorage must never break the board */
  }
}

/** Drop every remembered filter — called when the signed-in user changes. */
export function clearViewPrefs(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
