//! Bringing a database image up to this build's schema before it goes live.
//!
//! tauri-plugin-sql runs the numbered migrations (`crate::migrations`) on the
//! first open of each launch, and sqlx records every one it applies inside the
//! file, in `_sqlx_migrations`. A backup revert and a sync pull swap a whole
//! image in AFTER that, mid-session, so an image older than the newest migration
//! arrives with a record that lacks it. `getDb()` adds the missing columns, which
//! keeps the session working, but the record still says the migration never ran:
//! the next launch runs it again on top of those columns, fails on "duplicate
//! column name", and the app cannot open its database.
//!
//! `db_migrate_image` gives the image what a launch would give it: the same
//! migrations through the same sqlx migrator, on a staging copy. The migrations
//! the image lacks really run, backfills included, and the record they leave is
//! sqlx's own, so it says exactly what the file holds. An image that cannot be
//! brought up to date is refused, and the live database is never touched:
//!
//!  * it is not a SQLite file;
//!  * the migrator cannot read it at all, e.g. "database disk image is malformed";
//!  * it was made by a NEWER build (it records a migration this one does not
//!    have), which this build's own launch would refuse;
//!  * its record does not match this build's migrations, or says one was only
//!    partly applied;
//!  * a migration fails on it, e.g. on a column its record does not account for.
//!
//! The staging copy is a whole copy of the lab's database, so it is written
//! inside the app's own data directory (`migrating/`, next to `backups/`,
//! resolved the way `backup.rs` resolves its own) rather than in the machine's
//! shared temp directory. `Staging`'s `Drop` removes it on both the normal and
//! the error path; a process killed before that runs leaves one behind, and the
//! next run sweeps it.
//!
//! Every refusal reason is worded to follow a caller's lead-in, "This backup
//! cannot be restored: " or "The workstation's latest snapshot cannot be opened
//! here: ", and each caller adds its own what-to-do. The test harnesses model
//! this command in `src/test/sqlx-migrator.ts` (`migrateImage`), word for word;
//! change the two together.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::error::BoxDynError;
use sqlx::migrate::{MigrateError, Migration as SqlxMigration, MigrationSource, Migrator};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tauri_plugin_sql::{Migration, MigrationKind};

const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// Where staging copies live, under the app's own data directory, alongside
/// `backups/` and resolved the same way. A database image never lands in a
/// directory the app shares with the rest of the machine.
const STAGING_DIR: &str = "migrating";

/// The start of every staging copy's name, so one left behind by a process that
/// was killed before `Staging`'s `Drop` could run is recognisable as ours.
const STAGING_STEM: &str = "histometer-migrate";

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

/// Why an image cannot be brought up to date, as the webview receives it.
/// `newer` marks the one refusal that updating Histometer on this computer
/// cures: the image was made by a newer version.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Refusal {
    reason: String,
    newer: bool,
}

impl Refusal {
    fn because(reason: impl Into<String>) -> Self {
        Refusal {
            reason: reason.into(),
            newer: false,
        }
    }
}

/// The image, brought up to this build's migrations, or why it cannot be.
#[tauri::command]
pub async fn db_migrate_image(app: tauri::AppHandle, bytes: Vec<u8>) -> Result<Vec<u8>, Refusal> {
    let dir = staging_dir(&app).map_err(|e| {
        Refusal::because(format!("it could not be copied aside to be checked ({e})"))
    })?;
    migrate_image(&bytes, crate::migrations(), &dir).await
}

/// The staging directory, created if missing, under the app's own data dir.
fn staging_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::backup::app_dir(app)?.join(STAGING_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
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
        Staging(dir.join(format!("{}.db", unique_name(STAGING_STEM))))
    }
}

