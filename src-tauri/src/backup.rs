//! Robust on-disk database backups.
//!
//! A backup is the same whole-file SQLite image the undo/redo and sync paths
//! already use ({@link crate}'s `read_file`/`save_file`), but written to a
//! dedicated `backups/` directory under the app data dir, named by timestamp,
//! and never rotated away by undo. The frontend hands us a WAL-checkpointed
//! image (`snapshotDb()`); we make the *write* robust:
//!
//!  * **Validated** — we refuse to persist bytes that are not a real SQLite
//!    image (header magic check), so a bug upstream can never enshrine garbage
//!    as a "backup".
//!  * **Atomic** — bytes are written to a `.tmp` sibling, flushed to disk
//!    (`sync_all`), then `rename`d into place. A crash mid-write leaves either
//!    the old file or the new one, never a truncated backup. Leftover `.tmp`
//!    files are ignored by listing and cleaned up opportunistically.
//!  * **Guarded** — every command that takes a file name rejects path
//!    separators / `..`, so a name can only ever address a file inside the
//!    backups directory.
//!
//! The on-disk directory is the source of truth for "what backups exist"; the
//! frontend derives each backup's time and reason from its file name.

use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

const BACKUP_DIR: &str = "backups";
const PREFIX: &str = "histometer-backup-";
const EXT: &str = ".db";
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

#[derive(Serialize, Clone)]
pub struct BackupInfo {
    /// File name only, e.g. `histometer-backup-20260727-131500-scheduled.db`.
    name: String,
    /// Absolute path (for display / "reveal in folder").
    path: String,
    /// Size on disk, in bytes.
    size: u64,
}

fn backups_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(BACKUP_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A name is safe iff it is exactly a backup file name with no path parts.
fn safe_name(name: &str) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains('\0') {
        return Err("invalid backup name".into());
    }
    if !name.starts_with(PREFIX) || !name.ends_with(EXT) {
        return Err("unexpected backup file name".into());
    }
    Ok(())
}

fn info_for(path: &std::path::Path) -> Option<BackupInfo> {
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

/// Absolute path of the backups directory (created if missing). Shown in the UI.
#[tauri::command]
pub fn backup_dir_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(backups_dir(&app)?.to_string_lossy().into_owned())
}

/// Persist `bytes` as a backup named `name`. Validated + atomic (see module doc).
#[tauri::command]
pub fn backup_write(
    app: tauri::AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<BackupInfo, String> {
    safe_name(&name)?;
    if bytes.len() < 16 || &bytes[..16] != SQLITE_MAGIC {
        return Err("refusing to write a backup that is not a valid SQLite image".into());
    }
    let dir = backups_dir(&app)?;
    let final_path = dir.join(&name);
    let tmp_path = dir.join(format!("{name}.tmp"));

    {
        let mut f = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
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
        name,
        path: final_path.to_string_lossy().into_owned(),
        size: written,
    })
}

/// List existing backups (newest names sort last lexicographically, but the
/// frontend re-sorts by parsed timestamp). Skips `.tmp` and foreign files.
#[tauri::command]
pub fn backup_list(app: tauri::AppHandle) -> Result<Vec<BackupInfo>, String> {
    let dir = backups_dir(&app)?;
    let mut out = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
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
#[tauri::command]
pub fn backup_read(app: tauri::AppHandle, name: String) -> Result<Vec<u8>, String> {
    safe_name(&name)?;
    let path = backups_dir(&app)?.join(&name);
    std::fs::read(&path).map_err(|e| e.to_string())
}

/// Delete a single backup by name.
#[tauri::command]
pub fn backup_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    safe_name(&name)?;
    let path = backups_dir(&app)?.join(&name);
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Keep the newest `keep` backups (by name, which encodes the timestamp) and
/// delete the rest. Returns the names removed.
#[tauri::command]
pub fn backup_prune(app: tauri::AppHandle, keep: usize) -> Result<Vec<String>, String> {
    let mut infos = backup_list(app.clone())?;
    // Newest last by name; keep the tail.
    if infos.len() <= keep {
        return Ok(vec![]);
    }
    let cutoff = infos.len() - keep;
    let doomed: Vec<String> = infos.drain(..cutoff).map(|i| i.name).collect();
    let dir = backups_dir(&app)?;
    for name in &doomed {
        let _ = std::fs::remove_file(dir.join(name));
    }
    Ok(doomed)
}
