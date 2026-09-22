// A tiny virtual filesystem for the browser test shims. It maps a path to raw
// bytes, held in IndexedDB so the state survives a reload.
//
// This is what makes the real image code paths (backups, revert, sync) testable
// in a plain browser: the SQL shim persists the sql.js database under a fixed file
// path here, and the core shim's `read_file`/`save_file` operate on that SAME
// path — so db.ts's snapshotDb()/restoreDb() (checkpoint → read_file → bytes;
// resetDb → save_file → reopen) run completely unmodified in Chromium, against
// a genuine "file" that gets overwritten and reopened, just like production.
//
// ## Why IndexedDB, and never localStorage again
//
// This used to store each file base64-encoded in localStorage, and to SWALLOW the
// QuotaExceededError that came of it. Chromium gives an origin about five million
// UTF-16 characters of localStorage, which is roughly 3.7 MB of bytes once base64
// has grown them by a third; a lab-sized database with its undo journal is several
// times that. So the stress suites, which seed 130 to 150 blocks, silently stopped
// persisting partway through, and every reload after that point reopened a frozen
// image. tests/stress3 reloads the page on purpose (`refreshView`), so it read the
// frozen image back and reported that rows had been destroyed. Three nightly runs
// were spent chasing a data-loss bug the app did not have.
//
// IndexedDB holds bytes rather than text, needs no base64, and is bounded by the
// browser's per-origin storage quota (a share of free disk, tens of gigabytes on
// an ordinary runner) rather than by a fixed five-megabyte budget. It is also
// already what the app itself uses to persist the undo history
// (src/lib/undoPersist.ts), so the harness stores its state where the app does.
//
// The price is that every read and write is asynchronous, which is why this
// module's API returns promises. Every caller of it is in an async path already
// (`Database.load`/`execute`/`close`, and the `invoke` shim's commands), so the
// write-through semantics are unchanged: a statement's effect reaches the
// virtual file before the call that made it resolves.
//
// ## A write is never lost quietly
//
// A failed write is not survivable. The live sql.js database and the file a
// reload would open have diverged at that point, so every later assertion is
// about a database that is no longer the one under test — which is precisely the
// lie that cost those three nights. So a failure is thrown at the caller AND
// latched: from then on the whole virtual filesystem refuses to read or write,
// naming the file it could not store and how large it was. A run that has lost a
// write stops being a run.
/**
 * The IndexedDB database and store the virtual filesystem lives in.
 *
 * Exported because a spec that plants a database image has to write it BEFORE
 * this module is loaded, from a bare page on the same origin
 * (tests/helpers/shim-fs.ts `plantShimImage` says why) — so it addresses the
 * store directly, and had better not guess at its name.
 */
export const SHIM_FS_DB_NAME = "histometer-shim-fs";
export const SHIM_FS_STORE = "files";
export const SHIM_FS_VERSION = 1;

const DB_NAME = SHIM_FS_DB_NAME;
const STORE = SHIM_FS_STORE;

/** The first write this filesystem could not make. Once set, nothing else runs. */
let lost: Error | null = null;

function assertNothingLost(): void {
  if (lost) throw lost;
}

/**
 * Record a write that did not happen, and make it impossible to ignore: the
 * error is thrown at the caller and every later operation rethrows it.
 */
function loseWrite(path: string, bytes: number, cause: unknown): never {
  const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  lost = new Error(
    `[shim-fs] could not store "${path}" (${bytes.toLocaleString("en-US")} bytes): ${reason}. ` +
      `The harness has lost a write: the live database and the image a reload would open have ` +
      `diverged, so the virtual filesystem now refuses every operation rather than let the run ` +
      `report on a database that is no longer under test.`,
  );
  // So a spec, or a person reading the console, can see it without catching it.
  try {
    (window as unknown as Record<string, unknown>).__SHIM_FS_LOST__ = lost.message;
  } catch {
    /* the message is on the thrown error either way */
  }
  throw lost;
}

let handle: Promise<IDBDatabase> | null = null;

function openFs(): Promise<IDBDatabase> {
  handle ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, SHIM_FS_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB.open failed"));
    request.onblocked = () => reject(new Error("indexedDB.open is blocked by another connection"));
  }).catch((err) => {
    handle = null;
    throw err;
  });
  return handle;
}

