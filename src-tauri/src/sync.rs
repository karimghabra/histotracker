//! Shared-data sync backend.
//!
//! Everything here talks to a private GitHub repo purely over the HTTPS REST API
//! (Contents API + Releases API) via `reqwest` — no git binary, no libgit2, no
//! local clone. Both the authoritative "workstation" and read-only "viewer"
//! roles are thin clients over these commands.
//!
//! Security: the sync config (including the API token and this install's
//! operator identity) lives in a SEPARATE local file — never in `histometer.db`
//! — because the whole DB is published as a snapshot. The token is never
//! returned to the frontend after it is set; the frontend only ever sees a
//! redacted `SyncConfigPublic`.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

const CONFIG_FILE: &str = "sync-config.json";
const API_ROOT: &str = "https://api.github.com";
const UPLOADS_ROOT: &str = "https://uploads.github.com";
const USER_AGENT: &str = "Histometer-Sync";
const API_VERSION: &str = "2022-11-28";

// ---- Config (stored outside the snapshotted DB) -----------------------------

#[derive(Serialize, Deserialize, Clone, Default)]
struct SyncConfig {
    #[serde(default)]
    role: String, // "workstation" | "viewer" | ""
    #[serde(default)]
    repo_owner: String,
    #[serde(default)]
    repo_name: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    operator_name: String,
    #[serde(default)]
    operator_initials: String,
    #[serde(default)]
    last_synced_version: String,
}

/// Redacted view returned to the frontend — never carries the token.
#[derive(Serialize, Clone, Default)]
pub struct SyncConfigPublic {
    role: String,
    repo_owner: String,
    repo_name: String,
    operator_name: String,
    operator_initials: String,
    last_synced_version: String,
    configured: bool,
    has_token: bool,
}

#[derive(Deserialize)]
pub struct SyncConfigInput {
    role: String,
    repo_owner: String,
    repo_name: String,
    /// None or empty => keep the existing stored token.
    token: Option<String>,
    operator_name: String,
    operator_initials: String,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(CONFIG_FILE))
}

