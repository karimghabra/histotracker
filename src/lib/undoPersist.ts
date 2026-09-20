import { snapshotDb, type DbImage } from "./db";
import { useUndoStore, type Snapshot } from "./undo";

// Persist the undo/redo history across reloads so reopening the app doesn't
// silently disable Undo even though the database is fully restored.
//
// SAFETY: whole-DB-image undo entries are only valid against the exact DB they
// were captured from. We store the *current* DB image as an anchor next to the
// history; on load we keep the history only if the live DB is byte-identical to
// that anchor. Any mismatch (fresh install, a swapped-in snapshot, an externally
// replaced file) discards the history — so a stale entry can never be restored
// into the wrong database. Worst case degrades to today's behavior (no history).
const DB_NAME = "histometer-undo";
const STORE = "kv";
const KEY = "history";

interface Persisted {
  anchor: DbImage;
  undoStack: Snapshot[];
  redoStack: Snapshot[];
}

function hasIdb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(): Promise<Persisted | undefined> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve(req.result as Persisted | undefined);
        req.onerror = () => reject(req.error);
      }),
  );
}

function idbPut(value: Persisted): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

function idbClear(): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

function bytesEqual(a: DbImage, b: DbImage): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

async function persist(undoStack: Snapshot[], redoStack: Snapshot[]): Promise<void> {
  if (!hasIdb()) return;
  try {
    if (undoStack.length === 0 && redoStack.length === 0) {
      await idbClear();
      return;
    }
    const anchor = await snapshotDb(); // the DB state this history is valid against
    await idbPut({ anchor, undoStack, redoStack });
  } catch {
    // Best-effort persistence; never let it disturb the app.
  }
}

/** Restore a previously-persisted history if it matches the live database. */
export async function hydrateUndoHistory(): Promise<void> {
  if (!hasIdb()) return;
  try {
    const saved = await idbGet();
    if (!saved?.undoStack) return;
    const current = await snapshotDb();
    if (!bytesEqual(current, saved.anchor)) {
      await idbClear(); // history belongs to a different database — drop it
      return;
    }
    useUndoStore.setState({ undoStack: saved.undoStack, redoStack: saved.redoStack });
  } catch {
    // Ignore — start with an empty in-memory history.
  }
}

// Mirror every history change to IndexedDB (debounced so rapid actions coalesce).
if (hasIdb()) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  useUndoStore.subscribe((state) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void persist(state.undoStack, state.redoStack), 400);
  });
}
