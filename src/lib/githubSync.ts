import { invoke } from "@tauri-apps/api/core";
import {
  getDbFilePath,
  insertStainRequest,
  resetDb,
} from "./db";
import { buildStatusWorkbookBytes } from "./export";
import { getSyncConfig, setLastSyncedVersion } from "./syncConfig";
import { nowTimestamp } from "./utils";

// Fixed layout in the shared private data repo.
export const RELEASE_TAG = "snapshot-latest";
export const DB_ASSET = "histometer.db";
export const WORKBOOK_ASSET = "histometer-status.xlsx";
export const MANIFEST_PATH = "manifest.json";
export const REQUESTS_DIR = "requests";
export const WORKSTATION_CLAIM_PATH = "workstation.json";

const DB_CONTENT_TYPE = "application/octet-stream";
const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Pointer file committed to the repo tree; the heavy assets live on the release. */
export interface SnapshotManifest {
  version: string;
  updated_at: string;
  db_asset: string;
  workbook_asset: string;
}

interface FileContent {
  content: string;
  sha: string;
}

interface DirEntry {
  name: string;
  path: string;
  sha: string;
}

// ---- Thin invoke wrappers over the Rust github_* commands --------------------

export function githubGetFile(path: string): Promise<FileContent | null> {
  return invoke<FileContent | null>("github_get_file", { path });
}

export function githubPutFile(
  path: string,
  content: string,
  sha: string | undefined,
  message: string,
): Promise<string> {
  return invoke<string>("github_put_file", { path, content, sha, message });
}

export function githubDeleteFile(path: string, sha: string, message: string): Promise<void> {
  return invoke("github_delete_file", { path, sha, message });
}

export function githubListDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("github_list_dir", { path });
}

export function githubUploadReleaseAsset(
  tag: string,
  assetName: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  return invoke("github_upload_release_asset", {
    tag,
    assetName,
    bytes: Array.from(bytes),
    contentType,
  });
}

export async function githubDownloadReleaseAsset(
  tag: string,
  assetName: string,
): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("github_download_release_asset", { tag, assetName });
  return Uint8Array.from(bytes);
}

/** Setup check: confirm the configured repo + token reach a real repo. */
export function githubValidate(): Promise<string> {
  return invoke<string>("github_validate");
}

// ---- Manifest read/write ----------------------------------------------------

export async function readManifest(): Promise<SnapshotManifest | null> {
  const file = await githubGetFile(MANIFEST_PATH);
  if (!file) return null;
  try {
    return JSON.parse(file.content) as SnapshotManifest;
  } catch {
    return null;
  }
}

async function writeManifest(manifest: SnapshotManifest): Promise<void> {
  // Re-read the sha immediately before writing so we update rather than 409.
  const existing = await githubGetFile(MANIFEST_PATH);
  await githubPutFile(
    MANIFEST_PATH,
    `${JSON.stringify(manifest, null, 2)}\n`,
    existing?.sha,
    `Snapshot ${manifest.version}`,
  );
}

// A monotonically increasing, chronologically-sortable version stamp. ISO 8601
// UTC strings compare lexicographically in time order, so "newer" is a `>` test.
function newVersion(): string {
  return new Date().toISOString();
}

/** True when `remote` represents a strictly newer snapshot than `local`. */
export function isNewer(remote: string, local: string): boolean {
  if (!remote) return false;
  if (!local) return true;
  return remote > local;
}

// ---- Single-writer claim ----------------------------------------------------

/**
 * The one authoritative workstation for a lab records its identity here so a
 * second install can't accidentally publish over it. `install_id` is the stable
 * per-install id from the local config.
 */
export interface WorkstationClaim {
  install_id: string;
  operator_name: string;
  claimed_at: string;
}

export async function readWorkstationClaim(): Promise<WorkstationClaim | null> {
  const file = await githubGetFile(WORKSTATION_CLAIM_PATH);
  if (!file) return null;
  try {
    return JSON.parse(file.content) as WorkstationClaim;
  } catch {
    return null;
  }
}

async function writeWorkstationClaim(installId: string, operatorName: string): Promise<void> {
  const existing = await githubGetFile(WORKSTATION_CLAIM_PATH);
  const payload: WorkstationClaim = {
    install_id: installId,
    operator_name: operatorName,
    claimed_at: nowTimestamp(),
  };
  await githubPutFile(
    WORKSTATION_CLAIM_PATH,
    `${JSON.stringify(payload, null, 2)}\n`,
    existing?.sha,
    `Workstation claimed by ${operatorName || "workstation"}`,
  );
}

export class WorkstationTakenError extends Error {
  constructor(public claim: WorkstationClaim) {
    super(
      `A workstation is already set up for this lab — claimed by ${
        claim.operator_name || "another machine"
      }${claim.claimed_at ? ` on ${claim.claimed_at}` : ""}.`,
    );
    this.name = "WorkstationTakenError";
  }
}

/**
 * Claim (or re-assert) the authoritative workstation slot for `installId`.
 * Throws WorkstationTakenError when another install already holds it, unless
 * `force` is set (a deliberate "replace the current workstation" action).
 */
