//! Undo and redo as one transaction each, on a connection of their own.
//!
//! Every change to the lab record writes its own inverse, as SQL, into
//! `undo_journal` through triggers the frontend installs (`src/lib/undoJournal.ts`).
//! An undo entry is a range of that journal: the rows its action wrote. Undo
//! replays the range, newest first, and the replay's own rows are the range
//! that redoes it. Each inverse carries its own precondition, so it matches its
//! row only while that row still holds what the change left there; a statement
//! that matches no row means something outside the range has touched it since,
//! and the whole replay is refused rather than half applied.
//! A replay is many statements, and the frontend's writes go through
//! tauri-plugin-sql's connection POOL, where a BEGIN in one call and a COMMIT in
//! the next can land on different connections. So the two things that must be
//! all-or-nothing run here instead, each inside one `BEGIN IMMEDIATE` on a
//! connection opened for it:
//!
//!  * [`revert`]: replay one range of the journal, newest first, then sweep the
//!    audit rows the replay itself provoked, and report the range the replay
//!    wrote (the entry that reverses it);
//!  * [`execute_batch`]: run a list of statements together, used to install or
//!    refresh the journal's triggers so a half-installed set can never exist.
//!
//! On any failure the transaction is rolled back and nothing has changed. The
//! test harnesses model both commands in `src/test/undoJournalCommands.ts`; change
//! the two together.

use std::path::Path;

use sqlx::error::ErrorKind;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};

/// Open the live database the way a launch does (sqlx's default options: WAL,
/// foreign keys on, a busy timeout), refusing to create a file that is not there.
async fn open(path: &Path) -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false);
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| format!("Could not open the database: {e}"))
}

/// One statement, run without preparing it.
///
/// `sqlx::raw_sql` reads as the natural fit -- every statement here is a
/// statement rather than a query, and none is run twice -- but its `execute`
/// gives the executor the SQL's own lifetime (`E: Executor<'e>, 'q: 'e`), which
/// pins `&mut SqliteConnection` to it. A future holding that borrow across an
/// await then cannot be seen as `Send`, and a Tauri command's future must be:
/// the build fails with "implementation of `Executor` is not general enough".
/// `query` takes the two lifetimes separately (`E: Executor<'c>, 'c: 'e`), and
/// `persistent(false)` keeps `raw_sql`'s behaviour of caching no prepared
/// statement -- a replay's statements are each seen once. Every caller passes a
/// single statement, which is all `query` will run.
fn stmt(sql: &str) -> sqlx::query::Query<'_, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'_>> {
    sqlx::query(sql).persistent(false)
}

