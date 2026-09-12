// What tauri-plugin-sql does to the database file when the app opens it, for
// the test harnesses that run the app without its Rust half: the Playwright
// shim (src/test/browser-sql-shim.ts, sql.js in Chromium) and the release
// compatibility harness (tests/compat, node:sqlite). Engine-agnostic: each
// harness hands in its own SQLite connection and its own SHA-384.
//
// The plugin hands the migration list registered in `src-tauri/src/lib.rs` to
// sqlx's `Migrator` and runs it against the file on the FIRST `Database.load`
// of each process (commands.rs `load` removes the list from its map before it
// runs, so the reopen after an undo, a backup revert or a sync pull does not
// migrate again).
// The migrator keeps the versions it has applied INSIDE the file, in
// `_sqlx_migrations`, and that ledger is what decides whether a build will
// open a file at all:
//
//   - a version in the ledger that the build does not register  -> refused
//     (VersionMissing; the plugin never sets ignore_missing)
//   - a version whose SQL text changed since it was applied    -> refused
//     (VersionMismatch; the checksum is SHA-384 of the SQL)
//   - a registered version the ledger lacks                    -> its SQL runs,
//     whatever the columns already say
//
// Ported line for line from the crates the app ships with, read from source:
//   sqlx-core 0.8.6    src/migrate/migrator.rs  (run_direct, validate_applied_migrations)
//   sqlx-core 0.8.6    src/migrate/migration.rs (checksum = Sha384(sql))
//   sqlx-sqlite 0.8.6  src/migrate.rs           (table layout, dirty_version, apply)
//   tauri-plugin-sql 2.4.0 src/lib.rs, commands.rs (Up only, no_tx = false, once per process)
// tests/compat/builds.ts refuses a build whose Cargo.lock names a different
// sqlx-core or tauri-plugin-sql minor version, so this cannot silently go stale.
//
// `migrateImage` models the app's own `db_migrate_image` command
// (src-tauri/src/migrate.rs), which puts a backup or a pulled snapshot through
// this same migrator before it is swapped in.

export type SqlValue = number | bigint | string | Uint8Array | null;

/** The two things the migrator needs from a SQLite connection. */
export interface SqlFile {
  /** Run a script of one or more statements. */
  exec(sql: string): void;
  /** Run one statement and return its rows. */
  all(sql: string, params?: SqlValue[]): Array<Record<string, unknown>>;
}

export interface RegisteredMigration {
  version: number;
  description: string;
  file: string;
  sql: string;
  /** SHA-384 of `sql`, as sqlx stores it. */
  checksum: Uint8Array;
}

/**
 * The migration list a build REGISTERS, read out of its `src-tauri/src/lib.rs`.
 * The list there is explicit, not discovered, and it is what the migrator
 * runs, not the directory. Down migrations are dropped, as the plugin does.
 */
export function parseMigrationList(
  libRs: string,
  where = "src-tauri/src/lib.rs",
): Array<{ version: number; description: string; file: string }> {
  const blocks = libRs.match(/Migration\s*\{[\s\S]*?\}/g) ?? [];
  const parsed = blocks.map((block) => {
    const m = /version:\s*(\d+),\s*description:\s*"([^"]*)",\s*sql:\s*include_str!\("\.\.\/migrations\/([^"]+)"\),\s*kind:\s*MigrationKind::(\w+)/.exec(block);
    if (!m) throw new Error(`cannot read this migration entry in ${where}:\n${block}`);
    return { version: Number(m[1]), description: m[2], file: m[3], kind: m[4] };
  });
  if (parsed.length === 0) throw new Error(`no migrations registered in ${where}`);
  return parsed
    .filter((m) => m.kind === "Up")
    .map(({ version, description, file }) => ({ version, description, file }));
}

/** sqlx-sqlite `ensure_migrations_table`, verbatim. */
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS _sqlx_migrations (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN NOT NULL,
    checksum BLOB NOT NULL,
    execution_time BIGINT NOT NULL
);`;

type MigrateKind = "Dirty" | "VersionMissing" | "VersionMismatch" | "ExecuteMigration";

/** Message text is sqlx-core 0.8.6 `MigrateError`'s, so a failure reads as the app's would. */
export class MigrateError extends Error {
  constructor(
    readonly kind: MigrateKind,
    readonly version: number,
    readonly detail = "",
  ) {
    super(
      kind === "Dirty"
        ? `migration ${version} is partially applied; fix and remove row from \`_sqlx_migrations\` table`
        : kind === "VersionMissing"
          ? `migration ${version} was previously applied but is missing in the resolved migrations`
          : kind === "VersionMismatch"
            ? `migration ${version} was previously applied but has been modified`
            : `while executing migration ${version}: ${detail}`,
    );
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * `Migrator::run` with `ignore_missing = false`, as tauri-plugin-sql calls it.
 * Returns the versions it applied, in order.
 */