/// Remove staging copies an interrupted run left behind, the way `backup_list`
/// sweeps a crashed write's `.tmp` files. A name carries the process that wrote
/// it, so a run sweeps neither its own copy nor one a sibling run in this
/// process is still using; whatever else is in the directory is left alone.
fn sweep(dir: &Path) {
    let mine = format!("{STAGING_STEM}-{}-", std::process::id());
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with(STAGING_STEM) && !name.starts_with(&mine) {
            let _ = std::fs::remove_file(&path);
        }
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

fn refusal(err: MigrateError) -> Refusal {
    let reason = match err {
        MigrateError::VersionMissing(v) => {
            return Refusal {
                reason: format!(
                    "it was made by a newer version of Histometer (it has database migration {v}, \
                     which this version does not have)"
                ),
                newer: true,
            }
        }
        MigrateError::VersionMismatch(v) => {
            format!("its database migration {v} is not the one this version of Histometer has")
        }
        MigrateError::Dirty(v) => format!("database migration {v} was only partly applied to it"),
        MigrateError::ExecuteMigration(e, v) => format!(
            "bringing it up to date failed at database migration {v} ({})",
            sqlite_message(&e)
        ),
        MigrateError::Execute(e) => format!("it could not be read ({})", sqlite_message(&e)),
        other => other.to_string(),
    };
    Refusal::because(reason)
}

/// Stage `bytes` in `dir`, run `migrations` on the copy the way the plugin runs
/// them at launch (sqlx's default connect options), and read it back.
async fn migrate_image(
    bytes: &[u8],
    migrations: Vec<Migration>,
    dir: &Path,
) -> Result<Vec<u8>, Refusal> {
    if bytes.len() < 100 || &bytes[..16] != SQLITE_MAGIC {
        return Err(Refusal::because("it is not a database file"));
    }
    let migrator = Migrator::new(Registered(migrations))
        .await
        .map_err(refusal)?;
    sweep(dir);
    let staging = Staging::new(dir);
    std::fs::write(&staging.0, bytes).map_err(|e| {
        Refusal::because(format!("it could not be copied aside to be checked ({e})"))
    })?;
    let options = SqliteConnectOptions::new().filename(&staging.0);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| Refusal::because(format!("it could not be opened ({})", sqlite_message(&e))))?;
    // As tauri-plugin-sql runs it: `Migrator::run` on a pool.
    let migrated = migrator.run(&pool).await;
    // Every connection closed, so the file is whole before it is read back.
    pool.close().await;
    migrated.map_err(refusal)?;
    std::fs::read(&staging.0).map_err(|e| {
        Refusal::because(format!("it could not be read back after checking ({e})"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePool;

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

    /// What is in `dir`, by name, sorted.
    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// The command, checking it cleans up after itself.
    async fn migrate(bytes: &[u8]) -> Result<Vec<u8>, Refusal> {
        let dir = Scratch::new();
        let out = migrate_image(bytes, crate::migrations(), &dir.0).await;
        assert_eq!(
            entries(&dir.0),
            Vec::<String>::new(),
            "the staging copy was left behind"
        );
        out
    }

    /// A staging copy as a process killed mid-run leaves it: the file, and the
    /// journal beside it, named for the process that wrote them.
    fn leftover(dir: &Path, pid: u32) -> (PathBuf, PathBuf) {
        let file = dir.join(format!("{STAGING_STEM}-{pid}-1-0.db"));
        let journal = dir.join(format!("{STAGING_STEM}-{pid}-1-0.db-wal"));
        std::fs::write(&file, b"SQLite format 3\0 and the rest of a lab database").unwrap();
        std::fs::write(&journal, b"a journal").unwrap();
        (file, journal)
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
                Refusal::because(
                    "bringing it up to date failed at database migration 23 (duplicate column name: slides_issued)"
                )
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
                Refusal {
                    reason: format!(
                        "it was made by a newer version of Histometer (it has database migration {future}, \
                         which this version does not have)"
                    ),
                    newer: true,
                }
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
                Refusal::because("database migration 7 was only partly applied to it")
            );
        });
    }

    #[test]
    fn bytes_that_are_not_a_database_are_refused() {
        block_on(async {
            assert_eq!(
                migrate(b"not a database").await.unwrap_err(),
                Refusal::because("it is not a database file")
            );
            assert_eq!(
                migrate(&[0u8; 4096]).await.unwrap_err(),
                Refusal::because("it is not a database file")
            );
        });
    }

    #[test]
    fn no_staging_copy_outlives_the_run_that_made_it() {
        block_on(async {
            let dir = Scratch::new();
            migrate_image(&image_at(22).await, crate::migrations(), &dir.0)
                .await
                .expect("an older image is brought up to date");
            assert_eq!(entries(&dir.0), Vec::<String>::new());
            // And when an image is refused only after it has been staged and
            // opened: this one fails at migration 23, so the copy exists and the
            // refusal unwinds through its `Drop`.
            let converged = edited(
                &image_at(22).await,
                "ALTER TABLE samples ADD COLUMN slides_issued INTEGER NOT NULL DEFAULT 0;",
            )
            .await;
            migrate_image(&converged, crate::migrations(), &dir.0)
                .await
                .unwrap_err();
            assert_eq!(entries(&dir.0), Vec::<String>::new());
        });
    }

    /// A process killed between the write and the `Drop` cannot be staged in a
    /// unit test, so this plants what such a kill leaves behind: the files, with
    /// another process's id in their names.
    #[test]
    fn a_staging_copy_an_interrupted_run_left_behind_is_swept() {
        block_on(async {
            let dir = Scratch::new();
            let (stale, stale_journal) = leftover(&dir.0, std::process::id() + 1);
            // A sibling run in this process is still using its own copy.
            let (sibling, sibling_journal) = leftover(&dir.0, std::process::id());
            let theirs = dir.0.join("histometer-backup-20260101-000000-scheduled.db");
            std::fs::write(&theirs, b"not ours to remove").unwrap();

            let current = image_at(newest()).await;
            assert_eq!(
                migrate_image(&current, crate::migrations(), &dir.0)
                    .await
                    .unwrap(),
                current
            );

            assert!(!stale.exists(), "the leftover copy was not swept");
            assert!(!stale_journal.exists(), "its journal was not swept");
            assert!(sibling.exists(), "a sibling run's copy was swept");
            assert!(sibling_journal.exists(), "a sibling run's journal was swept");
            assert!(theirs.exists(), "another file was swept");
        });
    }

    #[test]
    fn an_image_the_migrator_cannot_read_is_refused() {
        block_on(async {
            // A sound header over a first page (the schema) that is all noise.
            let mut rotten = image_at(newest()).await;
            let page = match u16::from_be_bytes([rotten[16], rotten[17]]) {
                1 => 65536,
                size => usize::from(size),
            };
            rotten[100..page].fill(0xa5);
            let err = migrate(&rotten).await.unwrap_err();
            assert!(err.reason.starts_with("it could not be "), "{err:?}");
            assert!(!err.newer);
        });
    }
}