/** Run `work` in a transaction and settle on the TRANSACTION, not on the request. */
function transact<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, resolve: (value: T) => void) => void,
): Promise<T> {
  return openFs().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        let value: T | undefined;
        let settled = false;
        // A readwrite transaction is only durable once it COMMITS; a request's
        // success fires earlier, and a quota failure arrives as an abort after it.
        tx.oncomplete = () => resolve(value as T);
        tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
        tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
        work(tx.objectStore(STORE), (v) => {
          if (settled) return;
          settled = true;
          value = v;
        });
      }),
  );
}

export async function readShimFile(path: string): Promise<Uint8Array | null> {
  assertNothingLost();
  const stored = await transact<unknown>("readonly", (store, done) => {
    const request = store.get(path);
    request.onsuccess = () => done(request.result);
  });
  if (stored == null) return null;
  // Structured clone hands back whatever was stored; normalise defensively so a
  // caller never has to care which view it was written as.
  if (stored instanceof Uint8Array) return stored;
  if (stored instanceof ArrayBuffer) return new Uint8Array(stored);
  return null;
}

export async function writeShimFile(path: string, bytes: Uint8Array): Promise<void> {
  assertNothingLost();
  try {
    // A fresh copy: `db.export()`'s buffer is reused by sql.js, and IndexedDB
    // clones asynchronously.
    await transact<void>("readwrite", (store, done) => {
      store.put(new Uint8Array(bytes), path);
      done(undefined);
    });
  } catch (err) {
    loseWrite(path, bytes.length, err);
  }
}

export async function removeShimFile(path: string): Promise<void> {
  assertNothingLost();
  try {
    await transact<void>("readwrite", (store, done) => {
      store.delete(path);
      done(undefined);
    });
  } catch (err) {
    loseWrite(path, 0, err);
  }
}

/** Every stored path that starts with `prefix`, with the size of each, sorted by path. */
export async function listShimFiles(prefix = ""): Promise<Array<{ path: string; size: number }>> {
  assertNothingLost();
  const out = await transact<Array<{ path: string; size: number }>>("readonly", (store, done) => {
    const found: Array<{ path: string; size: number }> = [];
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        done(found);
        return;
      }
      const key = String(cursor.key);
      if (key.startsWith(prefix)) {
        const value = cursor.value as Uint8Array | ArrayBuffer | null;
        found.push({ path: key, size: value ? value.byteLength : 0 });
      }
      cursor.continue();
    };
  });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function clearShimFs(): Promise<void> {
  assertNothingLost();
  try {
    await transact<void>("readwrite", (store, done) => {
      store.clear();
      done(undefined);
    });
  } catch (err) {
    loseWrite("(the whole virtual filesystem)", 0, err);
  }
}

// ---------------------------------------------------------------------------
// The suites' way in.
//
// Several specs look at what the app wrote: a CSV or workbook the export path
// saved, the live database image, a backup. They used to read the localStorage
// keys this module happened to use, which made every one of them a second copy
// of the storage decision — and left them all broken the moment it changed. They
// ask the filesystem now (tests/helpers/shim-fs.ts wraps this), so where the
// bytes live is this module's business alone.
//
// Base64 at the boundary because a Uint8Array does not survive the trip out of
// `page.evaluate` intact.
// ---------------------------------------------------------------------------
function encodeB64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeB64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface ShimFsAccess {
  read(path: string): Promise<string | null>;
  write(path: string, b64: string): Promise<void>;
  list(prefix?: string): Promise<Array<{ path: string; size: number }>>;
  remove(path: string): Promise<void>;
  clear(): Promise<void>;
}

const access: ShimFsAccess = {
  read: async (path) => {
    const bytes = await readShimFile(path);
    return bytes ? encodeB64(bytes) : null;
  },
  write: (path, b64) => writeShimFile(path, decodeB64(b64)),
  list: (prefix) => listShimFiles(prefix),
  remove: (path) => removeShimFile(path),
  clear: () => clearShimFs(),
};

try {
  (window as unknown as Record<string, unknown>).__SHIM_FS__ = access;
} catch {
  /* not a browser (the compat harness imports the shims in Node) */
}