export function runMigrator(db: SqlFile, migrations: RegisteredMigration[]): number[] {
  db.exec(LEDGER_DDL);

  const dirty = db.all(
    "SELECT version FROM _sqlx_migrations WHERE success = false ORDER BY version LIMIT 1",
  )[0];
  if (dirty) throw new MigrateError("Dirty", Number(dirty.version));

  const applied = db.all("SELECT version, checksum FROM _sqlx_migrations ORDER BY version") as Array<{
    version: number | bigint;
    checksum: Uint8Array;
  }>;

  const known = new Set(migrations.map((m) => m.version));
  for (const row of applied) {
    if (!known.has(Number(row.version))) throw new MigrateError("VersionMissing", Number(row.version));
  }

  const appliedByVersion = new Map(applied.map((row) => [Number(row.version), row.checksum]));
  const ran: number[] = [];
  // Registration order, not sorted: Migrator::new keeps the source's order.
  for (const migration of migrations) {
    const recorded = appliedByVersion.get(migration.version);
    if (recorded) {
      if (!sameBytes(recorded, migration.checksum)) {
        throw new MigrateError("VersionMismatch", migration.version);
      }
      continue;
    }
    // sqlx-sqlite `apply`: the script and its ledger row in ONE transaction.
    db.exec("BEGIN");
    try {
      try {
        db.exec(migration.sql);
      } catch (err) {
        throw new MigrateError("ExecuteMigration", migration.version, (err as Error).message);
      }
      db.all(
        `INSERT INTO _sqlx_migrations ( version, description, success, checksum, execution_time )
         VALUES ( ?1, ?2, TRUE, ?3, -1 )`,
        [migration.version, migration.description, migration.checksum],
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    db.all("UPDATE _sqlx_migrations SET execution_time = ?1 WHERE version = ?2", [0, migration.version]);
    ran.push(migration.version);
  }
  return ran;
}

/**
 * Write the ledger a file would carry after `migrations` ran on it, for a
 * fixture that was built by executing the SQL directly, with no migrator.
 */
export function seedLedger(db: SqlFile, migrations: RegisteredMigration[]): void {
  db.exec(LEDGER_DDL);
  for (const m of migrations) {
    db.all(
      `INSERT INTO _sqlx_migrations ( version, description, success, checksum, execution_time )
       VALUES ( ?1, ?2, TRUE, ?3, 0 )`,
      [m.version, m.description, m.checksum],
    );
  }
}

// ---------------------------------------------------------------------------
// The app's `db_migrate_image` command (src-tauri/src/migrate.rs).
// Every refusal below is worded exactly as the Rust command words it.
// ---------------------------------------------------------------------------

const SQLITE_MAGIC = "SQLite format 3\0";

/** The command's error as the webview receives it: migrate.rs `Refusal`, serialized. */
export interface Refusal {
  reason: string;
  newer: boolean;
}

/** Why an image cannot be brought up to date, in the command's words. */
export class ImageRefused extends Error {
  readonly refusal: Refusal;
  constructor(reason: string, newer = false) {
    super(reason);
    this.refusal = { reason, newer };
  }
}

/** The command's first check, on the bytes before anything opens them. */
export function assertSqliteImage(bytes: Uint8Array): void {
  const header = String.fromCharCode(...bytes.subarray(0, 16));
  if (bytes.length < 100 || header !== SQLITE_MAGIC) {
    throw new ImageRefused("it is not a database file");
  }
}

/** The refusal for a migrator error: src-tauri/src/migrate.rs `refusal`. */
function refusal(err: MigrateError): ImageRefused {
  switch (err.kind) {
    case "VersionMissing":
      return new ImageRefused(
        `it was made by a newer version of Histometer (it has database migration ${err.version}, ` +
          `which this version does not have)`,
        true,
      );
    case "VersionMismatch":
      return new ImageRefused(`its database migration ${err.version} is not the one this version of Histometer has`);
    case "Dirty":
      return new ImageRefused(`database migration ${err.version} was only partly applied to it`);
    case "ExecuteMigration":
      return new ImageRefused(`bringing it up to date failed at database migration ${err.version} (${err.detail})`);
  }
}

/**
 * What `db_migrate_image` does to the image it is given, once it is open: run
 * the migrator on it exactly as a launch would. An error the migrator raises
 * outside any one migration means it could not read the image at all (sqlx's
 * `MigrateError::Execute`). Returns the versions applied.
 */
export function migrateImage(db: SqlFile, migrations: RegisteredMigration[]): number[] {
  try {
    return runMigrator(db, migrations);
  } catch (err) {
    if (err instanceof MigrateError) throw refusal(err);
    throw new ImageRefused(`it could not be read (${(err as Error).message})`);
  }
}
