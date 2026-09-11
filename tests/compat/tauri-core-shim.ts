// `@tauri-apps/api/core` for the compatibility harness: the Rust commands the
// data layer reaches, against real files on the current machine.
//
//   read_file / save_file  - lib.rs: plain std::fs on the live database path
//                            (snapshots, undo, sync publish and pull)
//   backup_*               - backup.rs: validated, atomic, named backups
//   db_migrate_image       - migrate.rs: the running build's migrations, run on a
//                            staging copy of an image (a backup before a revert)
//   sync_config_* / github_* - sync.rs: per-machine config plus ONE shared fake
//                            remote, so a workstation and a viewer on different
//                            builds really exchange the database file
//
// Anything else throws, so a build that starts relying on a new command fails
// loudly here instead of being silently answered.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "./sqlite";
import { assertSqliteImage, migrateImage } from "./sqlx-migrator";
import { currentProcess, world } from "./world";

const BACKUP_PREFIX = "histometer-backup-";
const BACKUP_EXT = ".db";
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

function safeBackupName(name: string): void {
  if (/[/\\\0]|\.\./.test(name)) throw new Error("invalid backup name");
  if (!name.startsWith(BACKUP_PREFIX) || !name.endsWith(BACKUP_EXT)) {
    throw new Error("unexpected backup file name");
  }
}

function backupList(dir: string): Array<{ name: string; path: string; size: number }> {
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_EXT))
    .sort()
    .map((name) => ({ name, path: join(dir, name), size: statSync(join(dir, name)).size }));
}

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const machine = currentProcess().machine;
  const remote = world().remote;
  const out = (value: unknown) => value as T;

  switch (cmd) {
    case "read_file":
      return out(Array.from(readFileSync(String(args.path))));
    case "save_file":
      writeFileSync(String(args.path), Uint8Array.from((args.contents as number[]) ?? []));
      return out(undefined);

    case "backup_dir_path":
      mkdirSync(machine.backupsDir, { recursive: true });
      return out(machine.backupsDir);
    case "backup_write": {
      const name = String(args.name);
      safeBackupName(name);
      const bytes = Buffer.from(Uint8Array.from((args.bytes as number[]) ?? []));
      if (bytes.length < 16 || !bytes.subarray(0, 16).equals(SQLITE_MAGIC)) {
        throw new Error("refusing to write a backup that is not a valid SQLite image");
      }
      mkdirSync(machine.backupsDir, { recursive: true });
      const finalPath = join(machine.backupsDir, name);
      writeFileSync(`${finalPath}.tmp`, bytes);
      renameSync(`${finalPath}.tmp`, finalPath);
      return out({ name, path: finalPath, size: bytes.length });
    }
    case "backup_list":
      return out(backupList(machine.backupsDir));
    case "backup_read": {
      const name = String(args.name);
      safeBackupName(name);
      return out(Array.from(readFileSync(join(machine.backupsDir, name))));
    }
    case "backup_delete": {
      const name = String(args.name);
      safeBackupName(name);
      rmSync(join(machine.backupsDir, name));
      return out(undefined);
    }
    case "db_migrate_image": {
      const bytes = Uint8Array.from((args.bytes as number[]) ?? []);
      assertSqliteImage(bytes);
      const dir = mkdtempSync(join(tmpdir(), "histometer-migrate-"));
      try {
        const file = join(dir, "staging.db");
        writeFileSync(file, bytes);
        const db = new DatabaseSync(file);
        try {
          db.exec("PRAGMA foreign_keys = ON;");
          migrateImage(db, currentProcess().migrations);
        } finally {
          db.close();
        }
        return out(Array.from(readFileSync(file)));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    case "backup_prune": {
      const all = backupList(machine.backupsDir);
      const keep = Number(args.keep ?? 48);
      const doomed = all.slice(0, Math.max(0, all.length - keep));
      for (const b of doomed) rmSync(b.path, { force: true });
      return out(doomed.map((b) => b.name));
    }

    case "sync_config_get":
      return out({ ...machine.syncConfig });
    case "sync_config_set":
      Object.assign(machine.syncConfig, args.input as Record<string, unknown>);
      return out(undefined);
    case "sync_set_last_version":
      machine.syncConfig.last_synced_version = String(args.version ?? "");
      return out(undefined);

    case "github_get_file":
      return out(remote.files.get(String(args.path)) ?? null);
    case "github_put_file": {
      remote.seq += 1;
      const sha = `sha-${remote.seq}`;
      remote.files.set(String(args.path), { content: String(args.content ?? ""), sha });
      return out(sha);
    }
    case "github_delete_file":
      remote.files.delete(String(args.path));
      return out(undefined);
    case "github_list_dir": {
      const prefix = `${String(args.path).replace(/\/$/, "")}/`;
      return out(
        [...remote.files]
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, f]) => ({ name: path.split("/").pop(), path, sha: f.sha })),
      );
    }
    case "github_upload_release_asset":
      remote.assets.set(`${args.tag}/${args.assetName}`, (args.bytes as number[]) ?? []);
      return out(undefined);
    case "github_download_release_asset":
      return out(remote.assets.get(`${args.tag}/${args.assetName}`) ?? []);
    case "github_validate":
      return out("ok");

    // The native "Save as…" dialog, dismissed: the exports under test build
    // their bytes before asking where to put them.
    case "plugin:dialog|save":
      return out(null);

    default:
      throw new Error(`[compat] unhandled Tauri command: ${cmd}`);
  }
}

export function transformCallback(): number {
  return 0;
}
export const convertFileSrc = (src: string): string => src;
export function isTauri(): boolean {
  return false;
}
