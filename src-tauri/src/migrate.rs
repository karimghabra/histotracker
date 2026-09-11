//! Bringing a database image up to this build's schema before it goes live.
//!
//! tauri-plugin-sql runs the numbered migrations (`crate::migrations`) on the
//! first open of each launch, and sqlx records every one it applies inside the
//! file, in `_sqlx_migrations`. A backup revert swaps a whole image in AFTER
//! that, mid-session, so a backup older than the newest migration arrives with a
//! record that lacks it. `getDb()` adds the missing columns, which keeps the
//! session working, but the record still says the migration never ran: the next
//! launch runs it again on top of those columns, fails on "duplicate column
//! name", and the app cannot open its database.
//!
//! `db_migrate_image` gives the image what a launch would give it: the same
//! migrations through the same sqlx migrator, on a staging copy. The migrations
//! the image lacks really run, backfills included, and the record they leave is
//! sqlx's own, so it says exactly what the file holds. An image that cannot be
//! brought up to date is refused, and the live database is never touched:
//!
//!  * it is not a SQLite file, or it is damaged (`PRAGMA quick_check`);
//!  * it has no `_sqlx_migrations` at all, so the app never wrote it;
//!  * it was made by a NEWER build (it records a migration this one does not
//!    have), which this build's own launch would refuse;
//!  * a migration fails on it, e.g. on a column its record does not account for.
//!
//! Every refusal is worded to follow "This backup cannot be restored: ". The
//! test harnesses model this command in `src/test/sqlx-migrator.ts`
//! (`migrateImage`), word for word; change the two together.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::error::BoxDynError;
use sqlx::migrate::{MigrateError, Migration as SqlxMigration, MigrationSource, Migrator};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use tauri_plugin_sql::{Migration, MigrationKind};

const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// The registered migrations exactly as tauri-plugin-sql 2.4.0 hands them to
/// sqlx (its private `MigrationList::resolve`): Up only, in registration order,
/// each in its own transaction. Same versions, same SQL, so the same checksums.
#[derive(Debug)]
struct Registered(Vec<Migration>);

impl MigrationSource<'static> for Registered {
    fn resolve(
        self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<SqlxMigration>, BoxDynError>> + Send>> {
        Box::pin(async move {
            Ok(self
                .0
                .into_iter()
                .filter(|m| matches!(m.kind, MigrationKind::Up))
                .map(|m| {
                    SqlxMigration::new(
                        m.version,
                        m.description.into(),
                        m.kind.into(),
                        m.sql.into(),
                        false,
                    )
                })
                .collect())
        })
    }
}

/// The image, brought up to this build's migrations, or why it cannot be.
#[tauri::command]
pub async fn db_migrate_image(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    migrate_image(&bytes, crate::migrations(), &std::env::temp_dir()).await
}

/// A name no other staging copy has, in this process or another.
fn unique_name(stem: &str) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{stem}-{}-{nanos}-{seq}", std::process::id())
}

/// A staging file in `dir`, removed with its journal files when dropped.
struct Staging(PathBuf);

impl Staging {
    fn new(dir: &Path) -> Self {
        Staging(dir.join(format!("{}.db", unique_name("histometer-migrate"))))
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let mut path = self.0.clone().into_os_string();
            path.push(suffix);
            let _ = std::fs::remove_file(path);
        }
    }
}

/// SQLite's own words for a database error, as the harness model reports them.
fn sqlite_message(err: &sqlx::Error) -> String {
    err.as_database_error()
        .map(|e| e.message().to_string())
        .unwrap_or_else(|| err.to_string())
}

fn refusal(err: MigrateError) -> String {
    match err {
        MigrateError::VersionMissing(v) => format!(
            "it was made by a newer version of Histometer (it has database migration {v}, \
             which this version does not have), so only that version or a later one can restore it"
        ),
        MigrateError::VersionMismatch(v) => {
            format!("its database migration {v} is not the one this version of Histometer has")
        }
        MigrateError::Dirty(v) => format!("database migration {v} was only partly applied to it"),
        MigrateError::ExecuteMigration(e, v) => format!(
            "bringing it up to date failed at database migration {v} ({})",
            sqlite_message(&e)
        ),
        other => other.to_string(),
    }
}

