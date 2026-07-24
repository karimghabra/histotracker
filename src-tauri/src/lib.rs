use tauri_plugin_sql::{Migration, MigrationKind};

mod sync;

/// Write raw bytes to an absolute path chosen by the user via the save dialog.
/// Used for CSV / XLSX export; keeps file I/O out of the scoped fs plugin.
#[tauri::command]
fn save_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &contents).map_err(|e| e.to_string())
}

/// Read raw bytes from an absolute path. Used by the workstation to read the
/// live SQLite file for publishing, and by the viewer when swapping in a
/// downloaded snapshot. The path is discovered at runtime via
/// `PRAGMA database_list`, so we never hardcode the plugin's storage dir.
#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_projects_and_samples",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "pickup_and_depth",
            sql: include_str!("../migrations/0002_pickup_and_depth.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "section_requests",
            sql: include_str!("../migrations/0003_section_requests.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "batches_slides_and_checklists",
            sql: include_str!("../migrations/0004_batches_slides_and_checklists.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "paired_slide_assays",
            sql: include_str!("../migrations/0005_slide_assays.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "assay_workflow_and_ready_for_imaging",
            sql: include_str!("../migrations/0006_assay_workflow.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "explicit_slide_assignment_save",
            sql: include_str!("../migrations/0007_explicit_slide_assignment_save.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "sample_priority",
            sql: include_str!("../migrations/0008_sample_priority.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "slide_drying",
            sql: include_str!("../migrations/0009_slide_drying.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "users_and_audit",
            sql: include_str!("../migrations/0010_users_and_audit.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "complete_audit_coverage",
            sql: include_str!("../migrations/0011_complete_audit_coverage.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "depth_ordinals_and_sample_timeline",
            sql: include_str!("../migrations/0012_depth_ordinals_and_sample_timeline.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "depth_duplicate_ordinals",
            sql: include_str!("../migrations/0013_depth_duplicate_ordinals.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "stain_requests",
            sql: include_str!("../migrations/0014_stain_requests.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "slide_stacks",
            sql: include_str!("../migrations/0015_slide_stacks.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "stage_local_depth_stacks",
            sql: include_str!("../migrations/0016_stage_local_depth_stacks.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "planned_processing_runs",
            sql: include_str!("../migrations/0017_planned_processing_runs.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:histometer.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            save_file,
            read_file,
            sync::sync_config_get,
            sync::sync_config_set,
            sync::sync_set_last_version,
            sync::github_get_file,
            sync::github_put_file,
            sync::github_delete_file,
            sync::github_list_dir,
            sync::github_upload_release_asset,
            sync::github_download_release_asset,
            sync::github_validate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
