import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "../compat/sqlite";
import { REPO_ROOT, registeredMigrations } from "../compat/builds";
import { seedLedger } from "../compat/sqlx-migrator";

// Database images for the specs that swap one in from elsewhere (a backup, a
// pulled snapshot), as base64, the form the shim's virtual disk keeps them in.

/** The migrations this tree registers. */
export const MIGRATIONS = registeredMigrations(REPO_ROOT);
export const NEWEST = Math.max(...MIGRATIONS.map((m) => m.version));

/** Open `b64` as a SQLite file, let `edit` change it, and hand back its bytes. */
export function editImage(b64: string, edit: (db: DatabaseSync) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "histometer-image-"));
  const file = join(dir, "image.db");
  try {
    writeFileSync(file, Buffer.from(b64, "base64"));
    const db = new DatabaseSync(file);
    edit(db);
    db.close();
    return readFileSync(file).toString("base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A database from before migrations 23 and 24: the populated legacy database
 * (tests/fixtures/legacy-pre-0023), with the migration record the app would
 * have written into it. It was built by executing migrations 1 to 22 directly, so
 * the record is the one thing it lacks. Its lab is project "Enthesis
 * Engineering" with blocks EE-1 to EE-3.
 */
export function preMigrationImage(): string {
  const fixture = readFileSync(join(REPO_ROOT, "tests", "fixtures", "legacy-pre-0023.b64"), "utf8").trim();
  return editImage(fixture, (db) => seedLedger(db, MIGRATIONS.filter((m) => m.version <= 22)));
}

/** `b64` as a newer version of Histometer would leave it: one migration more than this tree has. */
export function fromANewerVersion(b64: string): string {
  return editImage(b64, (db) =>
    db
      .prepare(
        `INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
         VALUES (?, 'from the future', TRUE, x'00', 0)`,
      )
      .run(NEWEST + 1),
  );
}
