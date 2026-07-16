import { invoke } from "@tauri-apps/api/core";

export type SyncRole = "workstation" | "viewer";

/** Redacted config the backend returns — never carries the token. */
export interface SyncConfigPublic {
  role: string; // "workstation" | "viewer" | ""
  repo_owner: string;
  repo_name: string;
  operator_name: string;
  operator_initials: string;
  last_synced_version: string;
  configured: boolean;
  has_token: boolean;
}

export interface SyncConfigInput {
  role: SyncRole;
  repo_owner: string;
  repo_name: string;
  /** Omit or leave empty to keep the existing stored token. */
  token?: string;
  operator_name: string;
  operator_initials: string;
}

/** Read the redacted sync config (token never leaves the backend). */
export function getSyncConfig(): Promise<SyncConfigPublic> {
  return invoke<SyncConfigPublic>("sync_config_get");
}

/** Persist the sync config to the local `sync-config.json` (outside the DB). */
export function setSyncConfig(input: SyncConfigInput): Promise<void> {
  return invoke("sync_config_set", { input });
}

/** Record the version string of the snapshot this install last synced. */
export function setLastSyncedVersion(version: string): Promise<void> {
  return invoke("sync_set_last_version", { version });
}
