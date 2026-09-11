// The sqlx migrator (src/test/sqlx-migrator.ts, shared with the Playwright
// shim) bound to node:sqlite, with the SHA-384 checksum sqlx stores.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "./sqlite";
import * as port from "../../src/test/sqlx-migrator";

export type { RegisteredMigration } from "../../src/test/sqlx-migrator";
export { ImageRefused, MigrateError, assertSqliteImage } from "../../src/test/sqlx-migrator";

export function checksum(sql: string): Uint8Array {
  return createHash("sha384").update(sql, "utf8").digest();
}

function file(db: DatabaseSync): port.SqlFile {
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, params = []) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>,
  };
}

export const runMigrator = (db: DatabaseSync, migrations: port.RegisteredMigration[]) =>
  port.runMigrator(file(db), migrations);
export const seedLedger = (db: DatabaseSync, migrations: port.RegisteredMigration[]) =>
  port.seedLedger(file(db), migrations);
export const migrateImage = (db: DatabaseSync, migrations: port.RegisteredMigration[]) =>
  port.migrateImage(file(db), migrations);
