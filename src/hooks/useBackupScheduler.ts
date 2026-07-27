// Drives automatic database backups: a catch-up backup on launch if one is
// overdue, then a check every few minutes that takes a snapshot once per
// `intervalHours` during the working day. Only the authoritative workstation
// backs up — a viewer's database is a read-only mirror of the workstation's, so
// backing it up would be redundant (and it can't write anyway).

import { useEffect, useRef } from "react";
import { createBackup } from "../lib/backup";
import {
  getLastBackupAt,
  intervalElapsed,
  isScheduledBackupDue,
  loadBackupConfig,
} from "../lib/backupConfig";

const CHECK_INTERVAL_MS = 5 * 60_000; // re-evaluate the schedule every 5 minutes

export function useBackupScheduler(enabled: boolean, onBackup?: (path: string) => void): void {
  // Keep the latest callback in a ref so a new closure each render doesn't tear
  // down and rebuild the interval (which would reset the timer every render).
  const onBackupRef = useRef(onBackup);
  onBackupRef.current = onBackup;

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let running = false;

    const run = async (reason: "scheduled" | "startup") => {
      if (running) return;
      running = true;
      try {
        const config = loadBackupConfig();
        const entry = await createBackup(reason, config.retention);
        if (!cancelled) onBackupRef.current?.(entry.path);
      } catch {
        // A failed auto-backup must never crash the app or spam the user; the
        // next tick will try again. Manual backups (in the dialog) surface errors.
      } finally {
        running = false;
      }
    };

    // Launch catch-up: if the last backup is overdue (or there is none),
    // secure one now regardless of working hours — the app may have been closed
    // across the window when a scheduled backup would have run.
    const startup = async () => {
      const config = loadBackupConfig();
      if (config.enabled && intervalElapsed(config, getLastBackupAt(), new Date())) {
        await run("startup");
      }
    };
    void startup();

    const tick = () => {
      const config = loadBackupConfig();
      if (isScheduledBackupDue(config, getLastBackupAt(), new Date())) void run("scheduled");
    };
    const id = window.setInterval(tick, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled]);
}
