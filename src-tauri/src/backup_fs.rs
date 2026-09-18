//! The file logic of the database backups (see `backup.rs`), taking a directory
//! instead of an `AppHandle` so it can be tested with nothing but std: no Tauri,
//! no display, no webkit. `backup.rs` resolves the backups directory and calls
//! these; the bodies are the ones that shipped, moved unchanged.
//!
//! A backup is the same whole-file SQLite image the undo/redo and sync paths
//! already use, written to a dedicated `backups/` directory, named by timestamp,
//! and never rotated away by undo. The write is made robust:
//!
//!  * **Validated** - we refuse to persist bytes that are not a real SQLite
//!    image (header magic check), so a bug upstream can never enshrine garbage
//!    as a "backup".
//!  * **Atomic** - bytes are written to a `.tmp` sibling, flushed to disk
//!    (`sync_all`), then `rename`d into place. A crash mid-write leaves either
//!    the old file or the new one, never a truncated backup. Leftover `.tmp`
//!    files are ignored by listing and cleaned up opportunistically.
//!  * **Guarded** - every function that takes a file name rejects path
//!    separators / `..`, so a name can only ever address a file inside the
//!    backups directory.
//!
//! The on-disk directory is the source of truth for "what backups exist"; the
//! frontend derives each backup's time and reason from its file name.
//!
//! The tests at the bottom are proven able to fail by `scripts/backup-mutants.sh`,
//! which plants one defect at a time in this file and requires a test to go red.

use serde::Serialize;
use std::io::Write;
use std::path::Path;

pub(crate) const PREFIX: &str = "histometer-backup-";
pub(crate) const EXT: &str = ".db";
pub(crate) const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

#[derive(Serialize, Clone)]
pub struct BackupInfo {
    /// File name only, e.g. `histometer-backup-20260727-131500-scheduled.db`.
    name: String,
    /// Absolute path (for display / "reveal in folder").
    path: String,
    /// Size on disk, in bytes.
    size: u64,
}

/// A name is safe iff it is exactly a backup file name with no path parts.
pub(crate) fn safe_name(name: &str) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains('\0') {
        return Err("invalid backup name".into());
    }
    if !name.starts_with(PREFIX) || !name.ends_with(EXT) {
        return Err("unexpected backup file name".into());
    }
    Ok(())
}

fn info_for(path: &Path) -> Option<BackupInfo> {
    let name = path.file_name()?.to_str()?.to_string();
    if !name.starts_with(PREFIX) || !name.ends_with(EXT) {
        return None;
    }
    let size = std::fs::metadata(path).ok()?.len();
    Some(BackupInfo {
        name,
        path: path.to_string_lossy().into_owned(),
        size,
    })
}

/// Persist `bytes` as a backup named `name` in `dir`. Validated + atomic (see module doc).
pub fn write_in(dir: &Path, name: &str, bytes: &[u8]) -> Result<BackupInfo, String> {
    safe_name(name)?;
    if bytes.len() < 16 || &bytes[..16] != SQLITE_MAGIC {
        return Err("refusing to write a backup that is not a valid SQLite image".into());
    }
    let final_path = dir.join(name);
    let tmp_path = dir.join(format!("{name}.tmp"));

    {
        let mut f = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        e.to_string()
    })?;

    // Guard against a short write / truncation: the file on disk must match.
    let written = std::fs::metadata(&final_path).map_err(|e| e.to_string())?.len();
    if written != bytes.len() as u64 {
        let _ = std::fs::remove_file(&final_path);
        return Err(format!(
            "backup verification failed: wrote {} of {} bytes",
            written,
            bytes.len()
        ));
    }

    Ok(BackupInfo {
        name: name.to_string(),
        path: final_path.to_string_lossy().into_owned(),
        size: written,
    })
}