fn read_config(app: &tauri::AppHandle) -> SyncConfig {
    match config_path(app).ok().and_then(|p| std::fs::read(p).ok()) {
        Some(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        None => SyncConfig::default(),
    }
}

fn write_config(app: &tauri::AppHandle, cfg: &SyncConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_config_get(app: tauri::AppHandle) -> SyncConfigPublic {
    let c = read_config(&app);
    SyncConfigPublic {
        configured: !c.role.is_empty() && !c.repo_owner.is_empty() && !c.repo_name.is_empty(),
        has_token: !c.token.is_empty(),
        role: c.role,
        repo_owner: c.repo_owner,
        repo_name: c.repo_name,
        operator_name: c.operator_name,
        operator_initials: c.operator_initials,
        last_synced_version: c.last_synced_version,
    }
}

#[tauri::command]
pub fn sync_config_set(app: tauri::AppHandle, input: SyncConfigInput) -> Result<(), String> {
    let mut cfg = read_config(&app);
    cfg.role = input.role;
    cfg.repo_owner = input.repo_owner.trim().to_string();
    cfg.repo_name = input.repo_name.trim().to_string();
    cfg.operator_name = input.operator_name;
    cfg.operator_initials = input.operator_initials;
    if let Some(t) = input.token {
        if !t.trim().is_empty() {
            cfg.token = t.trim().to_string();
        }
    }
    write_config(&app, &cfg)
}

#[tauri::command]
pub fn sync_set_last_version(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let mut cfg = read_config(&app);
    cfg.last_synced_version = version;
    write_config(&app, &cfg)
}

// ---- GitHub REST helpers ----------------------------------------------------

struct RepoAuth {
    owner: String,
    name: String,
    token: String,
}

fn repo_auth(app: &tauri::AppHandle) -> Result<RepoAuth, String> {
    let c = read_config(app);
    if c.repo_owner.is_empty() || c.repo_name.is_empty() {
        return Err("Sync is not configured: missing repository.".into());
    }
    if c.token.is_empty() {
        return Err("Sync is not configured: missing access token.".into());
    }
    Ok(RepoAuth {
        owner: c.repo_owner,
        name: c.repo_name,
        token: c.token,
    })
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// Standard GitHub JSON API headers.
fn json_headers(rb: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    rb.header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .bearer_auth(token)
}

// ---- Contents API commands --------------------------------------------------

#[derive(Serialize)]
pub struct FileContent {
    content: String,
    sha: String,
}

/// GET a text file from the repo. Returns None on 404.
#[tauri::command]
pub async fn github_get_file(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<FileContent>, String> {
    let a = repo_auth(&app)?;
    let url = format!("{API_ROOT}/repos/{}/{}/contents/{}", a.owner, a.name, path);
    let resp = json_headers(client().get(&url), &a.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub GET {path} -> {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let b64 = json["content"].as_str().unwrap_or("").replace(['\n', '\r'], "");
    let sha = json["sha"].as_str().unwrap_or("").to_string();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())?;
    let content = String::from_utf8(decoded).map_err(|e| e.to_string())?;
    Ok(Some(FileContent { content, sha }))
}

/// Create or update a text file. Pass the current `sha` to update; omit to create.
/// Returns the new blob sha.
#[tauri::command]
pub async fn github_put_file(
    app: tauri::AppHandle,
    path: String,
    content: String,
    sha: Option<String>,
    message: String,
) -> Result<String, String> {
    let a = repo_auth(&app)?;
    let url = format!("{API_ROOT}/repos/{}/{}/contents/{}", a.owner, a.name, path);
    let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
    let mut body = serde_json::json!({ "message": message, "content": b64 });
    if let Some(s) = sha {
        if !s.is_empty() {
            body["sha"] = serde_json::Value::String(s);
        }
    }
    let resp = json_headers(client().put(&url), &a.token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let st = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub PUT {path} -> {st} {txt}"));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json["content"]["sha"].as_str().unwrap_or("").to_string())
}

/// Delete a file by path + sha.
#[tauri::command]
pub async fn github_delete_file(
    app: tauri::AppHandle,
    path: String,
    sha: String,
    message: String,
) -> Result<(), String> {
    let a = repo_auth(&app)?;
    let url = format!("{API_ROOT}/repos/{}/{}/contents/{}", a.owner, a.name, path);
    let body = serde_json::json!({ "message": message, "sha": sha });
    let resp = json_headers(client().delete(&url), &a.token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GitHub DELETE {path} -> {}", resp.status()));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    sha: String,
}

/// List the files in a directory. Returns [] on 404 (empty/absent inbox).
#[tauri::command]
pub async fn github_list_dir(app: tauri::AppHandle, path: String) -> Result<Vec<DirEntry>, String> {
    let a = repo_auth(&app)?;
    let url = format!("{API_ROOT}/repos/{}/{}/contents/{}", a.owner, a.name, path);
    let resp = json_headers(client().get(&url), &a.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(vec![]);
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub list {path} -> {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut out = vec![];
    if let Some(arr) = json.as_array() {
        for item in arr {
            if item["type"].as_str() == Some("file") {
                out.push(DirEntry {
                    name: item["name"].as_str().unwrap_or("").to_string(),
                    path: item["path"].as_str().unwrap_or("").to_string(),
                    sha: item["sha"].as_str().unwrap_or("").to_string(),
                });
            }
        }
    }
    Ok(out)
}

// ---- Releases API commands (binary snapshot + workbook assets) --------------

async fn get_or_create_release(a: &RepoAuth, tag: &str) -> Result<serde_json::Value, String> {
    let url = format!("{API_ROOT}/repos/{}/{}/releases/tags/{tag}", a.owner, a.name);
    let resp = json_headers(client().get(&url), &a.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        return resp.json().await.map_err(|e| e.to_string());
    }
    if resp.status() != reqwest::StatusCode::NOT_FOUND {
        return Err(format!("get release {tag} -> {}", resp.status()));
    }
    let create_url = format!("{API_ROOT}/repos/{}/{}/releases", a.owner, a.name);
    let body = serde_json::json!({
        "tag_name": tag,
        "name": tag,
        "body": "Histometer snapshot — auto-updated by the workstation.",
        "prerelease": false,
    });
    let resp = json_headers(client().post(&create_url), &a.token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let st = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("create release {tag} -> {st} {txt}"));
    }
    resp.json().await.map_err(|e| e.to_string())
}

/// Upload (overwriting) a binary asset onto the given release tag.
#[tauri::command]
pub async fn github_upload_release_asset(
    app: tauri::AppHandle,
    tag: String,
    asset_name: String,
    bytes: Vec<u8>,
    content_type: String,
) -> Result<(), String> {
    let a = repo_auth(&app)?;
    let release = get_or_create_release(&a, &tag).await?;
    let release_id = release["id"].as_i64().ok_or("release id missing")?;

    // Overwrite: delete any existing asset with the same name first.
    if let Some(assets) = release["assets"].as_array() {
        for asset in assets {
            if asset["name"].as_str() == Some(asset_name.as_str()) {
                if let Some(aid) = asset["id"].as_i64() {
                    let durl =
                        format!("{API_ROOT}/repos/{}/{}/releases/assets/{aid}", a.owner, a.name);
                    let _ = json_headers(client().delete(&durl), &a.token).send().await;
                }
            }
        }
    }

    let upload_url = format!(
        "{UPLOADS_ROOT}/repos/{}/{}/releases/{release_id}/assets?name={asset_name}",
        a.owner, a.name
    );
    let resp = json_headers(client().post(&upload_url), &a.token)
        .header("Content-Type", content_type)
        .body(bytes)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let st = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("upload asset {asset_name} -> {st} {txt}"));
    }
    Ok(())
}

/// Download a binary asset by name from the given release tag.
#[tauri::command]
pub async fn github_download_release_asset(
    app: tauri::AppHandle,
    tag: String,
    asset_name: String,
) -> Result<Vec<u8>, String> {
    let a = repo_auth(&app)?;
    let url = format!("{API_ROOT}/repos/{}/{}/releases/tags/{tag}", a.owner, a.name);
    let resp = json_headers(client().get(&url), &a.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("get release {tag} -> {}", resp.status()));
    }
    let release: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut asset_id = None;
    if let Some(assets) = release["assets"].as_array() {
        for asset in assets {
            if asset["name"].as_str() == Some(asset_name.as_str()) {
                asset_id = asset["id"].as_i64();
            }
        }
    }
    let asset_id = asset_id.ok_or(format!("asset {asset_name} not found on release {tag}"))?;
    let asset_url = format!("{API_ROOT}/repos/{}/{}/releases/assets/{asset_id}", a.owner, a.name);
    // Asset download needs Accept: octet-stream (not the JSON accept header).
    let resp = client()
        .get(&asset_url)
        .header("User-Agent", USER_AGENT)
        .header("X-GitHub-Api-Version", API_VERSION)
        .header("Accept", "application/octet-stream")
        .bearer_auth(&a.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download asset {asset_name} -> {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(bytes.to_vec())
}

/// Validate that the configured repo + token work (used at setup). Returns the
/// repo's full name on success.
#[tauri::command]
pub async fn github_validate(app: tauri::AppHandle) -> Result<String, String> {
    let a = repo_auth(&app)?;
    let url = format!("{API_ROOT}/repos/{}/{}", a.owner, a.name);
    let resp = json_headers(client().get(&url), &a.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(json["full_name"].as_str().unwrap_or("").to_string())
    } else {
        Err(format!(
            "Could not reach the repository (HTTP {}). Check the repo name and token.",
            resp.status()
        ))
    }
}
