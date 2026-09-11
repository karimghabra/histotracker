// Local database backups: create (from a WAL-checkpointed image), list, revert,
// delete. The heavy lifting — validation, atomic writes, path guards — lives in
// the Rust `backup_*` commands (src-tauri/src/backup.rs). This module is the
// thin frontend orchestration plus the snapshot/restore glue shared with undo.

import { invoke } from "@tauri-apps/api/core";
import { restoreDbPreservingSession, snapshotDb } from "./db";
import {
  backupFileName,
  parseBackupName,
  setLastBackupAt,
  type BackupReason,
} from "./backupConfig";

export interface BackupEntry {
  name: string;
  path: string;
  size: number;
  createdAt: Date;
  reason: string;
}

interface RawBackupInfo {
  name: string;
  path: string;
  size: number;
}

function decorate(info: RawBackupInfo): BackupEntry {
  const parsed = parseBackupName(info.name);
  return {
    ...info,
    createdAt: parsed?.createdAt ?? new Date(0),
    reason: parsed?.reason ?? "unknown",
  };
}

/** Existing backups, newest first. */
export async function listBackups(): Promise<BackupEntry[]> {
  const raw = await invoke<RawBackupInfo[]>("backup_list");
  return raw.map(decorate).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Take a fresh backup. Captures a WAL-checkpointed byte image (the same
 * consistent snapshot undo/redo use), writes it atomically via Rust, records
 * the time, and prunes to `retention`. Returns the new entry.
 */
export async function createBackup(reason: BackupReason, retention: number): Promise<BackupEntry> {
  const image = await snapshotDb();
  const name = backupFileName(reason);
  const info = await invoke<RawBackupInfo>("backup_write", {
    name,
    bytes: Array.from(image),
  });
  setLastBackupAt(new Date());
  // Prune is best-effort — a failure here must not fail the backup itself.
  await invoke("backup_prune", { keep: Math.max(1, retention) }).catch(() => undefined);
  return decorate(info);
}

/**
 * Revert the live database to a backup.
 *
 * A backup may be older than this version of the app. The app's numbered
 * migrations run when it launches, and each one is recorded inside the database
 * file, so an older image swapped in mid-session carries a record without the
 * newer ones. Swapping it in as it is used to brick the app: getDb() added the
 * missing columns, the record still said their migrations had never run, and
 * the next launch ran them again, failed on "duplicate column name", and could
 * not open the database at all.
 *
 * So the image first goes through the Rust `db_migrate_image` command, which
 * runs this build's migrations on a copy of it with the same migrator the
 * launch uses: what it lacks really runs, and the record it comes back with is
 * true. Then a `prerestore` safety backup is taken (so a revert is itself
 * reversible) and the image is swapped in via the same session-preserving
 * restore undo uses.
 *
 * Reverting to an older backup is therefore safe, launches after it included.
 * A backup this build cannot bring up to date is refused before anything
 * changes, with the reason: one that is not a database or is damaged, one the
 * app did not write, one made by a NEWER version, which only that version or a
 * later one can restore, and one a migration fails on. That last covers a
 * backup taken after an older version's revert had already added columns the
 * record does not account for: it is refused, not patched over.
 */
export async function revertToBackup(name: string): Promise<void> {
  const bytes = await invoke<number[]>("backup_read", { name });
  if (!bytes || bytes.length === 0) throw new Error("Backup is empty or unreadable.");
  let image: number[];
  try {
    image = await invoke<number[]>("db_migrate_image", { bytes });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`This backup cannot be restored: ${reason}. The current database has not been changed.`);
  }
  await createBackup("prerestore", 500).catch(() => undefined);
  await restoreDbPreservingSession(Uint8Array.from(image));
}

export async function deleteBackup(name: string): Promise<void> {
  await invoke("backup_delete", { name });
}

export async function backupsDirPath(): Promise<string> {
  return invoke<string>("backup_dir_path");
}
