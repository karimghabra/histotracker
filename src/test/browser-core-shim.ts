// Browser shim for `@tauri-apps/api/core` `invoke`. The frontend calls a handful
// of Rust commands for sync (GitHub-backed) and local file IO. None of that
// exists in a plain browser, so this returns benign values: a single-user
// "workstation" config so the app skips onboarding and renders the board, and
// no-op responses for the sync/file commands so the 2-minute sync loop stays
// inert instead of throwing. Wired in via resolve.alias in
// vite.config.playwright.ts. Real builds are untouched.
//
// read_file/save_file DO operate on the shared virtual filesystem (shim-fs) so
// the real image-based undo/redo path — snapshotDb() reads the DB file bytes and
// restoreDb() overwrites them — runs unmodified against a genuine "file".
import { readShimFile, writeShimFile } from "./shim-fs";

const SYNC_CONFIG = {
  role: "workstation",
  repo_owner: "",
  repo_name: "",
  operator_name: "Playwright Operator",
  operator_initials: "PO",
  last_synced_version: "",
  install_id: "", // empty → publishSnapshot skips the workstation-claim dance
  configured: true,
  has_token: false,
};

// ---- Sync harness hooks (test-only) -----------------------------------------
// When a test sets window.__FAKEGH_NS__, the github_* commands are routed to the
// shared in-memory "fake GitHub" served by the Playwright Vite server (see
// vite.config.playwright.ts), turning two isolated browser contexts into a
// workstation + viewer against one remote. window.__SYNC_OVERRIDE__ lets each
// context declare its own role/identity. Absent both, behaviour is unchanged.
type SyncWindow = typeof globalThis & {
  __FAKEGH_NS__?: string;
  __SYNC_OVERRIDE__?: Record<string, unknown>;
};
const LAST_VERSION_KEY = "histometer-shim-last-version";

function fakeNs(): string | undefined {
  return (globalThis as SyncWindow).__FAKEGH_NS__;
}
async function fakegh<T>(command: string, payload: Record<string, unknown>): Promise<T> {
  const ns = encodeURIComponent(fakeNs() ?? "default");
  const res = await fetch(`/__fakegh/${command}?ns=${ns}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as T;
}

// Map the Rust github_* command surface onto the fake remote.
async function routeGithub<T>(cmd: string, a: Record<string, unknown> = {}): Promise<T> {
  switch (cmd) {
    case "github_get_file":
      return fakegh("get_file", { path: a.path });
    case "github_put_file":
      return fakegh("put_file", { path: a.path, content: a.content, sha: a.sha, message: a.message });
    case "github_delete_file":
      return fakegh("delete_file", { path: a.path, sha: a.sha });
    case "github_list_dir":
      return fakegh("list_dir", { path: a.path });
    case "github_upload_release_asset":
      return fakegh("upload_release_asset", { tag: a.tag, assetName: a.assetName, bytes: a.bytes });
    case "github_download_release_asset":
      return fakegh("download_release_asset", { tag: a.tag, assetName: a.assetName });
    case "github_validate":
      return fakegh("validate", {});
    default:
      return null as unknown as T;
  }
}

export async function invoke<T>(cmd: string, _args?: Record<string, unknown>): Promise<T> {
  // Sync harness: real github_* against the shared fake remote.
  if (fakeNs() && cmd.startsWith("github_")) return routeGithub<T>(cmd, _args ?? {});

  switch (cmd) {
    case "sync_config_get": {
      const override = (globalThis as SyncWindow).__SYNC_OVERRIDE__;
      if (!override) return SYNC_CONFIG as unknown as T;
      // Persist last_synced_version per context so isNewer() works across cycles.
      const lastVersion = (() => {
        try {
          return window.localStorage.getItem(LAST_VERSION_KEY) ?? "";
        } catch {
          return "";
        }
      })();
      return { ...SYNC_CONFIG, ...override, last_synced_version: lastVersion } as unknown as T;
    }

    case "sync_set_last_version": {
      try {
        window.localStorage.setItem(LAST_VERSION_KEY, String(_args?.version ?? ""));
      } catch {
        /* ignore */
      }
      return undefined as unknown as T;
    }

    // Reads that should look "absent / empty" so sync finds nothing to do.
    case "github_get_file":
      return null as unknown as T;
    case "github_list_dir":
      return [] as unknown as T;
    case "github_download_release_asset":
      return [] as unknown as T;
    case "github_validate":
      return { ok: true } as unknown as T;

    // Real file IO against the virtual filesystem — powers undo/redo snapshots.
    case "read_file": {
      const bytes = readShimFile(String(_args?.path ?? ""));
      return Array.from(bytes ?? new Uint8Array()) as unknown as T;
    }
    case "save_file": {
      const contents = (_args?.contents as number[] | undefined) ?? [];
      writeShimFile(String(_args?.path ?? ""), Uint8Array.from(contents));
      return undefined as unknown as T;
    }

    // Native "Save as…" dialog: return a deterministic path so file exports
    // (CSV/XLSX) can be exercised headlessly — the bytes then land in the shared
    // virtual filesystem via the save_file command above.
    case "plugin:dialog|save": {
      const opts = (_args?.options ?? {}) as { defaultPath?: string };
      return (opts.defaultPath ?? "export.bin") as unknown as T;
    }

    // Writes / no-return commands: resolve successfully.
    case "github_put_file":
      return "shim-sha" as unknown as T;
    case "github_upload_release_asset":
    case "github_delete_file":
    case "sync_config_set":
      return undefined as unknown as T;

    default:
      // Surface anything we didn't anticipate rather than hang silently.
      throw new Error(`[browser-core-shim] Unhandled Tauri command: ${cmd}`);
  }
}

// Re-export the rest of the surface as inert stubs in case they're imported.
export function transformCallback(): number {
  return 0;
}
export const convertFileSrc = (src: string): string => src;