/// Take the write lock up front: IMMEDIATE, so a replay that starts by reading
/// the journal cannot be refused the lock halfway through.
async fn begin(conn: &mut SqliteConnection) -> Result<(), String> {
    stmt("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Commit what `work` did if it succeeded, roll all of it back if it failed, and
/// close the connection either way.
async fn finish<T>(mut conn: SqliteConnection, work: Result<T, String>) -> Result<T, String> {
    let result = match work {
        Ok(value) => stmt("COMMIT")
            .execute(&mut conn)
            .await
            .map(|_| value)
            .map_err(|e| e.to_string()),
        Err(err) => {
            let _ = stmt("ROLLBACK").execute(&mut conn).await;
            Err(err)
        }
    };
    let _ = conn.close().await;
    result
}

/// What a replay refuses with when a row it would put back is no longer as the
/// action left it, so restoring the whole row would erase whatever changed it.
pub const CHANGED_SINCE: &str =
    "Cannot undo or redo that step: the records it would put back have changed since. Nothing was changed.";

/// A constraint violation, as against a transient failure or a statement that
/// cannot run at all.
///
/// A unique, foreign-key, not-null or check violation says what the per-row
/// guards say: something has taken this row's place since the action left it.
/// That is terminal, so it is reported as [`CHANGED_SINCE`] and the caller drops
/// the step. A busy or locked database is worth trying again, and a statement
/// that cannot run is worth reading, so neither is dressed up as a refusal.
fn is_constraint(err: &sqlx::Error) -> bool {
    match err {
        sqlx::Error::Database(db) => !matches!(db.kind(), ErrorKind::Other),
        _ => false,
    }
}

/// The rows a replay wrote: `(from, to]` of the journal, the range that reverses it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Replayed {
    pub from: i64,
    pub to: i64,
}

/// Replay the journal rows in `(from, to]`, newest first, so every journaled
/// table is back as it stood at `from`, and return the range of rows the replay
/// itself wrote.
///
/// Both ends are given, never "everything after `from`": a range that ran to the
/// live head would replay every earlier undo's own rows, doubling the journal
/// with each undo in a row, and would swallow whatever landed after the action
/// from outside it, where the per-row guards below cannot fire at all.
///
/// The replay fires the app's own audit triggers (0010 onward) as it goes. Those
/// rows narrate the replay, not an action, and undo has never written them, so
/// every audit row above `audit_events`' AUTOINCREMENT high-water mark from
/// before the replay is swept out. The high-water mark, not `MAX(id)`: after an
/// undo, the rows a redo puts back sit below it. The sweep is journaled too, so
/// a redo restores the undone action's own audit rows exactly.
///
/// Every journal statement must touch EXACTLY ONE row. Each is an inverse of one
/// row's change, guarded by what that change left there, so none touching a row
/// means something outside the range being replayed has changed it since -- the
/// sync timer draining a viewer's request between an Undo and its Redo, say --
/// and restoring the whole row would silently erase that. A constraint violation
/// says the same thing from the other side: a row the action created, deleted by
/// the undo, cannot be put back under a key something else has taken. Both are
/// refused with [`CHANGED_SINCE`], rolled back, nothing changed. Anything else (a
/// busy database, a statement that cannot run) is reported as it is, so the
/// caller keeps the step and the user can try again.
pub async fn revert(path: &Path, from: i64, to: i64) -> Result<Replayed, String> {
    let mut conn = open(path).await?;
    begin(&mut conn).await?;
    let work = replay(&mut conn, from, to).await;
    finish(conn, work).await
}

async fn head(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'undo_journal'), 0)")
        .fetch_one(&mut *conn)
        .await
}

async fn replay(conn: &mut SqliteConnection, from: i64, to: i64) -> Result<Replayed, String> {
    let start = head(conn).await.map_err(|e| e.to_string())?;
    let audit: i64 = sqlx::query_scalar(
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'), 0)",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let statements: Vec<String> = sqlx::query_scalar(
        "SELECT stmt FROM undo_journal WHERE seq > ? AND seq <= ? ORDER BY seq DESC",
    )
    .bind(from)
    .bind(to)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    for statement in &statements {
        let done = match stmt(statement).execute(&mut *conn).await {
            Ok(done) => done,
            Err(err) if is_constraint(&err) => return Err(CHANGED_SINCE.to_string()),
            Err(err) => return Err(err.to_string()),
        };
        if done.rows_affected() != 1 {
            return Err(CHANGED_SINCE.to_string());
        }
    }
    sqlx::query("DELETE FROM audit_events WHERE id > ?")
        .bind(audit)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Replayed { from: start, to: head(conn).await.map_err(|e| e.to_string())? })
}

