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
 * Revert the live database to a backup. First takes a `prerestore` safety
 * backup (so a revert is itself reversible), then swaps the image in via the
 * same session-preserving restore undo uses. Because restore reopens through
 * getDb(), the runtime schema guard converges any columns a newer build added
 * since the backup was taken — so reverting to an OLDER backup is safe.
 */
export async function revertToBackup(name: string): Promise<void> {
  await createBackup("prerestore", 500).catch(() => undefined);
  const bytes = await invoke<number[]>("backup_read", { name });
  if (!bytes || bytes.length === 0) throw new Error("Backup is empty or unreadable.");
  await restoreDbPreservingSession(Uint8Array.from(bytes));
}

export async function deleteBackup(name: string): Promise<void> {
  await invoke("backup_delete", { name });
}

export async function backupsDirPath(): Promise<string> {
  return invoke<string>("backup_dir_path");
}
