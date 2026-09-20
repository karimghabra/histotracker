import type Database from "@tauri-apps/plugin-sql";

/**
 * The undo journal: every change to the lab record writes its own inverse, as SQL,
 * inside the same statement that makes the change.
 *
 * Undo used to copy the whole database file before every save, across the IPC
 * boundary as a JSON integer array: seconds on a lab-sized database, and every
 * undo race lived in that window. Here nothing is copied. A trigger on each
 * journaled table appends the statement that would reverse the row it just
 * touched, so the record of how to go back is written atomically with the change
 * and costs the size of the change, not the size of the database.
 *
 * An undo entry is a RANGE of the journal, the head either side of its action.
 * Replaying it newest first returns every journaled table to exactly its state at
 * the start of the range. The replay is itself journaled, so the rows it writes
 * are the redo. The replay runs in one transaction in Rust
 * (src-tauri/src/undo_journal.rs), because statements sent through
 * tauri-plugin-sql's pool cannot share one.
 *
 * Each inverse CARRIES ITS OWN PRECONDITION: it matches the row only while the row
 * still holds exactly what the change left there. A replay is one entry's range of
 * the journal, not everything after it, so a write that landed outside that range
 * -- the sync timer draining a viewer's request between an Undo and the Redo of
 * it -- would otherwise be half-erased by a full-row restore. Guarded, that
 * statement matches no row, and the replay refuses with nothing changed
 * (`undo_journal.rs` requires every statement to touch exactly one row).
 *
 * The triggers are persistent, not TEMP: the pool has several connections, and a
 * TEMP trigger exists on one connection only. They are created at runtime by
 * getDb(), with no numbered migration, like `samples.embedding_notes` (AGENTS.md):
 * a migration records its version in the file, and the build in use refuses a
 * database recording a version it does not know, so rolling back would break.
 */

/**
 * What a replay is refused with when a row it would put back is no longer as the
 * action left it, so restoring the whole row would erase whatever changed it.
 * The wording is the command's contract: `CHANGED_SINCE` in
 * src-tauri/src/undo_journal.rs, which is what the running app actually raises,
 * and src/test/undoJournalCommands.ts models. Change all three together.
 */
export const CHANGED_SINCE =
  "Cannot undo or redo that step: the records it would put back have changed since. Nothing was changed.";

/** Session and bookkeeping tables. Undo has never rewound these (restoreDbPreservingSession). */
const NOT_JOURNALED = new Set([
  "users",
  "app_settings",
  "schema_meta",
  "undo_journal",
  "_sqlx_migrations",
]);

const TRIGGER_PREFIX = "undo_journal_";

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** A SQL string literal holding `text`, for splicing fixed text into a trigger body. */
const lit = (text: string) => `'${text.replace(/'/g, "''")}'`;

