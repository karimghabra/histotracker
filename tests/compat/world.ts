// Shared state for the compatibility harness: the machines, the process the app
// is "running" in, and the fake sync remote.
//
// It lives on globalThis rather than in module scope because every launch calls
// vi.resetModules() to start the build's code from scratch — and that would
// otherwise hand each launch a fresh, empty copy of this state as well.

import type { RegisteredMigration } from "./sqlx-migrator";

export interface Machine {
  name: string;
  /** The SQLite file tauri-plugin-sql opens for `sqlite:histometer.db`. */
  dbFile: string;
  backupsDir: string;
  /** This machine's webview localStorage. */
  storage: Map<string, string>;
  /** What the Rust `sync_config_*` commands hold for this machine. */
  syncConfig: Record<string, unknown>;
}

export interface AppProcess {
  machine: Machine;
  buildLabel: string;
  migrations: RegisteredMigration[];
  /** True until the first Database.load of this process runs the migrator. */
  migrationsPending: boolean;
  /** Versions the migrator applied in this process. */
  applied: number[];
}

export interface World {
  process: AppProcess | null;
  remote: {
    files: Map<string, { content: string; sha: string }>;
    assets: Map<string, number[]>;
    seq: number;
  };
}

const KEY = "__HISTOMETER_COMPAT_WORLD__";

export function world(): World {
  const g = globalThis as unknown as Record<string, World | undefined>;
  if (!g[KEY]) {
    g[KEY] = { process: null, remote: { files: new Map(), assets: new Map(), seq: 0 } };
  }
  return g[KEY]!;
}

export function currentProcess(): AppProcess {
  const proc = world().process;
  if (!proc) throw new Error("[compat] the app is not running — call launch() first");
  return proc;
}