export async function ensureWorkstationClaim(
  installId: string,
  operatorName: string,
  force = false,
): Promise<void> {
  const claim = await readWorkstationClaim();
  if (claim && claim.install_id !== installId && !force) {
    throw new WorkstationTakenError(claim);
  }
  await writeWorkstationClaim(installId, operatorName);
}

// ---- Workstation: publish ---------------------------------------------------

/**
 * Publish the live DB + status workbook as overwriting release assets and bump
 * the committed manifest. Returns the new version string.
 *
 * Refuses to publish if another install has taken over the workstation slot, so
 * a demoted machine can never clobber the authoritative snapshot.
 */
export async function publishSnapshot(): Promise<string> {
  const config = await getSyncConfig();
  const claim = await readWorkstationClaim();
  if (claim && config.install_id && claim.install_id !== config.install_id) {
    throw new WorkstationTakenError(claim);
  }
  if (!claim && config.install_id) {
    // We hold the role but the claim file is absent (first publish or it was
    // removed) — assert ownership before writing anything.
    await writeWorkstationClaim(config.install_id, config.operator_name);
  }

  const dbPath = await getDbFilePath();
  const dbBytes = Uint8Array.from(await invoke<number[]>("read_file", { path: dbPath }));
  const workbookBytes = await buildStatusWorkbookBytes();

  await githubUploadReleaseAsset(RELEASE_TAG, DB_ASSET, dbBytes, DB_CONTENT_TYPE);
  await githubUploadReleaseAsset(RELEASE_TAG, WORKBOOK_ASSET, workbookBytes, XLSX_CONTENT_TYPE);

  const version = newVersion();
  await writeManifest({
    version,
    updated_at: nowTimestamp(),
    db_asset: DB_ASSET,
    workbook_asset: WORKBOOK_ASSET,
  });
  await setLastSyncedVersion(version);
  return version;
}

// ---- Viewer: pull -----------------------------------------------------------

export interface PullResult {
  updated: boolean;
  version?: string;
}

/**
 * Download and swap in the published snapshot when it is newer than the one
 * this viewer last synced. Sequence: read manifest → compare → download DB →
 * close connection → overwrite the SQLite file → let getDb() reopen it.
 */
export async function pullSnapshotIfNewer(): Promise<PullResult> {
  const manifest = await readManifest();
  if (!manifest) return { updated: false };

  const config = await getSyncConfig();
  if (!isNewer(manifest.version, config.last_synced_version)) {
    return { updated: false };
  }

  const dbBytes = await githubDownloadReleaseAsset(RELEASE_TAG, manifest.db_asset || DB_ASSET);

  // Resolve the path while the connection is open, then close it so the file
  // is not locked when we overwrite it, then reopen against the new bytes.
  const dbPath = await getDbFilePath();
  await resetDb();
  await invoke("save_file", { path: dbPath, contents: Array.from(dbBytes) });

  await setLastSyncedVersion(manifest.version);
  return { updated: true, version: manifest.version };
}

// ---- Requests: submit (viewer) + drain (workstation) ------------------------

export interface RequestInput {
  sampleCode: string;
  slideCode?: string;
  requestedAssay: string;
  note?: string;
  requesterName: string;
}

// The transient request file dropped into the repo inbox by a viewer.
interface RequestFile {
  uuid: string;
  sample_code: string;
  slide_code: string;
  requested_assay: string;
  requester_name: string;
  note: string;
  created_at: string;
}

/** Viewer: drop an append-only request file into the shared inbox. */
export async function submitRequest(input: RequestInput): Promise<string> {
  const uuid = crypto.randomUUID();
  const payload: RequestFile = {
    uuid,
    sample_code: input.sampleCode.trim(),
    slide_code: input.slideCode?.trim() ?? "",
    requested_assay: input.requestedAssay.trim(),
    requester_name: input.requesterName.trim(),
    note: input.note?.trim() ?? "",
    created_at: nowTimestamp(),
  };
  await githubPutFile(
    `${REQUESTS_DIR}/${uuid}.json`,
    `${JSON.stringify(payload, null, 2)}\n`,
    undefined,
    `Stain request from ${payload.requester_name || "viewer"}`,
  );
  return uuid;
}

/**
 * Workstation: import every request file from the inbox into the permanent DB
 * record (idempotent on uuid), then delete it from the repo so the tree stays
 * tiny. Returns how many new requests were ingested.
 */
export async function drainRequests(): Promise<number> {
  const entries = await githubListDir(REQUESTS_DIR);
  let ingested = 0;
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const file = await githubGetFile(entry.path);
    if (!file) continue;
    let payload: RequestFile;
    try {
      payload = JSON.parse(file.content) as RequestFile;
    } catch {
      // Skip a malformed file rather than deleting data we couldn't read.
      continue;
    }
    const isNew = await insertStainRequest({
      uuid: payload.uuid || entry.name.replace(/\.json$/, ""),
      sample_code: payload.sample_code ?? "",
      slide_code: payload.slide_code ?? "",
      requested_assay: payload.requested_assay ?? "",
      requester_name: payload.requester_name ?? "",
      note: payload.note ?? "",
      created_at: payload.created_at || nowTimestamp(),
    });
    if (isNew) ingested += 1;
    await githubDeleteFile(entry.path, file.sha, `Ingest request ${payload.uuid ?? entry.name}`);
  }
  return ingested;
}