export const JOURNAL_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS undo_journal (` +
  `seq INTEGER PRIMARY KEY AUTOINCREMENT, stmt TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')))`;

/**
 * How much journal is worth carrying.
 *
 * The cost is BYTES, not rows: the journal rides inside the database file, so it
 * is copied into every backup and uploaded whole in every snapshot the
 * workstation publishes. Rows vary by two orders of magnitude - an UPDATE inverse
 * writes each of a table's columns twice, once to set it back and once to guard
 * it, and a block's four note fields hold whatever was typed at the bench - so a
 * row count says little about the payload. Five megabytes is the ceiling: a
 * fraction of a lab-sized database (about 23 MB), and far more journal than the
 * hundred-step stack can reach in ordinary use, where `pruneJournal` keeps it
 * near the live stack anyway. The row count and the age are secondary guards,
 * for a journal that is small in bytes and long in rows or in days.
 */
const KEEP_BYTES = 5 * 1024 * 1024;
const KEEP_ROWS = 20_000;
const KEEP_DAYS = 14;

/**
 * Forget journal rows past the bound above, oldest first.
 *
 * Run at open (db.ts), where nothing is live yet: the undo stack is empty until
 * the history is hydrated, and that hydration is anchored to the journal's ends,
 * so a history needing a row this trimmed is dropped rather than half replayed
 * (undoPersist.ts). A replay is never left with part of its range.
 */
export function journalTrimStatements(): string[] {
  const running = `SUM(LENGTH(CAST(stmt AS BLOB))) OVER (ORDER BY seq DESC)`;
  return [
    `DELETE FROM undo_journal WHERE at < datetime('now', '-${KEEP_DAYS} days')`,
    `DELETE FROM undo_journal WHERE seq NOT IN (` +
      `SELECT seq FROM (SELECT seq, ${running} AS bytes FROM undo_journal) WHERE bytes <= ${KEEP_BYTES})`,
    `DELETE FROM undo_journal WHERE seq NOT IN (SELECT seq FROM undo_journal ORDER BY seq DESC LIMIT ${KEEP_ROWS})`,
  ];
}

/**
 * The three triggers that journal `table`, whose columns are `columns`.
 *
 * `rowidAlias` says a column already IS the rowid (an INTEGER PRIMARY KEY), which
 * then carries the row's identity; otherwise the rowid is written out beside the
 * columns, so a re-inserted row comes back under the id everything else refers to.
 *
 * The inverse of an INSERT and of an UPDATE is guarded by the row's post-change
 * values, so it applies only while nothing else has touched that row since; the
 * inverse of a DELETE needs no guard, because it re-inserts under the same rowid
 * and SQLite refuses that outright if anything has taken the row's place.
 */
export function journalTriggers(
  table: string,
  columns: string[],
  rowidAlias: boolean,
): Array<{ name: string; sql: string }> {
  const t = ident(table);
  const name = (op: string) => `${TRIGGER_PREFIX}${table}_${op}`;
  const values = (row: "old") =>
    columns.map((c) => `quote(${row}.${ident(c)})`).join(` || ',' || `);
  const assignments = columns
    .map(
      (c, i) =>
        `${lit(`${i === 0 ? "" : ","}${ident(c)}=`)} || quote(old.${ident(c)})`,
    )
    .join(" || ");
  const untouched = columns
    .map((c) => `${lit(` AND ${ident(c)} IS `)} || quote(new.${ident(c)})`)
    .join(" || ");
  const colList = (rowidAlias ? columns : ["rowid", ...columns])
    .map((c) => (c === "rowid" ? c : ident(c)))
    .join(",");
  const rowValues = rowidAlias
    ? values("old")
    : `old.rowid || ',' || ${values("old")}`;
  return [
    {
      name: name("insert"),
      sql: `CREATE TRIGGER ${ident(name("insert"))} AFTER INSERT ON ${t} BEGIN
  INSERT INTO undo_journal(stmt) VALUES (${lit(`DELETE FROM ${t} WHERE rowid=`)} || new.rowid || ${untouched});
END`,
    },
    {
      name: name("update"),
      sql: `CREATE TRIGGER ${ident(name("update"))} AFTER UPDATE ON ${t} BEGIN
  INSERT INTO undo_journal(stmt) VALUES (${lit(`UPDATE ${t} SET `)} || ${assignments} || ' WHERE rowid=' || new.rowid || ${untouched});
END`,
    },
    {
      name: name("delete"),
      sql: `CREATE TRIGGER ${ident(name("delete"))} AFTER DELETE ON ${t} BEGIN
  INSERT INTO undo_journal(stmt) VALUES (${lit(`INSERT INTO ${t}(${colList}) VALUES(`)} || ${rowValues} || ')');
END`,
    },
  ];
}

/**
 * The statements that bring the journal and its triggers into line with the
 * tables this file has now, or none when they already are.
 *
 * Worked out on every open, after the runtime schema has converged, so a column
 * added by a migration or by ensureRuntimeSchema is journaled from its first
 * write. A trigger whose text already matches is left alone, so an unchanged
 * schema costs a few reads and no write. Only reads here: the statements are run
 * together, in one transaction, by the `undo_journal_install` command, so a
 * half-installed set of triggers cannot exist.
 */
export async function journalInstallStatements(db: Pick<Database, "select">): Promise<string[]> {
  const statements: string[] = [];
  const journal = await db.select<Array<{ name: string }>>(`PRAGMA table_info(undo_journal)`);
  if (journal.length === 0) statements.push(JOURNAL_TABLE_SQL);
  const tables = await db.select<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  const existing = new Map(
    (
      await db.select<Array<{ name: string; sql: string }>>(
        `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '${TRIGGER_PREFIX}%'`,
      )
    ).map((r) => [r.name, r.sql]),
  );
  const wanted = new Set<string>();
  for (const { name: table } of tables) {
    if (NOT_JOURNALED.has(table)) continue;
    const info = await db.select<Array<{ name: string; type: string; pk: number }>>(`PRAGMA table_info(${ident(table)})`);
    const keys = info.filter((c) => c.pk > 0);
    const rowidAlias = keys.length === 1 && keys[0].type.toUpperCase() === "INTEGER";
    for (const trigger of journalTriggers(table, info.map((c) => c.name), rowidAlias)) {
      wanted.add(trigger.name);
      if (existing.get(trigger.name) === trigger.sql) continue;
      statements.push(`DROP TRIGGER IF EXISTS ${ident(trigger.name)}`, trigger.sql);
    }
  }
  for (const name of existing.keys()) {
    if (!wanted.has(name)) statements.push(`DROP TRIGGER IF EXISTS ${ident(name)}`);
  }
  return statements;
}
