// `@tauri-apps/plugin-sql` for the compatibility harness: a real SQLite file on
// disk (node:sqlite), opened the way the shipped plugin opens it.
//
// Aliased in by vitest.compat.config.ts for EVERY build under test, so the only
// thing that differs between the release and this branch is their own code.
// What it reproduces from tauri-plugin-sql 2.4.0 / sqlx 0.8.6:
//   - the first load of a process runs the registered migrations through the
//     real migrator's rules (sqlx-migrator.ts); later loads do not;
//   - foreign_keys = ON and no journal_mode override (sqlx SqliteConnectOptions
//     defaults), so the file is a plain rollback-journal database;
//   - `select` returns row objects and `execute` returns rowsAffected and
//     lastInsertId, as the JS API does.

import { DatabaseSync } from "./sqlite";
import { currentProcess } from "./world";
import { runMigrator } from "./sqlx-migrator";

type Bind = number | string | bigint | Uint8Array | null;

function normalizeBinds(values: unknown[] | undefined): Bind[] {
  return (values ?? []).map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number" || typeof v === "string" || typeof v === "bigint") return v;
    if (v instanceof Uint8Array) return v;
    return JSON.stringify(v);
  });
}

export interface QueryResult {
  rowsAffected: number;
  lastInsertId?: number;
}

export default class Database {
  path: string;
  private db: DatabaseSync;

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.db = db;
  }

  static async load(path: string): Promise<Database> {
    if (path !== "sqlite:histometer.db") {
      throw new Error(`[compat] unexpected database url ${path}`);
    }
    const proc = currentProcess();
    const db = new DatabaseSync(proc.machine.dbFile);
    db.exec("PRAGMA foreign_keys = ON;");
    if (proc.migrationsPending) {
      // Removed from the plugin's map BEFORE it runs, so a failed migration is
      // not retried by a later load in the same process — the app stays broken
      // until it is restarted, exactly as the shipped build does.
      proc.migrationsPending = false;
      try {
        proc.applied = runMigrator(db, proc.migrations);
      } catch (err) {
        db.close();
        throw err;
      }
    }
    return new Database(path, db);
  }

  async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
    return this.db.prepare(query).all(...normalizeBinds(bindValues)) as unknown as T;
  }

  async execute(query: string, bindValues?: unknown[]): Promise<QueryResult> {
    const result = this.db.prepare(query).run(...normalizeBinds(bindValues));
    return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
  }

  async close(): Promise<boolean> {
    if (this.db.isOpen) this.db.close();
    return true;
  }
}
