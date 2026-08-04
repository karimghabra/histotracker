// Browser shim for `@tauri-apps/plugin-sql`, backed by sql.js (real SQLite in
// WebAssembly). This lets the REAL app — real db.ts, real hooks, real React
// components — run in an ordinary Chromium browser so Playwright can drive it,
// without the Tauri native runtime.
//
// It is wired in via resolve.alias in vite.config.playwright.ts; production and
// `tauri dev` are untouched. The schema is the actual production migrations
// (src-tauri/migrations/*.sql) run in filename order, so there is no logic to
// keep in sync — the same SQL the Rust plugin runs.
//
// The database is persisted as a byte image in the shared virtual filesystem
// (shim-fs) under SHIM_DB_FILE. That same path is what getDbFilePath() resolves
// to here, so the core shim's read_file/save_file operate on this exact image —
// which is what makes the real image-based undo/redo run unmodified.
import initSqlJs, { type Database as SqlJsDb, type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { clearShimFs, readShimFile, writeShimFile } from "./shim-fs";

// Raw text of every migration, keyed by path; sorted by filename at load time.
const migrationSql = import.meta.glob("../../src-tauri/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// The virtual path the database image lives at. getDbFilePath() (via the
// pragma_database_list intercept below) returns this, so snapshot/restore and
// the sql.js persistence all agree on one "file".
export const SHIM_DB_FILE = "histometer-shim.db";

let SQL: SqlJsStatic | null = null;
// `?freshdb=1` should reset only the initial open, not the reopen a restore
// performs — otherwise undo would wipe the DB it just restored.
let freshHandled = false;

function shouldReset(): boolean {
  if (freshHandled) return false;
  freshHandled = true;
  try {
    if (new URLSearchParams(window.location.search).get("freshdb") === "1") {
      clearShimFs();
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function normalizeBinds(values: unknown[] | undefined): Array<number | string | Uint8Array | null> {
  return (values ?? []).map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number" || typeof v === "string" || v instanceof Uint8Array) return v;
    return String(v);
  });
}

export interface QueryResult {
  rowsAffected: number;
  lastInsertId?: number;
}

export default class Database {
  path: string;
  private db: SqlJsDb;

  private constructor(path: string, db: SqlJsDb) {
    this.path = path;
    this.db = db;
  }

  static async load(path: string): Promise<Database> {
    if (!SQL) SQL = await initSqlJs({ locateFile: () => wasmUrl });

    let db: SqlJsDb;
    const saved = !shouldReset() ? readShimFile(SHIM_DB_FILE) : null;
    if (saved) {
      db = new SQL.Database(saved);
    } else {
      db = new SQL.Database();
      const files = Object.keys(migrationSql).sort();
      for (const file of files) {
        try {
          db.run(migrationSql[file]);
        } catch (err) {
          throw new Error(`Migration failed (${file}): ${(err as Error).message}`);
        }
      }
    }
    db.run("PRAGMA foreign_keys = ON;");
    const instance = new Database(path, db);
    // Test-only escape hatch: lets a spec plant a row shape the UI cannot
    // produce — e.g. a pre-0.4.6 cut group with `duplicates > 0` and no slides,
    // which is what the read-from-a-write viewer bug needs. This file is aliased
    // in ONLY by vite.config.playwright.ts, so it never reaches a shipped build.
    (window as unknown as Record<string, unknown>).__SHIM_SQL__ = (
      sql: string,
      params?: unknown[],
    ) => {
      db.run(sql, normalizeBinds(params) as never);
      instance.persist();
    };
    instance.persist();
    return instance;
  }

  async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
    // getDbFilePath() asks SQLite for the main DB file path to snapshot. An
    // in-memory sql.js DB has no path (""), which would make getDbFilePath
    // throw; hand back the virtual path so snapshot/restore line up with shim-fs.
    if (query.includes("pragma_database_list")) {
      return [{ file: SHIM_DB_FILE }] as unknown as T;
    }
    const stmt = this.db.prepare(query);
    try {
      stmt.bind(normalizeBinds(bindValues));
      const rows: unknown[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows as unknown as T;
    } finally {
      stmt.free();
    }
  }

  async execute(query: string, bindValues?: unknown[]): Promise<QueryResult> {
    const stmt = this.db.prepare(query);
    try {
      stmt.bind(normalizeBinds(bindValues));
      stmt.step();
    } finally {
      stmt.free();
    }
    const rowsAffected = this.db.getRowsModified();
    const idRes = this.db.exec("SELECT last_insert_rowid() AS id");
    const lastInsertId = Number(idRes[0]?.values?.[0]?.[0] ?? 0);
    this.persist();
    return { rowsAffected, lastInsertId };
  }

  async close(): Promise<boolean> {
    this.persist();
    this.db.close();
    return true;
  }

  private persist(): void {
    try {
      writeShimFile(SHIM_DB_FILE, this.db.export());
    } catch {
      // Serialization failure: keep running in-memory only.
    }
  }
}