async fn check_and_migrate(pool: &SqlitePool, migrations: Vec<Migration>) -> Result<(), String> {
    let damaged = |e: sqlx::Error| format!("it is damaged ({})", sqlite_message(&e));
    let check: Vec<String> = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_all(pool)
        .await
        .map_err(damaged)?;
    if check.len() != 1 || check[0] != "ok" {
        let first = check
            .first()
            .map(String::as_str)
            .unwrap_or("no result from quick_check");
        return Err(format!("it is damaged ({first})"));
    }
    let ledger: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_one(pool)
    .await
    .map_err(damaged)?;
    if ledger == 0 {
        return Err(
            "it has no record of Histometer's database migrations, so Histometer did not write it"
                .into(),
        );
    }
    let migrator = Migrator::new(Registered(migrations))
        .await
        .map_err(|e| e.to_string())?;
    // As tauri-plugin-sql runs it: `Migrator::run` on a pool.
    migrator.run(pool).await.map_err(refusal)
}

/// Stage `bytes` in `dir`, run `migrations` on the copy the way the plugin runs
/// them at launch (sqlx's default connect options), and read it back.
async fn migrate_image(
    bytes: &[u8],
    migrations: Vec<Migration>,
    dir: &Path,
) -> Result<Vec<u8>, String> {
    if bytes.len() < 100 || &bytes[..16] != SQLITE_MAGIC {
        return Err("it is not a database file".into());
    }
    let staging = Staging::new(dir);
    std::fs::write(&staging.0, bytes)
        .map_err(|e| format!("it could not be copied aside to be checked ({e})"))?;
    let options = SqliteConnectOptions::new().filename(&staging.0);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| format!("it could not be opened ({})", sqlite_message(&e)))?;
    let migrated = check_and_migrate(&pool, migrations).await;
    // Every connection closed, so the file is whole before it is read back.
    pool.close().await;
    migrated?;
    std::fs::read(&staging.0).map_err(|e| format!("it could not be read back after checking ({e})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    /// A directory of its own, removed when dropped.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(unique_name("histometer-migrate-test"));
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn newest() -> i64 {
        crate::migrations().iter().map(|m| m.version).max().unwrap()
    }

    fn all_versions() -> Vec<String> {
        crate::migrations()
            .iter()
            .map(|m| m.version.to_string())
            .collect()
    }

    async fn open(file: &Path) -> SqlitePool {
        let options = SqliteConnectOptions::new()
            .filename(file)
            .create_if_missing(true);
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap()
    }

    async fn run(pool: &SqlitePool, sql: &str) {
        sqlx::raw_sql(sql).execute(pool).await.unwrap();
    }

    /// A database as a build registering migrations 1..=`version` leaves it,
    /// with a project and a sample in it.
    async fn image_at(version: i64) -> Vec<u8> {
        let dir = Scratch::new();
        let file = dir.0.join("image.db");
        let pool = open(&file).await;
        let registered = crate::migrations()
            .into_iter()
            .filter(|m| m.version <= version)
            .collect();
        Migrator::new(Registered(registered))
            .await
            .unwrap()
            .run(&pool)
            .await
            .unwrap();
        run(
            &pool,
            "INSERT INTO projects (code, name, team_lead) VALUES ('EE', 'Enthesis', '');
             INSERT INTO samples (project_id, sample_code, date_added, processing_type)
             VALUES (1, 'EE-0001', '2025-03-01', 'Short');",
        )
        .await;
        pool.close().await;
        std::fs::read(&file).unwrap()
    }

    /// A copy of `bytes` with `sql` run on it.
    async fn edited(bytes: &[u8], sql: &str) -> Vec<u8> {
        let dir = Scratch::new();
        let file = dir.0.join("image.db");
        std::fs::write(&file, bytes).unwrap();
        let pool = open(&file).await;
        run(&pool, sql).await;
        pool.close().await;
        std::fs::read(&file).unwrap()
    }

    /// What the plugin does to the file at launch: every registered migration.
    async fn launch(bytes: &[u8]) -> Result<Vec<u8>, MigrateError> {
        let dir = Scratch::new();
        let file = dir.0.join("histometer.db");
        std::fs::write(&file, bytes).unwrap();
        let pool = open(&file).await;
        let result = Migrator::new(Registered(crate::migrations()))
            .await
            .unwrap()
            .run(&pool)
            .await;
        pool.close().await;
        result.map(|()| std::fs::read(&file).unwrap())
    }

    async fn query(bytes: &[u8], sql: &str) -> Vec<String> {
        let dir = Scratch::new();
        let file = dir.0.join("image.db");
        std::fs::write(&file, bytes).unwrap();
        let pool = open(&file).await;
        let rows = sqlx::query_scalar::<_, String>(sql)
            .fetch_all(&pool)
            .await
            .unwrap();
        pool.close().await;
        rows
    }

    async fn ledger(bytes: &[u8]) -> Vec<String> {
        query(
            bytes,
            "SELECT CAST(version AS TEXT) FROM _sqlx_migrations ORDER BY version",
        )
        .await
    }

    /// The command, checking it cleans up after itself.
    async fn migrate(bytes: &[u8]) -> Result<Vec<u8>, String> {
        let dir = Scratch::new();
        let out = migrate_image(bytes, crate::migrations(), &dir.0).await;
        let left = std::fs::read_dir(&dir.0).unwrap().count();
        assert_eq!(left, 0, "the staging copy was left behind");
        out
    }

    #[test]
    fn an_image_from_before_the_newest_migrations_launches_after_it_is_migrated() {
        block_on(async {
            let migrated = migrate(&image_at(22).await)
                .await
                .expect("an older image is brought up to date");
            assert_eq!(ledger(&migrated).await, all_versions());
            // The launch after the revert, and the one after that, have nothing to do.
            let next = launch(&migrated).await.expect("the next launch opens it");
            let after = launch(&next)
                .await
                .expect("and so does the launch after that");
            assert_eq!(next, migrated);
            assert_eq!(after, migrated);
            assert_eq!(
                query(&after, "SELECT sample_code FROM samples").await,
                vec!["EE-0001"]
            );
        });
    }

    #[test]
    fn the_defect_columns_converged_without_the_record_brick_the_next_launch() {
        block_on(async {
            // What a revert used to leave: the old image plus the columns getDb() adds.
            let converged = edited(
                &image_at(22).await,
                "ALTER TABLE samples ADD COLUMN slides_issued INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE samples ADD COLUMN archived_at TEXT;
                 ALTER TABLE slides ADD COLUMN requested_assay_type TEXT NOT NULL DEFAULT '';
                 ALTER TABLE slides ADD COLUMN requested_assay_name TEXT NOT NULL DEFAULT '';",
            )
            .await;
            let err = launch(&converged)
                .await
                .expect_err("the next launch runs migration 23 again");
            assert!(
                err.to_string()
                    .contains("duplicate column name: slides_issued"),
                "{err}"
            );
            // An image in that state is refused, not patched into something else.
            assert_eq!(
                migrate(&converged).await.unwrap_err(),
                "bringing it up to date failed at database migration 23 (duplicate column name: slides_issued)"
            );
        });
    }

    #[test]
    fn an_up_to_date_image_comes_back_byte_for_byte() {
        block_on(async {
            let current = image_at(newest()).await;
            assert_eq!(migrate(&current).await.unwrap(), current);
        });
    }

    #[test]
    fn an_image_from_a_newer_build_is_refused() {
        block_on(async {
            let future = newest() + 1;
            let newer = edited(
                &image_at(newest()).await,
                &format!(
                    "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
                     VALUES ({future}, 'from the future', TRUE, x'00', 0)"
                ),
            )
            .await;
            assert_eq!(
                migrate(&newer).await.unwrap_err(),
                format!(
                    "it was made by a newer version of Histometer (it has database migration {future}, \
                     which this version does not have), so only that version or a later one can restore it"
                )
            );
        });
    }

    #[test]
    fn a_partly_applied_migration_is_refused() {
        block_on(async {
            let dirty = edited(
                &image_at(newest()).await,
                "UPDATE _sqlx_migrations SET success = FALSE WHERE version = 7",
            )
            .await;
            assert_eq!(
                migrate(&dirty).await.unwrap_err(),
                "database migration 7 was only partly applied to it"
            );
        });
    }

    #[test]
    fn a_database_the_app_did_not_write_is_refused() {
        block_on(async {
            let dir = Scratch::new();
            let file = dir.0.join("foreign.db");
            let pool = open(&file).await;
            run(&pool, "CREATE TABLE notes (body TEXT)").await;
            pool.close().await;
            assert_eq!(
                migrate(&std::fs::read(&file).unwrap()).await.unwrap_err(),
                "it has no record of Histometer's database migrations, so Histometer did not write it"
            );
        });
    }

    #[test]
    fn bytes_that_are_not_a_database_are_refused() {
        block_on(async {
            assert_eq!(
                migrate(b"not a database").await.unwrap_err(),
                "it is not a database file"
            );
            assert_eq!(
                migrate(&[0u8; 4096]).await.unwrap_err(),
                "it is not a database file"
            );
        });
    }

    #[test]
    fn a_damaged_image_is_refused() {
        block_on(async {
            let mut rotten = image_at(newest()).await;
            let (from, to) = (rotten.len() * 3 / 10, rotten.len() * 6 / 10);
            rotten[from..to].fill(0xa5);
            let err = migrate(&rotten).await.unwrap_err();
            assert!(err.starts_with("it is damaged ("), "{err}");

            let mut truncated = image_at(newest()).await;
            truncated.truncate(truncated.len() / 2);
            let err = migrate(&truncated).await.unwrap_err();
            assert!(err.starts_with("it is damaged ("), "{err}");
        });
    }
}
