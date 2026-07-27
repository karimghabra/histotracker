// Backup scheduling policy + file-name convention.
//
// The scheduler (src/hooks/useBackupScheduler.ts) takes a snapshot every
// `intervalHours` during the working day, plus one catch-up on launch if the
// last backup is overdue. All of that is driven by the pure helpers here so the
// timing rules are unit-testable without a running app. Config lives in
// localStorage — a backup schedule is a property of the physical workstation,
// not of the (backed-up, sync-able, revertable) database, so it must never ride
// along in the DB image.

export type BackupReason = "scheduled" | "manual" | "prerestore" | "startup";

export interface BackupConfig {
  enabled: boolean;
  intervalHours: number;
  /** Local hour [0–24) the working day starts (inclusive). */
  workStartHour: number;
  /** Local hour [0–24) the working day ends (exclusive). */
  workEndHour: number;
  /** Only run the periodic backup Mon–Fri. */
  workdaysOnly: boolean;
  /** How many backups to keep before the oldest are pruned. */
  retention: number;
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: true,
  intervalHours: 3,
  workStartHour: 7,
  workEndHour: 19,
  workdaysOnly: true,
  retention: 48,
};

const KEYS = {
  enabled: "histometer-backup-enabled",
  intervalHours: "histometer-backup-interval-hours",
  workStartHour: "histometer-backup-work-start",
  workEndHour: "histometer-backup-work-end",
  workdaysOnly: "histometer-backup-workdays-only",
  retention: "histometer-backup-retention",
  lastAt: "histometer-backup-last-at",
} as const;

function num(key: string, fallback: number): number {
  const raw = readLs(key);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
function bool(key: string, fallback: boolean): boolean {
  const raw = readLs(key);
  return raw == null ? fallback : raw === "true";
}
function readLs(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLs(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore quota / privacy-mode failures */
  }
}

export function loadBackupConfig(): BackupConfig {
  const d = DEFAULT_BACKUP_CONFIG;
  return {
    enabled: bool(KEYS.enabled, d.enabled),
    intervalHours: clamp(num(KEYS.intervalHours, d.intervalHours), 1, 24),
    workStartHour: clamp(num(KEYS.workStartHour, d.workStartHour), 0, 23),
    workEndHour: clamp(num(KEYS.workEndHour, d.workEndHour), 1, 24),
    workdaysOnly: bool(KEYS.workdaysOnly, d.workdaysOnly),
    retention: clamp(num(KEYS.retention, d.retention), 1, 500),
  };
}

export function saveBackupConfig(config: BackupConfig): void {
  writeLs(KEYS.enabled, String(config.enabled));
  writeLs(KEYS.intervalHours, String(config.intervalHours));
  writeLs(KEYS.workStartHour, String(config.workStartHour));
  writeLs(KEYS.workEndHour, String(config.workEndHour));
  writeLs(KEYS.workdaysOnly, String(config.workdaysOnly));
  writeLs(KEYS.retention, String(config.retention));
}

export function getLastBackupAt(): Date | null {
  const raw = readLs(KEYS.lastAt);
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}

export function setLastBackupAt(when: Date): void {
  writeLs(KEYS.lastAt, when.toISOString());
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Is `now` inside the configured working day (hours, and optionally Mon–Fri)? */
export function withinWorkingHours(config: BackupConfig, now: Date): boolean {
  if (config.workdaysOnly) {
    const day = now.getDay(); // 0 Sun … 6 Sat
    if (day === 0 || day === 6) return false;
  }
  const hour = now.getHours();
  return hour >= config.workStartHour && hour < config.workEndHour;
}

/** Has at least `intervalHours` elapsed since the last backup (or never)? */
export function intervalElapsed(config: BackupConfig, lastAt: Date | null, now: Date): boolean {
  if (!lastAt) return true;
  return now.getTime() - lastAt.getTime() >= config.intervalHours * 3_600_000;
}

/**
 * The periodic decision: back up now iff enabled, inside the working day, and
 * the interval has elapsed. (Startup catch-up is handled separately — it fires
 * regardless of working hours so opening the app after a long gap always
 * secures a fresh backup.)
 */
export function isScheduledBackupDue(config: BackupConfig, lastAt: Date | null, now: Date): boolean {
  return config.enabled && withinWorkingHours(config, now) && intervalElapsed(config, lastAt, now);
}

// ---- File-name convention ---------------------------------------------------
// histometer-backup-YYYYMMDD-HHMMSS-<reason>.db — lexicographic order == time
// order, and the frontend parses time + reason back out for display.

const NAME_RE = /^histometer-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([a-z]+)\.db$/;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

export function backupFileName(reason: BackupReason, when = new Date()): string {
  const stamp =
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `histometer-backup-${stamp}-${reason}.db`;
}

export function parseBackupName(name: string): { createdAt: Date; reason: string } | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, reason] = m;
  return {
    createdAt: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
    reason,
  };
}