/// List existing backups in `dir` (newest names sort last lexicographically, but
/// the frontend re-sorts by parsed timestamp). Skips `.tmp` and foreign files.
pub fn list_in(dir: &Path) -> Result<Vec<BackupInfo>, String> {
    let mut out = vec![];
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // Opportunistically sweep away stale temp files from a crashed write.
        if path.extension().and_then(|e| e.to_str()) == Some("tmp") {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        if let Some(info) = info_for(&path) {
            out.push(info);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Read a backup's raw bytes (for a revert). Name is validated.
pub fn read_in(dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    safe_name(name)?;
    std::fs::read(dir.join(name)).map_err(|e| e.to_string())
}

/// Delete a single backup by name.
pub fn delete_in(dir: &Path, name: &str) -> Result<(), String> {
    safe_name(name)?;
    std::fs::remove_file(dir.join(name)).map_err(|e| e.to_string())
}

/// Keep the newest `keep` backups (by name, which encodes the timestamp) and
/// delete the rest. Returns the names removed.
pub fn prune_in(dir: &Path, keep: usize) -> Result<Vec<String>, String> {
    let mut infos = list_in(dir)?;
    // Newest last by name; keep the tail.
    if infos.len() <= keep {
        return Ok(vec![]);
    }
    let cutoff = infos.len() - keep;
    let doomed: Vec<String> = infos.drain(..cutoff).map(|i| i.name).collect();
    for name in &doomed {
        let _ = std::fs::remove_file(dir.join(name));
    }
    Ok(doomed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// The error `safe_name` gives for a name with path parts, and for one that is not a backup name.
    /// Asserting the wording (not just `is_err`) keeps a name the guard should have stopped from
    /// passing because the filesystem happened to refuse it later.
    const PATH_PARTS: &str = "invalid backup name";
    const NOT_A_BACKUP: &str = "unexpected backup file name";

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    /// A fresh `<root>/backups` directory, with `<root>` standing in for the app data dir.
    /// The root is removed when this is dropped.
    struct Scratch {
        root: PathBuf,
        dir: PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "histometer-backup-fs-test-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&root);
            let dir = root.join("backups");
            std::fs::create_dir_all(&dir).unwrap();
            Scratch { root, dir }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn image(len: usize) -> Vec<u8> {
        let mut bytes = SQLITE_MAGIC.to_vec();
        bytes.extend((0..len).map(|i| (i % 251) as u8));
        bytes
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    fn listed(dir: &Path) -> Vec<String> {
        list_in(dir).unwrap().into_iter().map(|i| i.name).collect()
    }

    const NAME: &str = "histometer-backup-20260914-093000-scheduled.db";

    /// Why a write was refused; a write that succeeds fails the test.
    fn write_refusal(dir: &Path, name: &str) -> String {
        match write_in(dir, name, &image(8)) {
            Err(e) => e,
            Ok(info) => panic!("write accepted {name:?} as {}", info.path),
        }
    }

    fn full(stamp: &str) -> String {
        format!("{PREFIX}{stamp}-scheduled{EXT}")
    }

    #[test]
    fn refuses_bytes_that_are_not_a_sqlite_image_and_writes_nothing() {
        let s = Scratch::new();
        for bytes in [
            b"".to_vec(),
            b"SQLite format 3".to_vec(),
            b"<html>not a database</html>".to_vec(),
        ] {
            assert!(
                write_in(&s.dir, NAME, &bytes).is_err(),
                "accepted {} non-SQLite bytes",
                bytes.len()
            );
        }
        assert_eq!(names(&s.dir), Vec::<String>::new(), "a refused write left files behind");
    }

    #[test]
    fn a_bare_header_is_a_valid_image() {
        // The check is on the 16 magic bytes and nothing after them, so the smallest image passes.
        let s = Scratch::new();
        let info = write_in(&s.dir, NAME, SQLITE_MAGIC).unwrap();
        assert_eq!(info.size, 16);
        assert_eq!(read_in(&s.dir, NAME).unwrap(), SQLITE_MAGIC.to_vec());
    }

    #[test]
    fn no_name_reaches_outside_the_backups_directory() {
        let s = Scratch::new();
        // A name that satisfies the prefix and extension but climbs out through a real subdirectory.
        std::fs::create_dir_all(s.dir.join("histometer-backup-x")).unwrap();
        let outside = s.root.join("victim.db");
        std::fs::write(&outside, image(8)).unwrap();
        for (name, wanted) in [
            ("histometer-backup-x/../../victim.db", PATH_PARTS),
            ("histometer-backup-x\\..\\..\\victim.db", PATH_PARTS),
            // Inside backups/, but in a subdirectory list_in never shows: a backup nobody can find.
            ("histometer-backup-x/histometer-backup-y.db", PATH_PARTS),
            // A backslash alone is a separator on Windows, where the lab runs.
            ("histometer-backup-x\\histometer-backup-y.db", PATH_PARTS),
            ("../histometer-backup-1.db", PATH_PARTS),
            ("histometer-backup-..db", PATH_PARTS),
            ("histometer-backup-1.db\0", PATH_PARTS),
            ("victim.db", NOT_A_BACKUP),
        ] {
            assert_eq!(write_refusal(&s.dir, name), wanted, "write of {name:?}");
            assert_eq!(read_in(&s.dir, name).unwrap_err(), wanted, "read of {name:?}");
            assert_eq!(delete_in(&s.dir, name).unwrap_err(), wanted, "delete of {name:?}");
        }
        assert_eq!(std::fs::read(&outside).unwrap(), image(8), "a file outside backups/ was changed");
        assert_eq!(names(&s.dir), vec!["histometer-backup-x".to_string()], "a refused name left a file");
    }

    #[test]
    fn only_names_with_the_backup_prefix_and_extension_are_accepted() {
        let s = Scratch::new();
        for name in [
            "backup.db",
            "histometer-backup-20260914-093000-scheduled",
            "histometer-backup-20260914-093000-scheduled.txt",
            "xhistometer-backup-1.db",
            "",
        ] {
            assert_eq!(write_refusal(&s.dir, name), NOT_A_BACKUP, "write of {name:?}");
            assert_eq!(read_in(&s.dir, name).unwrap_err(), NOT_A_BACKUP, "read of {name:?}");
            assert_eq!(delete_in(&s.dir, name).unwrap_err(), NOT_A_BACKUP, "delete of {name:?}");
        }
        assert_eq!(names(&s.dir), Vec::<String>::new());
    }

    #[test]
    fn a_write_lands_whole_under_its_own_name_with_no_temp_file_left() {
        let s = Scratch::new();
        let bytes = image(64_000);
        let info = write_in(&s.dir, NAME, &bytes).unwrap();
        assert_eq!(info.name, NAME);
        assert_eq!(info.size, bytes.len() as u64);
        assert_eq!(info.path, s.dir.join(NAME).to_string_lossy());
        assert_eq!(std::fs::read(s.dir.join(NAME)).unwrap(), bytes, "the file on disk differs from the image");
        assert_eq!(names(&s.dir), vec![NAME.to_string()], "directory holds more than the backup");
    }

    #[test]
    fn rewriting_a_name_replaces_the_whole_file() {
        let s = Scratch::new();
        write_in(&s.dir, NAME, &image(50_000)).unwrap();
        write_in(&s.dir, NAME, &image(100)).unwrap();
        assert_eq!(read_in(&s.dir, NAME).unwrap(), image(100), "old bytes survived a rewrite");
        assert_eq!(names(&s.dir), vec![NAME.to_string()]);
    }

    #[test]
    fn a_write_into_a_missing_directory_fails_and_creates_nothing() {
        let s = Scratch::new();
        let gone = s.root.join("not-there");
        assert!(write_in(&gone, NAME, &image(8)).is_err());
        assert!(!gone.exists(), "a failed write created its directory");
    }

    #[test]
    fn what_was_written_reads_back_byte_for_byte() {
        let s = Scratch::new();
        let bytes = image(200_000);
        write_in(&s.dir, NAME, &bytes).unwrap();
        assert_eq!(read_in(&s.dir, NAME).unwrap(), bytes);
        assert!(read_in(&s.dir, &full("20000101-000000")).is_err(), "read of a backup that does not exist");
    }

    #[test]
    fn listing_ignores_foreign_files_and_sweeps_stale_temp_files() {
        let s = Scratch::new();
        write_in(&s.dir, NAME, &image(10)).unwrap();
        std::fs::write(s.dir.join("notes.txt"), b"keep me").unwrap();
        std::fs::write(s.dir.join("histometer-backup-elsewhere.txt"), b"keep me too").unwrap();
        std::fs::write(s.dir.join(format!("{NAME}.tmp")), b"half a crashed write").unwrap();
        std::fs::create_dir_all(s.dir.join(full("20260101-000000"))).unwrap();
        assert_eq!(listed(&s.dir), vec![NAME.to_string()]);
        assert_eq!(
            names(&s.dir),
            vec![
                full("20260101-000000"),
                NAME.to_string(),
                "histometer-backup-elsewhere.txt".to_string(),
                "notes.txt".to_string(),
            ],
            "stale .tmp not swept, or a foreign file removed"
        );
    }

    #[test]
    fn listing_is_oldest_first_by_name_and_reports_each_size_and_path() {
        let s = Scratch::new();
        // Written newest first, so directory order cannot stand in for the sort.
        for (stamp, len) in [("20260914-093000", 30), ("20260912-170000", 10), ("20260913-120000", 20)] {
            write_in(&s.dir, &full(stamp), &image(len)).unwrap();
        }
        let infos = list_in(&s.dir).unwrap();
        let got: Vec<(String, u64)> = infos.iter().map(|i| (i.name.clone(), i.size)).collect();
        assert_eq!(
            got,
            vec![
                (full("20260912-170000"), 26),
                (full("20260913-120000"), 36),
                (full("20260914-093000"), 46),
            ]
        );
        for i in &infos {
            assert_eq!(i.path, s.dir.join(&i.name).to_string_lossy());
        }
        assert!(list_in(&s.root.join("not-there")).is_err(), "listing a missing directory succeeded");
    }

    #[test]
    fn deleting_removes_that_backup_and_only_that_one() {
        let s = Scratch::new();
        write_in(&s.dir, &full("20260913-120000"), &image(10)).unwrap();
        write_in(&s.dir, &full("20260914-093000"), &image(10)).unwrap();
        delete_in(&s.dir, &full("20260913-120000")).unwrap();
        assert_eq!(listed(&s.dir), vec![full("20260914-093000")]);
        assert!(delete_in(&s.dir, &full("20260913-120000")).is_err(), "deleting a missing backup succeeded");
    }

    #[test]
    fn pruning_keeps_the_newest_backups_by_their_timestamped_names() {
        let s = Scratch::new();
        // Written out of time order, so creation order cannot stand in for the name.
        let stamps = ["20260912-170000", "20260914-093000", "20260910-080000", "20260913-120000", "20260911-150000"];
        for stamp in stamps {
            write_in(&s.dir, &full(stamp), &image(10)).unwrap();
        }
        let mut removed = prune_in(&s.dir, 2).unwrap();
        removed.sort();
        assert_eq!(removed, vec![full("20260910-080000"), full("20260911-150000"), full("20260912-170000")]);
        assert_eq!(listed(&s.dir), vec![full("20260913-120000"), full("20260914-093000")]);
        assert!(prune_in(&s.dir, 5).unwrap().is_empty(), "pruning below the limit removed something");
    }

    #[test]
    fn pruning_to_exactly_the_count_held_removes_nothing_and_to_zero_removes_all() {
        let s = Scratch::new();
        for stamp in ["20260913-120000", "20260914-093000"] {
            write_in(&s.dir, &full(stamp), &image(10)).unwrap();
        }
        assert!(prune_in(&s.dir, 2).unwrap().is_empty(), "keep == count removed something");
        assert_eq!(listed(&s.dir).len(), 2);
        assert_eq!(prune_in(&s.dir, 0).unwrap().len(), 2);
        assert_eq!(listed(&s.dir), Vec::<String>::new());
    }

    #[test]
    fn pruning_leaves_foreign_files_alone() {
        let s = Scratch::new();
        std::fs::write(s.dir.join("notes.txt"), b"keep me").unwrap();
        write_in(&s.dir, &full("20260913-120000"), &image(10)).unwrap();
        write_in(&s.dir, &full("20260914-093000"), &image(10)).unwrap();
        prune_in(&s.dir, 1).unwrap();
        assert_eq!(names(&s.dir), vec![full("20260914-093000"), "notes.txt".to_string()]);
    }

    /// Compatibility with the release in use: a backups directory as an earlier build left it -
    /// image files written by that build, named by the frontend's `backupFileName` - is listed,
    /// read and pruned by this one, and a backup this build writes is a plain image under the
    /// same kind of name with nothing added to it or beside it, which is all an earlier build reads.
    #[test]
    fn a_backups_directory_from_an_earlier_build_is_read_and_a_new_write_leaves_the_same_shape() {
        let s = Scratch::new();
        // Written straight to disk, not through this module: the bytes and names an earlier build left.
        let earlier = [
            ("histometer-backup-20260727-131500-scheduled.db", 4096),
            ("histometer-backup-20260727-140000-manual.db", 8192),
            ("histometer-backup-20260728-082000-prerestore.db", 4096),
            ("histometer-backup-20260728-090000-startup.db", 12288),
        ];
        for (name, len) in earlier {
            std::fs::write(s.dir.join(name), image(len)).unwrap();
        }
        let infos = list_in(&s.dir).unwrap();
        assert_eq!(
            infos.iter().map(|i| (i.name.as_str(), i.size)).collect::<Vec<_>>(),
            earlier.iter().map(|(n, l)| (*n, (*l + 16) as u64)).collect::<Vec<_>>(),
        );
        assert_eq!(read_in(&s.dir, earlier[1].0).unwrap(), image(8192));

        let mine = "histometer-backup-20260914-093000-scheduled.db";
        write_in(&s.dir, mine, &image(5000)).unwrap();
        assert_eq!(std::fs::read(s.dir.join(mine)).unwrap(), image(5000), "a backup is the bare image, byte for byte");
        assert_eq!(names(&s.dir).len(), earlier.len() + 1, "a write added something besides the backup");

        // Retention drops the oldest of the earlier build's files first.
        assert_eq!(prune_in(&s.dir, 4).unwrap(), vec![earlier[0].0.to_string()]);
    }
}