/// Run `statements` in order as one transaction: all of them, or none.
pub async fn execute_batch(path: &Path, statements: &[String]) -> Result<(), String> {
    let mut conn = open(path).await?;
    begin(&mut conn).await?;
    let mut work = Ok(());
    for statement in statements {
        if let Err(err) = stmt(statement).execute(&mut conn).await {
            work = Err(err.to_string());
            break;
        }
    }
    finish(conn, work).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    /// A scratch directory holding one database file, removed when dropped.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "histometer-undo-journal-test-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn db(&self) -> PathBuf {
            self.0.join("histometer.db")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A small lab: one table journaled the way the frontend journals every
    /// table -- every inverse guarded by what the change left in the row, as
    /// `journalTriggers` writes them -- and an audit trigger like the app's own.
    const SCHEMA: &str = "
        CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT NOT NULL);
        CREATE TABLE undo_journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, stmt TEXT NOT NULL);
        CREATE TABLE samples (id INTEGER PRIMARY KEY, note TEXT NOT NULL DEFAULT '');
        CREATE TABLE racks (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE);
        CREATE TRIGGER undo_journal_racks_insert AFTER INSERT ON racks BEGIN
          INSERT INTO undo_journal(stmt) VALUES ('DELETE FROM racks WHERE rowid=' || new.rowid || ' AND id IS ' || quote(new.id) || ' AND code IS ' || quote(new.code));
        END;
        CREATE TRIGGER undo_journal_racks_delete AFTER DELETE ON racks BEGIN
          INSERT INTO undo_journal(stmt) VALUES ('INSERT INTO racks(id,code) VALUES(' || quote(old.id) || ',' || quote(old.code) || ')');
        END;
        CREATE TRIGGER audit_samples AFTER UPDATE ON samples BEGIN
          INSERT INTO audit_events(summary) VALUES ('sample ' || new.id || ' now ' || new.note);
        END;
        CREATE TRIGGER undo_journal_samples_insert AFTER INSERT ON samples BEGIN
          INSERT INTO undo_journal(stmt) VALUES ('DELETE FROM samples WHERE rowid=' || new.rowid || ' AND id IS ' || quote(new.id) || ' AND note IS ' || quote(new.note));
        END;
        CREATE TRIGGER undo_journal_samples_update AFTER UPDATE ON samples BEGIN
          INSERT INTO undo_journal(stmt) VALUES ('UPDATE samples SET id=' || quote(old.id) || ',note=' || quote(old.note) || ' WHERE rowid=' || new.rowid || ' AND id IS ' || quote(new.id) || ' AND note IS ' || quote(new.note));
        END;
        CREATE TRIGGER undo_journal_samples_delete AFTER DELETE ON samples BEGIN
          INSERT INTO undo_journal(stmt) VALUES ('INSERT INTO samples(id,note) VALUES(' || quote(old.id) || ',' || quote(old.note) || ')');
        END;
        CREATE TRIGGER undo_journal_audit_events_insert AFTER INSERT ON audit_events BEGIN
          INSERT INTO undo_journal(stmt) VALUES ('DELETE FROM audit_events WHERE rowid=' || new.rowid || ' AND id IS ' || quote(new.id) || ' AND summary IS ' || quote(new.summary));
        END;
        CREATE TRIGGER undo_journal_audit_events_delete AFTER DELETE ON audit_events BEGIN
          INSERT INTO undo_journal(stmt) VALUES ('INSERT INTO audit_events(id,summary) VALUES(' || quote(old.id) || ',' || quote(old.summary) || ')');
        END;
    ";

    async fn lab(scratch: &Scratch) -> SqliteConnection {
        let options = SqliteConnectOptions::new()
            .filename(scratch.db())
            .create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::raw_sql(SCHEMA).execute(&mut conn).await.unwrap();
        conn
    }

    async fn run(conn: &mut SqliteConnection, sql: &str) {
        sqlx::raw_sql(sql).execute(&mut *conn).await.unwrap();
    }

    async fn head(conn: &mut SqliteConnection) -> i64 {
        super::head(conn).await.unwrap()
    }

    async fn rows(conn: &mut SqliteConnection, sql: &str) -> Vec<String> {
        sqlx::query_scalar(sql).fetch_all(&mut *conn).await.unwrap()
    }

    const SAMPLES: &str = "SELECT id || ':' || note FROM samples ORDER BY id";
    const AUDIT: &str = "SELECT id || ':' || summary FROM audit_events ORDER BY id";
    const RACKS: &str = "SELECT id || ':' || code FROM racks ORDER BY id";

    #[test]
    fn a_replay_puts_every_row_back_and_a_second_replay_redoes_it() {
        block_on(async {
            let scratch = Scratch::new();
            let mut conn = lab(&scratch).await;
            run(&mut conn, "INSERT INTO samples(id, note) VALUES (1, 'a'), (2, 'b')").await;
            let mark = head(&mut conn).await;
            let (samples, audit) = (rows(&mut conn, SAMPLES).await, rows(&mut conn, AUDIT).await);

            run(&mut conn, "UPDATE samples SET note = 'c' WHERE id = 1; DELETE FROM samples WHERE id = 2; INSERT INTO samples(id, note) VALUES (3, 'd')").await;
            let (after_samples, after_audit) = (rows(&mut conn, SAMPLES).await, rows(&mut conn, AUDIT).await);

            let end = head(&mut conn).await;
            let redo = revert(&scratch.db(), mark, end).await.expect("the undo replays");
            assert_eq!(rows(&mut conn, SAMPLES).await, samples);
            assert_eq!(rows(&mut conn, AUDIT).await, audit, "the replay's own audit rows are swept");

            revert(&scratch.db(), redo.from, redo.to).await.expect("the redo replays");
            assert_eq!(rows(&mut conn, SAMPLES).await, after_samples);
            assert_eq!(rows(&mut conn, AUDIT).await, after_audit, "the undone action's audit rows come back");
        });
    }

    #[test]
    fn undoing_every_action_in_a_row_then_redoing_them_grows_the_journal_linearly() {
        block_on(async {
            let scratch = Scratch::new();
            let mut conn = lab(&scratch).await;
            run(&mut conn, "INSERT INTO samples(id, note) VALUES (1, 'n0')").await;
            let start = rows(&mut conn, SAMPLES).await;
            // Twelve actions, each an undo entry: the journal's head either side of
            // it, closed as it is recorded (the undo stack's bookkeeping, src/lib/undo.ts).
            let mut entries: Vec<(i64, i64)> = Vec::new();
            for n in 1..=12 {
                let mark = head(&mut conn).await;
                run(&mut conn, &format!("UPDATE samples SET note = 'n{n}' WHERE id = 1")).await;
                entries.push((mark, head(&mut conn).await));
            }
            let end = rows(&mut conn, SAMPLES).await;
            let written = head(&mut conn).await;

            // Each action wrote 3 rows (its change, its audit row, that row's
            // inverse). Each undo and each redo replays one action's worth, so every
            // replay adds a few rows, not a doubling. Checked after every replay, so
            // a doubling journal fails in a handful of steps.
            let mut replays = 0;
            let mut redos = Vec::new();
            while let Some((from, to)) = entries.pop() {
                redos.push(revert(&scratch.db(), from, to).await.expect("an undo replays"));
                replays += 1;
                let grown = head(&mut conn).await - written;
                assert!(grown <= replays * 3 * 4, "{replays} replays grew the journal by {grown} rows");
            }
            assert_eq!(rows(&mut conn, SAMPLES).await, start, "every action is undone");
            while let Some(r) = redos.pop() {
                revert(&scratch.db(), r.from, r.to).await.expect("a redo replays");
                replays += 1;
                let grown = head(&mut conn).await - written;
                assert!(grown <= replays * 3 * 4, "{replays} replays grew the journal by {grown} rows");
            }
            assert_eq!(rows(&mut conn, SAMPLES).await, end, "every action is redone");
        });
    }

    #[test]
    fn a_replay_that_fails_part_way_changes_nothing() {
        block_on(async {
            let scratch = Scratch::new();
            let mut conn = lab(&scratch).await;
            run(&mut conn, "INSERT INTO samples(id, note) VALUES (1, 'a')").await;
            let mark = head(&mut conn).await;
            run(&mut conn, "UPDATE samples SET note = 'b' WHERE id = 1").await;
            // The OLDEST row after the mark cannot run, so the replay, newest first,
            // applies the rows after it and only then meets it.
            run(&mut conn, &format!("UPDATE undo_journal SET stmt = 'UPDATE no_such_table SET x = 1' WHERE seq = {}", mark + 1)).await;
            assert!(head(&mut conn).await > mark + 1, "a good row is replayed before the bad one");
            let (samples, audit, journal) = (
                rows(&mut conn, SAMPLES).await,
                rows(&mut conn, AUDIT).await,
                rows(&mut conn, "SELECT stmt FROM undo_journal ORDER BY seq").await,
            );

            let end = head(&mut conn).await;
            let err = revert(&scratch.db(), mark, end).await.expect_err("the replay is refused");
            assert!(err.contains("no_such_table"), "{err}");
            assert_eq!(rows(&mut conn, SAMPLES).await, samples, "no row was reverted");
            assert_eq!(rows(&mut conn, AUDIT).await, audit, "no audit row was swept");
            assert_eq!(rows(&mut conn, "SELECT stmt FROM undo_journal ORDER BY seq").await, journal);
        });
    }

    /// The sync timer drains a viewer's request between an Undo and the Redo of it,
    /// touching a row the action touched. The redo would restore that whole row,
    /// erasing the drain's change to it while the rest of the drain's work stayed.
    #[test]
    fn a_replay_is_refused_when_a_row_it_would_put_back_changed_since() {
        block_on(async {
            let scratch = Scratch::new();
            let mut conn = lab(&scratch).await;
            run(&mut conn, "INSERT INTO samples(id, note) VALUES (1, 'a')").await;
            let mark = head(&mut conn).await;
            run(&mut conn, "UPDATE samples SET note = 'b' WHERE id = 1").await;

            let end = head(&mut conn).await;
            let redo = revert(&scratch.db(), mark, end).await.expect("the undo replays");
            assert_eq!(rows(&mut conn, SAMPLES).await, vec!["1:a"]);

            // The drain, outside the range the redo would replay.
            run(&mut conn, "UPDATE samples SET note = 'drained' WHERE id = 1").await;
            let (samples, audit, journal) = (
                rows(&mut conn, SAMPLES).await,
                rows(&mut conn, AUDIT).await,
                rows(&mut conn, "SELECT stmt FROM undo_journal ORDER BY seq").await,
            );

            let err = revert(&scratch.db(), redo.from, redo.to)
                .await
                .expect_err("the redo is refused");
            assert_eq!(err, CHANGED_SINCE);
            assert_eq!(rows(&mut conn, SAMPLES).await, samples, "the drain's write is untouched");
            assert_eq!(rows(&mut conn, AUDIT).await, audit);
            assert_eq!(rows(&mut conn, "SELECT stmt FROM undo_journal ORDER BY seq").await, journal);
        });
    }

    /// A row the action created was deleted by the undo, and something outside the
    /// stack has since taken its key. Putting it back is impossible, not merely
    /// awkward, so the redo is refused the way a guard mismatch is.
    #[test]
    fn a_replay_a_constraint_stops_is_refused_like_a_guard_mismatch() {
        block_on(async {
            let scratch = Scratch::new();
            let mut conn = lab(&scratch).await;
            let mark = head(&mut conn).await;
            run(&mut conn, "INSERT INTO racks(id, code) VALUES (1, 'R1')").await;
            let end = head(&mut conn).await;

            let redo = revert(&scratch.db(), mark, end).await.expect("the undo replays");
            assert!(rows(&mut conn, RACKS).await.is_empty(), "the rack is gone");

            // Somebody outside the stack takes the code the rack had.
            run(&mut conn, "INSERT INTO racks(id, code) VALUES (2, 'R1')").await;
            let racks = rows(&mut conn, RACKS).await;

            let err = revert(&scratch.db(), redo.from, redo.to)
                .await
                .expect_err("the redo is refused");
            assert_eq!(err, CHANGED_SINCE);
            assert_eq!(rows(&mut conn, RACKS).await, racks, "and nothing was changed");
        });
    }

    #[test]
    fn a_batch_that_fails_part_way_changes_nothing() {
        block_on(async {
            let scratch = Scratch::new();
            let mut conn = lab(&scratch).await;
            let err = execute_batch(
                &scratch.db(),
                &[
                    "CREATE TABLE installed (x INTEGER)".to_string(),
                    "CREATE TRIGGER broken AFTER INSERT ON no_such_table BEGIN SELECT 1; END".to_string(),
                ],
            )
            .await
            .expect_err("the batch is refused");
            assert!(err.contains("no_such_table"), "{err}");
            let tables = rows(&mut conn, "SELECT name FROM sqlite_master WHERE name = 'installed'").await;
            assert!(tables.is_empty(), "the first statement was rolled back with the rest");

            execute_batch(&scratch.db(), &["CREATE TABLE installed (x INTEGER)".to_string()])
                .await
                .expect("a good batch runs");
            let tables = rows(&mut conn, "SELECT name FROM sqlite_master WHERE name = 'installed'").await;
            assert_eq!(tables, vec!["installed"]);
        });
    }

    #[test]
    fn a_missing_database_is_refused_not_created() {
        block_on(async {
            let scratch = Scratch::new();
            let err = revert(&scratch.db(), 0, 0).await.expect_err("nothing to open");
            assert!(err.starts_with("Could not open the database"), "{err}");
            assert!(!scratch.db().exists(), "no empty database was created");
        });
    }
}
