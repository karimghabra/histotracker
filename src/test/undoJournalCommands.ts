// The test harnesses' model of the two Rust undo-journal commands
// (src-tauri/src/undo_journal.rs), for the browser shim (sql.js) and the compat
// shim (node:sqlite). Same statements, same order, same all-or-nothing
// transaction, and a failure rejects with the error's text as the command's
// `Err(String)` does. Change the two together.

// With the extension, so `pnpm test` can import this file straight into Node.
import { CHANGED_SINCE } from "../lib/undoJournal.ts";

/** The little of a SQLite handle the commands need. */
export interface SqlHandle {
  exec(sql: string): void;
  /** Run one statement and report the rows IT changed (sqlite3_changes, as `rows_affected`). */
  run(sql: string): number;
  all(sql: string, params?: Array<number | string>): Array<Record<string, unknown>>;
}

function inTransaction<T>(db: SqlHandle, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  let value: T;
  try {
    value = work();
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // As the Rust command: the rollback is best-effort, the error is what is reported.
    }
    throw err instanceof Error ? err.message : String(err);
  }
  db.exec("COMMIT");
  return value;
}

const one = (db: SqlHandle, sql: string, params?: Array<number | string>) =>
  Number(Object.values(db.all(sql, params)[0] ?? {})[0] ?? 0);

const head = (db: SqlHandle) =>
  one(db, "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'undo_journal'), 0)");

/**
 * A constraint violation, as sqlx's `ErrorKind` tells the Rust command apart from
 * a busy database or a statement that cannot run (`is_constraint`,
 * src-tauri/src/undo_journal.rs). node:sqlite and sql.js both report these in the
 * message SQLite itself writes, which is what this stands in for.
 */
const CONSTRAINT = /constraint failed/i;

/** The rows a replay wrote: `(from, to]` of the journal, the range that reverses it. */
export interface Replayed {
  from: number;
  to: number;
}

/**
 * `undo_journal_revert`: replay the journal rows in `(from, to]`, newest first,
 * sweep the replay's audit rows, and return the range the replay wrote.
 *
 * Every statement must touch exactly one row: each is one row's guarded inverse,
 * so none matching means something outside the range has changed that row since,
 * and the replay is refused with nothing changed. A constraint violation is the
 * same refusal, from the other side: the row's key has been taken since. Any
 * other failure is reported as it is, so the caller can keep the step.
 */
export function revertJournal(db: SqlHandle, from: number, to: number): Replayed {
  return inTransaction(db, () => {
    const start = head(db);
    const audit = one(db, "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'), 0)");
    const rows = db.all("SELECT stmt FROM undo_journal WHERE seq > ? AND seq <= ? ORDER BY seq DESC", [from, to]);
    for (const row of rows) {
      let changed: number;
      try {
        changed = db.run(String(row.stmt));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!CONSTRAINT.test(message)) throw err;
        throw new Error(CHANGED_SINCE);
      }
      if (changed !== 1) throw new Error(CHANGED_SINCE);
    }
    db.all("DELETE FROM audit_events WHERE id > ? RETURNING id", [audit]);
    return { from: start, to: head(db) };
  });
}

/** `undo_journal_install`: run every statement, or none. */
export function executeBatch(db: SqlHandle, statements: string[]): void {
  inTransaction(db, () => {
    for (const statement of statements) db.exec(statement);
  });
}
