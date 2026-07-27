import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKUP_CONFIG,
  backupFileName,
  intervalElapsed,
  isScheduledBackupDue,
  parseBackupName,
  withinWorkingHours,
  type BackupConfig,
} from "./backupConfig";

const base: BackupConfig = { ...DEFAULT_BACKUP_CONFIG }; // 3h, 07–19, Mon–Fri, keep 48

// A weekday and a weekend anchor (2026-07-27 is a Monday, 2026-07-25 a Saturday).
const monday = (h: number, m = 0) => new Date(2026, 6, 27, h, m, 0);
const saturday = (h: number) => new Date(2026, 6, 25, h, 0, 0);

describe("withinWorkingHours", () => {
  it("is true inside work hours on a weekday", () => {
    expect(withinWorkingHours(base, monday(7))).toBe(true);
    expect(withinWorkingHours(base, monday(12))).toBe(true);
    expect(withinWorkingHours(base, monday(18, 59))).toBe(true);
  });
  it("is false before start and at/after end", () => {
    expect(withinWorkingHours(base, monday(6, 59))).toBe(false);
    expect(withinWorkingHours(base, monday(19))).toBe(false);
  });
  it("is false on the weekend when workdaysOnly", () => {
    expect(withinWorkingHours(base, saturday(12))).toBe(false);
  });
  it("allows the weekend when workdaysOnly is off", () => {
    expect(withinWorkingHours({ ...base, workdaysOnly: false }, saturday(12))).toBe(true);
  });
});

describe("intervalElapsed", () => {
  it("is true when there is no prior backup", () => {
    expect(intervalElapsed(base, null, monday(9))).toBe(true);
  });
  it("is false before the interval and true at/after it", () => {
    const last = monday(9);
    expect(intervalElapsed(base, last, monday(11, 59))).toBe(false); // <3h
    expect(intervalElapsed(base, last, monday(12))).toBe(true); // ==3h
    expect(intervalElapsed(base, last, monday(15))).toBe(true); // >3h
  });
});

describe("isScheduledBackupDue", () => {
  it("fires only when enabled + in-hours + interval elapsed", () => {
    expect(isScheduledBackupDue(base, monday(9), monday(12, 30))).toBe(true);
  });
  it("does not fire outside working hours even if overdue", () => {
    expect(isScheduledBackupDue(base, monday(3), monday(6))).toBe(false); // before work
    expect(isScheduledBackupDue(base, monday(3), monday(20))).toBe(false); // after work
    expect(isScheduledBackupDue(base, saturday(3), saturday(12))).toBe(false); // weekend
  });
  it("does not fire before the interval elapses", () => {
    expect(isScheduledBackupDue(base, monday(12), monday(13))).toBe(false);
  });
  it("never fires when disabled", () => {
    expect(isScheduledBackupDue({ ...base, enabled: false }, null, monday(12))).toBe(false);
  });
});

describe("backup file names", () => {
  it("round-trips reason + timestamp through the file name", () => {
    const when = new Date(2026, 6, 27, 13, 15, 9);
    const name = backupFileName("scheduled", when);
    expect(name).toBe("histometer-backup-20260727-131509-scheduled.db");
    const parsed = parseBackupName(name);
    expect(parsed?.reason).toBe("scheduled");
    expect(parsed?.createdAt.getTime()).toBe(when.getTime());
  });
  it("sorts lexicographically in chronological order", () => {
    const a = backupFileName("manual", new Date(2026, 6, 27, 9, 0, 0));
    const b = backupFileName("manual", new Date(2026, 6, 27, 12, 0, 0));
    expect([b, a].sort()).toEqual([a, b]);
  });
  it("returns null for a foreign name", () => {
    expect(parseBackupName("not-a-backup.db")).toBeNull();
    expect(parseBackupName("histometer-backup-bad.db")).toBeNull();
  });
});
