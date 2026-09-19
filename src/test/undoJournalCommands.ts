// The test harnesses' model of the two Rust undo-journal commands
// (src-tauri/src/undo_journal.rs), for the browser shim (sql.js) and the compat
// shim (node:sqlite). Same statements, same order, same all-or-nothing
// transaction, and a failure rejects with the error's text as the command's
// `Err(String)` does. Change the two together.

/** The little of a SQLite handle the commands need. */
export interface SqlHandle {
  exec(sql: string): void;
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

/** The rows a replay wrote: `(from, to]` of the journal, the range that reverses it. */
export interface Replayed {
  from: number;
  to: number;
}

/**
 * `undo_journal_revert`: replay the journal rows in `(from, to]` (`to` absent: up
 * to the head), newest first, sweep the replay's audit rows, and return the range
 * the replay wrote.
 */
export function revertJournal(db: SqlHandle, from: number, to?: number | null): Replayed {
  return inTransaction(db, () => {
    const start = head(db);
    const audit = one(db, "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'), 0)");
    const rows = db.all("SELECT stmt FROM undo_journal WHERE seq > ? AND seq <= ? ORDER BY seq DESC", [from, to ?? start]);
    for (const row of rows) db.exec(String(row.stmt));
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
