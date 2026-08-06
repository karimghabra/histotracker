/**
 * Workstation-configurable defaults (#92).
 *
 * These are lab policy, not per-machine preference: how many slides a block is
 * cut into, how long a session may sit idle, whether the Manifest is on show.
 * They therefore live in the DATABASE (`app_settings`, which already exists —
 * no migration, so a 0.7.x build opens a 0.8 database unchanged and simply does
 * not read the extra keys).
 *
 * `app_settings` is also the one table `restoreDbPreservingSession` carries
 * ACROSS an undo/redo swap, which is the behaviour we want: changing a default
 * is configuration, not a lab event, so Ctrl+Z should not silently move it.
 *
 * Everything here is pure and string-in/string-out, so it can be unit-tested
 * without a database and read identically by the app and by the test harness.
 */

export interface AppSettings {
  /** Slides a newly embedded block is planned for, stains included. */
  defaultTotalSlides: number;
  /** Extras a block always gets, however many stains are preselected. */
  defaultExtraSlides: number;
  /** Idle minutes before the signed-in user is dropped (#76). */
  idleLogoutMinutes: number;
  /** Whether the Manifest view is offered at all. */
  manifestVisible: boolean;
}

/**
 * Three slides, not four (#92). Four was hard-coded in three places; the bench
 * standard is three, and either way it is now a number somebody can change
 * without a release.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  defaultTotalSlides: 3,
  defaultExtraSlides: 2,
  idleLogoutMinutes: 30,
  manifestVisible: true,
};

export const SETTING_KEYS = {
  defaultTotalSlides: "default_total_slides",
  defaultExtraSlides: "default_extra_slides",
  idleLogoutMinutes: "idle_logout_minutes",
  manifestVisible: "manifest_visible",
} as const;

/** Bounds. A zero or negative slide count would produce a block with no slides,
 *  and a zero idle window would sign the user out on the spot. */
export const SETTING_LIMITS = {
  defaultTotalSlides: { min: 1, max: 40 },
  defaultExtraSlides: { min: 0, max: 40 },
  idleLogoutMinutes: { min: 1, max: 480 },
} as const;

export function clampSetting(
  key: keyof typeof SETTING_LIMITS,
  value: number,
): number {
  const { min, max } = SETTING_LIMITS[key];
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Read settings out of raw `app_settings` rows.
 *
 * Anything missing, blank or unparseable falls back to the default rather than
 * throwing: this runs against databases written by every previous version, none
 * of which have these keys at all.
 */
export function parseSettings(rows: Array<{ key: string; value: string }>): AppSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (key: keyof typeof SETTING_LIMITS): number => {
    const raw = map.get(SETTING_KEYS[key]);
    if (raw == null || raw.trim() === "") return DEFAULT_SETTINGS[key];
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampSetting(key, parsed) : DEFAULT_SETTINGS[key];
  };
  const manifestRaw = map.get(SETTING_KEYS.manifestVisible);
  return {
    defaultTotalSlides: num("defaultTotalSlides"),
    defaultExtraSlides: num("defaultExtraSlides"),
    idleLogoutMinutes: num("idleLogoutMinutes"),
    manifestVisible:
      manifestRaw == null || manifestRaw.trim() === ""
        ? DEFAULT_SETTINGS.manifestVisible
        : manifestRaw !== "0",
  };
}

/** The rows to write back for a full settings object. */
export function settingsToRows(settings: AppSettings): Array<{ key: string; value: string }> {
  return [
    { key: SETTING_KEYS.defaultTotalSlides, value: String(settings.defaultTotalSlides) },
    { key: SETTING_KEYS.defaultExtraSlides, value: String(settings.defaultExtraSlides) },
    { key: SETTING_KEYS.idleLogoutMinutes, value: String(settings.idleLogoutMinutes) },
    { key: SETTING_KEYS.manifestVisible, value: settings.manifestVisible ? "1" : "0" },
  ];
}

/**
 * How many extras to plan alongside `stainCount` preselected stains.
 *
 * This was `Math.max(2, 4 - stainCount)` written out by hand in three files, so
 * the "4" in the New Sample hint and the "4" the plan actually used were only
 * equal by coincidence. One function, one place to change (#92).
 */
export function plannedExtras(settings: AppSettings, stainCount: number): number {
  return Math.max(settings.defaultExtraSlides, settings.defaultTotalSlides - stainCount);
}
