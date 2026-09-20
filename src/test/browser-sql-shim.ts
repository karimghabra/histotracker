// Browser shim for `@tauri-apps/plugin-sql`, backed by sql.js (real SQLite in
// WebAssembly). This lets the REAL app — real db.ts, real hooks, real React
// components — run in an ordinary Chromium browser so Playwright can drive it,
// without the Tauri native runtime.
//
// It is wired in via resolve.alias in vite.config.playwright.ts; production and
// `tauri dev` are untouched. The schema is the actual production migrations,
// the ones `src-tauri/src/lib.rs` registers, run the way the plugin runs them:
// through the sqlx migrator (./sqlx-migrator.ts) on the FIRST load of each page,
// with the `_sqlx_migrations` ledger kept inside the image. A page load is a
// process here, so a reload is a relaunch. A reopen after an undo or a
// sync pull does not migrate again, exactly as in the app.
//
// One exception, for fixtures only: an image with no ledger at all was not
// written by the app (tests/fixtures/legacy-pre-0023 is built by executing the
// migration SQL directly), and is opened as it is, the way an image swapped in
// at runtime is. The app itself never meets such a file.
//
// The database is persisted as a byte image in the shared virtual filesystem
// (shim-fs) under SHIM_DB_FILE. That same path is what getDbFilePath() resolves
// to here, so the core shim's read_file/save_file operate on this exact image —
// which is what makes the real image-based undo/redo run unmodified.
import initSqlJs, { type Database as SqlJsDb, type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { clearShimFs, readShimFile, writeShimFile } from "./shim-fs";
import {
  assertSqliteImage,
  migrateImage,
  parseMigrationList,
  runMigrator,
  type RegisteredMigration,
  type SqlFile,
} from "./sqlx-migrator";

// Raw text of every migration file, keyed by path.
const migrationSql = import.meta.glob("../../src-tauri/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// lib.rs itself, for the list it registers. Globbed like the migrations: a
// plain `import … from "…/lib.rs?raw"` stops Vite's dependency optimizer on a
// cold cache ("No loader is configured for .rs files"), and the dev server
// never starts.
const libRs = Object.values(
  import.meta.glob("../../src-tauri/src/lib.rs", { query: "?raw", import: "default", eager: true }),
)[0] as string;

let registered: Promise<RegisteredMigration[]> | null = null;

/** The migrations lib.rs registers, with the SHA-384 sqlx records for each. */
function registeredMigrations(): Promise<RegisteredMigration[]> {
  registered ??= Promise.all(
    parseMigrationList(libRs).map(async (m) => {
      const sql = migrationSql[`../../src-tauri/migrations/${m.file}`];
      if (sql === undefined) throw new Error(`lib.rs registers ${m.file}, which does not exist`);
      const digest = await crypto.subtle.digest("SHA-384", new TextEncoder().encode(sql));
      return { ...m, sql, checksum: new Uint8Array(digest) };
    }),
  );
  return registered;
}

/** True until the first Database.load of this page runs the migrator. */
let migrationsPending = true;

function sqlFile(db: SqlJsDb): SqlFile {
  return {
    exec: (sql) => void db.exec(sql),
    all: (sql, params) => {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(normalizeBinds(params));
        const rows: Array<Record<string, unknown>> = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    },
  };
}

function hasLedger(db: SqlJsDb): boolean {
  return (
    db.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'").length > 0
  );
}

/**
 * The app's `db_migrate_image` command (src-tauri/src/migrate.rs), for the core
 * shim: the image, brought up to date by this build's migrator, or refused.
 */
export async function migrateImageBytes(bytes: Uint8Array): Promise<Uint8Array> {
  assertSqliteImage(bytes);
  if (!SQL) SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new SQL.Database(bytes);
  try {
    db.run("PRAGMA foreign_keys = ON;");
    migrateImage(sqlFile(db), await registeredMigrations());
    return db.export();
  } finally {
    db.close();
  }
}

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

    const saved = !shouldReset() ? readShimFile(SHIM_DB_FILE) : null;
    const db = saved ? new SQL.Database(saved) : new SQL.Database();
    db.run("PRAGMA foreign_keys = ON;");
    if (migrationsPending) {
      // Taken off the list BEFORE it runs, as the plugin does, so a failed
      // migration is not retried by a later load: the page stays broken until
      // it is reloaded, just as the app stays broken until it is relaunched.
      migrationsPending = false;
      if (!saved || hasLedger(db)) {
        try {
          runMigrator(sqlFile(db), await registeredMigrations());
        } catch (err) {
          db.close();
          throw err;
        }
      }
    }
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
    // The read counterpart, for the stress suite: it lets a spec check the DATA
    // after driving the UI, not just what the UI drew. Most of what goes wrong
    // in a workflow app is invisible on screen — an orphaned slide, a rack left
    // open with nothing in it, a code issued twice — and only a query finds it.
    (window as unknown as Record<string, unknown>).__SHIM_SELECT__ = (
      sql: string,
      params?: unknown[],
    ) => {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(normalizeBinds(params));
        const rows: unknown[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
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
