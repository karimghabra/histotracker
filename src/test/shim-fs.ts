// A tiny virtual filesystem for the browser test shims. It maps a path to raw
// bytes, persisted in localStorage so state survives reloads.
//
// This is what makes the real image-based undo/redo code path testable in a
// plain browser: the SQL shim persists the sql.js database under a fixed file
// path here, and the core shim's `read_file`/`save_file` operate on that SAME
// path — so db.ts's snapshotDb()/restoreDb() (checkpoint → read_file → bytes;
// resetDb → save_file → reopen) run completely unmodified in Chromium, against
// a genuine "file" that gets overwritten and reopened, just like production.
const PREFIX = "histometer-shim-fs:";

export function readShimFile(path: string): Uint8Array | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + path);
    return raw == null ? null : decode(raw);
  } catch {
    return null;
  }
}

export function writeShimFile(path: string, bytes: Uint8Array): void {
  try {
    window.localStorage.setItem(PREFIX + path, encode(bytes));
  } catch {
    // Quota exceeded — nothing useful to do in a debug harness; keep running.
  }
}

export function clearShimFs(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
