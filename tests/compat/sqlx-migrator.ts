// What tauri-plugin-sql does to the database file when the app opens it.
//
// The plugin hands the migration list registered in `src-tauri/src/lib.rs` to
// sqlx's `Migrator` and runs it against the file on the FIRST `Database.load`
// of each process (commands.rs `load` removes the list from its map before it
// runs, so the reopen after an undo, a backup revert or a sync pull does not
// migrate again). The migrator keeps the versions it has applied INSIDE the
// file, in `_sqlx_migrations`, and that ledger is what decides whether a build
// will open a file at all:
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
// `builds.ts` refuses a build whose Cargo.lock names a different sqlx-core or
// tauri-plugin-sql minor version, so this file cannot silently go stale.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "./sqlite";

export interface RegisteredMigration {
  version: number;
  description: string;
  file: string;
  sql: string;
}

export function checksum(sql: string): Buffer {
  return createHash("sha384").update(sql, "utf8").digest();
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

/** Error text is sqlx-core 0.8.6 `MigrateError`'s, so a failure reads as the app's would. */
export class MigrateError extends Error {}

/**
 * `Migrator::run` with `ignore_missing = false`, as tauri-plugin-sql calls it.
 * Returns the versions it applied, in order.
 */
export function runMigrator(db: DatabaseSync, migrations: RegisteredMigration[]): number[] {
  db.exec(LEDGER_DDL);

  const dirty = db
    .prepare("SELECT version FROM _sqlx_migrations WHERE success = false ORDER BY version LIMIT 1")
    .get() as { version: number } | undefined;
  if (dirty) {
    throw new MigrateError(
      `migration ${dirty.version} is partially applied; fix and remove row from \`_sqlx_migrations\` table`,
    );
  }

  const applied = db
    .prepare("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
    .all() as Array<{ version: number; checksum: Uint8Array }>;

  const known = new Set(migrations.map((m) => m.version));
  for (const row of applied) {
    if (!known.has(Number(row.version))) {
      throw new MigrateError(
        `migration ${row.version} was previously applied but is missing in the resolved migrations`,
      );
    }
  }

  const appliedByVersion = new Map(applied.map((row) => [Number(row.version), row.checksum]));
  const ran: number[] = [];
  // Registration order, not sorted: Migrator::new keeps the source's order.
  for (const migration of migrations) {
    const recorded = appliedByVersion.get(migration.version);
    if (recorded) {
      if (!Buffer.from(recorded).equals(checksum(migration.sql))) {
        throw new MigrateError(
          `migration ${migration.version} was previously applied but has been modified`,
        );
      }
      continue;
    }
    // sqlx-sqlite `apply`: the script and its ledger row in ONE transaction.
    db.exec("BEGIN");
    try {
      try {
        db.exec(migration.sql);
      } catch (err) {
        throw new MigrateError(
          `while executing migration ${migration.version}: ${(err as Error).message}`,
        );
      }
      db.prepare(
        `INSERT INTO _sqlx_migrations ( version, description, success, checksum, execution_time )
         VALUES ( ?1, ?2, TRUE, ?3, -1 )`,
      ).run(migration.version, migration.description, checksum(migration.sql));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    db.prepare("UPDATE _sqlx_migrations SET execution_time = ?1 WHERE version = ?2").run(
      0,
      migration.version,
    );
    ran.push(migration.version);
  }
  return ran;
}

/**
 * Write the ledger a file would carry after `migrations` ran on it — for a
 * fixture that was built by executing the SQL directly, with no migrator.
 */
export function seedLedger(db: DatabaseSync, migrations: RegisteredMigration[]): void {
  db.exec(LEDGER_DDL);
  for (const m of migrations) {
    db.prepare(
      `INSERT INTO _sqlx_migrations ( version, description, success, checksum, execution_time )
       VALUES ( ?1, ?2, TRUE, ?3, 0 )`,
    ).run(m.version, m.description, checksum(m.sql));
  }
}
