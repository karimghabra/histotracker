//! Robust on-disk database backups: the Tauri commands.
//!
//! A backup is the same whole-file SQLite image the undo/redo and sync paths
//! already use ({@link crate}'s `read_file`/`save_file`), but written to a
//! dedicated `backups/` directory under the app data dir, named by timestamp,
//! and never rotated away by undo. The frontend hands us a WAL-checkpointed
//! image (`snapshotDb()`).
//!
//! This file only resolves the backups directory from the `AppHandle` and calls
//! into `backup_fs`, where the validation, the atomic write, the name guard,
//! listing and pruning live, and where their tests are: they take a directory,
//! so they run without Tauri.

use crate::backup_fs::{self, BackupInfo};
use std::path::PathBuf;
use tauri::Manager;

const BACKUP_DIR: &str = "backups";

/// The app's own data directory, created if missing. Every directory the app
/// writes database images to hangs off this one, so they stay inside the app's
/// own tree rather than in a directory it shares with the rest of the machine.
pub(crate) fn app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn backups_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_dir(app)?.join(BACKUP_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Absolute path of the backups directory (created if missing). Shown in the UI.
#[tauri::command]
pub fn backup_dir_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(backups_dir(&app)?.to_string_lossy().into_owned())
}

/// Persist `bytes` as a backup named `name`. Validated + atomic (see `backup_fs`).
#[tauri::command]
pub fn backup_write(
    app: tauri::AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<BackupInfo, String> {
    backup_fs::write_in(&backups_dir(&app)?, &name, &bytes)
}

/// List existing backups. Skips `.tmp` and foreign files.
#[tauri::command]
pub fn backup_list(app: tauri::AppHandle) -> Result<Vec<BackupInfo>, String> {
    backup_fs::list_in(&backups_dir(&app)?)
}

/// Read a backup's raw bytes (for a revert). Name is validated.
#[tauri::command]
pub fn backup_read(app: tauri::AppHandle, name: String) -> Result<Vec<u8>, String> {
    backup_fs::read_in(&backups_dir(&app)?, &name)
}

/// Delete a single backup by name.
#[tauri::command]
pub fn backup_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    backup_fs::delete_in(&backups_dir(&app)?, &name)
}

/// Keep the newest `keep` backups (by name, which encodes the timestamp) and
/// delete the rest. Returns the names removed.
#[tauri::command]
pub fn backup_prune(app: tauri::AppHandle, keep: usize) -> Result<Vec<String>, String> {
    backup_fs::prune_in(&backups_dir(&app)?, keep)
}
