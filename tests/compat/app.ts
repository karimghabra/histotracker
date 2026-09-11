// Running a build: launch it on a machine, drive it through its own data layer,
// quit it, and look at the file it left behind.

import { vi } from "vitest";
import { DatabaseSync } from "./sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Build } from "./builds";
import { type Machine, world } from "./world";

/** A build's modules, as the app loads them. Typed loosely on purpose: the
 * release's API is whatever the release shipped, not what this branch says. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Module = Record<string, any>;

export interface App {
  build: Build;
  machine: Machine;
  db: Module;
  backup: Module;
  sync: Module;
  exporter: Module;
  /** Migration versions this launch applied to the file. */
  applied: number[];
}

let scratch: string | null = null;

export function newMachine(name: string, role: "workstation" | "viewer" = "workstation"): Machine {
  scratch ??= mkdtempSync(join(tmpdir(), "histometer-compat-"));
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return {
    name,
    dbFile: join(dir, "histometer.db"),
    backupsDir: join(dir, "backups"),
    storage: new Map(),
    syncConfig: {
      role,
      repo_owner: "lab",
      repo_name: "histometer-data",
      operator_name: name,
      operator_initials: "",
      last_synced_version: "",
      install_id: "",
      configured: true,
      has_token: true,
    },
  };
}

/**
 * Start `build` on `machine`: a new process, so the migrator runs on the first
 * open, then the build's own getDb() — its runtime schema convergence and its
 * one-time repairs — exactly what the app does before the first screen draws.
 */
export async function launch(build: Build, machine: Machine): Promise<App> {
  const w = world();
  if (w.process) throw new Error(`[compat] ${w.process.buildLabel} is still running — quit() it first`);
  w.process = {
    machine,
    buildLabel: build.label,
    migrations: build.migrations,
    migrationsPending: true,
    applied: [],
  };
  vi.resetModules();
  const load = (file: string): Promise<Module> => import(/* @vite-ignore */ join(build.root, "src", "lib", file));
  const [db, backup, sync, exporter] = await Promise.all([
    load("db.ts"),
    load("backup.ts"),
    load("githubSync.ts"),
    load("export.ts"),
  ]);
  try {
    await db.getDb();
  } catch (err) {
    w.process = null;
    throw new Error(
      `${build.label} (${build.version}) cannot open the database on ${machine.name}: ${(err as Error).message}`,
    );
  }
  return { build, machine, db, backup, sync, exporter, applied: w.process.applied };
}

export async function quit(app: App): Promise<void> {
  await app.db.resetDb();
  world().process = null;
}

// ---------------------------------------------------------------------------
// Looking at the file directly, with no build's code in the way.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
export interface Dump {
  [table: string]: { columns: string[]; rows: Map<number, Row> };
}

function plain(value: unknown): unknown {
  return value instanceof Uint8Array ? `x'${Buffer.from(value).toString("hex")}'` : value;
}

function withFile<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Every row of every table the app owns, keyed by rowid. */
export function dump(file: string): Dump {
  return withFile(file, (db) => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const out: Dump = {};
    for (const { name } of tables) {
      const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      const rows = new Map<number, Row>();
      for (const r of db.prepare(`SELECT rowid AS __rowid, * FROM "${name}"`).all() as Row[]) {
        const { __rowid, ...rest } = r;
        rows.set(Number(__rowid), Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, plain(v)])));
      }
      out[name] = { columns, rows };
    }
    return out;
  });
}

/**
 * What `before` held that `after` lost or changed: tables, columns, rows, and
 * values in the columns `before` had. New tables, columns and rows are not
 * differences — adding is what a compatible change does.
 */
export function lostOrChanged(before: Dump, after: Dump, limit = 25): string[] {
  const out: string[] = [];
  for (const [table, b] of Object.entries(before)) {
    const a = after[table];
    if (!a) {
      out.push(`table ${table} is gone`);
      continue;
    }
    for (const col of b.columns) if (!a.columns.includes(col)) out.push(`column ${table}.${col} is gone`);
    for (const [rowid, row] of b.rows) {
      const now = a.rows.get(rowid);
      if (!now) {
        out.push(`${table} row ${rowid} is gone: ${JSON.stringify(row)}`);
        continue;
      }
      for (const col of b.columns) {
        if (JSON.stringify(row[col]) !== JSON.stringify(now[col])) {
          out.push(`${table} row ${rowid} ${col}: ${JSON.stringify(row[col])} -> ${JSON.stringify(now[col])}`);
        }
      }
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

export function columnsOf(file: string): Record<string, Array<{ name: string; notnull: number; dflt_value: unknown }>> {
  return withFile(file, (db) => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>;
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>,
      ]),
    );
  });
}

export function ledger(file: string): number[] {
  return withFile(file, (db) =>
    (db.prepare(`SELECT version FROM _sqlx_migrations ORDER BY version`).all() as Array<{ version: number }>).map(
      (r) => Number(r.version),
    ),
  );
}
