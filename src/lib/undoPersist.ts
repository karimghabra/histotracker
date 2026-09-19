import { getDb, journalHead } from "./db";
import { useUndoStore, type UndoEntry } from "./undo";

// Persist the undo/redo history across reloads so reopening the app doesn't
// silently disable Undo even though the database is fully restored.
//
// SAFETY: an undo entry is a mark in the undo journal, valid only against the
// journal it was taken from. We store the journal's head (its last sequence number
// and statement) as an anchor next to the history; on load we keep the history only
// if the live journal still ends exactly there. Any mismatch (fresh install, a
// swapped-in image, a write since) discards the history, so a stale mark can never
// be replayed into the wrong database. Worst case: no history.
const DB_NAME = "histometer-undo";
const STORE = "kv";
const KEY = "history";

interface Persisted {
  anchor: string;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
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

async function journalAnchor(): Promise<string> {
  const head = await journalHead();
  const db = await getDb();
  const rows = await db.select<Array<{ stmt: string }>>(`SELECT stmt FROM undo_journal WHERE seq = ?`, [head]);
  return `${head}:${rows[0]?.stmt ?? ""}`;
}

async function persist(undoStack: UndoEntry[], redoStack: UndoEntry[]): Promise<void> {
  if (!hasIdb()) return;
  try {
    if (undoStack.length === 0 && redoStack.length === 0) {
      await idbClear();
      return;
    }
    const anchor = await journalAnchor(); // the journal this history is valid against
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
    // A history persisted by a build before the journal holds whole database
    // images (up to 100 of them) and a byte-image anchor, never a mark: drop it,
    // which also frees the space those images took.
    const marked = [...saved.undoStack, ...(saved.redoStack ?? [])].every((e) => typeof e?.mark === "number");
    if (!marked || typeof saved.anchor !== "string" || (await journalAnchor()) !== saved.anchor) {
      await idbClear(); // history belongs to a different database, or an older build
      return;
    }
    useUndoStore.setState({ undoStack: saved.undoStack, redoStack: saved.redoStack });
  } catch {
    // Ignore: start with an empty in-memory history.
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
