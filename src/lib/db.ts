import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChecklistItem,
  AssayCatalogEntry,
  NewSampleInput,
  ProcessingBatch,
  Project,
  LabUser,
  Sample,
  Slide,
  SlideStack,
  SlidePurpose,
  SampleTimelineEvent,
  AuditEvent,
} from "./types";
import {
  STAGES,
  STAGE_COLUMNS,
  STAGE_ORDER,
  SECTION_STAGES,
  SECTION_STAGE_COLUMNS,
  SECTION_STAGE_ORDER,
  PREPROCESSING_STAGES,
  processingDurationHours,
} from "./stages";
import type { SectionRequest, StainRequest, StainRequestStatus } from "./types";
import {
  type AppSettings,
  parseSettings,
  plannedExtras,
  rackCapacity,
  settingsToRows,
} from "./settings";
import {
  displayCode,
  duplicateLabel,
  formatSampleCode,
  nowTimestamp,
  parseTimestamp,
  sampleCodeVariants,
  todayIso,
} from "./utils";

const STAGE_COLUMN_SET = new Set(Object.values(STAGE_COLUMNS));

const DB_URL = "sqlite:histometer.db";

let dbPromise: Promise<Database> | null = null;

// When true, every write (db.execute) is rejected. Viewer instances are
// read-only mirrors of the workstation's published snapshot; this is the
// data-layer backstop behind the UI-level read-only gating. Checked at call
// time so the flag can be flipped after the connection is already open.
let viewerReadOnly = false;

export function setViewerReadOnly(readOnly: boolean): void {
  viewerReadOnly = readOnly;
}

/**
 * When true, every write is rejected because NOBODY IS SIGNED IN (#128).
 *
 * An unsigned user had the run of the workstation: sectioning, consuming
 * extras, requesting stains, recording images, marking blocks analyzed. In a
 * posterity application that is worse than it sounds — the work still happened,
 * but the record of who did it says "Unsigned", permanently and unfixably.
 *
 * The gate lives HERE rather than in `useActions`, because `useActions` is not
 * the only way in: the protocol checklist, the cut-group drawer and the rack
 * drawer all call `db.ts` directly. This is the one place every write passes
 * through, so a surface that forgets to gate itself is merely ugly, not unsafe —
 * the same argument the #72 viewer gate is built on.
 */
let signedOutReadOnly = false;

export function setSignedOutReadOnly(readOnly: boolean): void {
  signedOutReadOnly = readOnly;
}

export const VIEWER_REFUSAL = "This is a read-only viewer — changes are made on the workstation.";
export const SIGNED_OUT_REFUSAL = "Sign in before making modifications.";

/**
 * The unwrapped `execute` for each open connection.
 *
 * Signing in is itself a write, so the session writes below have to reach past
 * the signed-out gate or nobody could ever get through it. Keyed per connection
 * because the file is swapped and reopened at runtime (undo, restore, sync).
 */
const rawExecutes = new WeakMap<Database, Database["execute"]>();

/**
 * Perform a write that manages the SESSION rather than the lab record.
 *
 * Exempt from the signed-out gate — adding a user, choosing one, retiring one,
 * and the audit rows that narrate all three. NOT exempt from the viewer gate: a
 * viewer is a read-only mirror of somebody else's database, and always was.
 */
async function sessionExecute(
  db: Database,
  query: string,
  params: unknown[] = [],
): Promise<{ rowsAffected: number; lastInsertId?: number }> {
  if (viewerReadOnly) throw new Error(VIEWER_REFUSAL);
  const raw = rawExecutes.get(db);
  return raw ? raw(query, params) : db.execute(query, params);
}

export async function recordAuditEvent(
  action: string,
  entityType: string,
  summary: string,
  details = "",
): Promise<void> {
  const db = await getDb();
  // A session write: the audit trail must record a sign-out even though signing
  // out is the moment the gate closes.
  await sessionExecute(
    db,
    `INSERT INTO audit_events (user_id, action, entity_type, summary, details)
     VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
             ?, ?, ?, ?)`,
    [action, entityType, summary, details],
  );
}

function guardWrites(db: Database): Database {
  const original = db.execute.bind(db);
  rawExecutes.set(db, original);
  db.execute = ((query: string, bindValues?: unknown[]) => {
    if (viewerReadOnly) return Promise.reject(new Error(VIEWER_REFUSAL));
    if (signedOutReadOnly) return Promise.reject(new Error(SIGNED_OUT_REFUSAL));
    return original(query, bindValues);
  }) as typeof db.execute;
  return db;
}

export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL)
      .then(async (db) => {
        await ensureRuntimeSchema(db);
        await reconcileStainRequests(db);
        await reconcileFulfilledRequests(db);
        await splitContaminatedStainRacks(db);
        await backfillSlideLetterMarks(db);
        await retireDryingChecklistStep(db);
        return db;
      })
      .then(guardWrites);
  }
  return dbPromise;
}

/**
 * Additively converge the few late-added columns the frontend depends on.
 *
 * tauri-plugin-sql runs the numbered migrations exactly once — at plugin build
 * time, against whatever file exists then. But this app swaps the live SQLite
 * file out from under the connection at runtime: undo/redo restore a whole-file
 * image ({@link restoreDb}) and the sync viewer swaps in a downloaded snapshot,
 * both via close → overwrite → `Database.load()`. That reopen does NOT re-run
 * migrations, so a file that predates a column can end up live with the current
 * frontend. Concretely, this is what made clicking the "Deparaffinized" protocol
 * step silently do nothing: the step-0 UPDATE hit `slides.stage_deparaffinized_at`
 * on a pre-0020 image and threw, aborting the toggle before it refreshed (#58).
 *
 * Each check is a cheap PRAGMA; the ALTER fires only on a file missing the
 * column. Additive only — never destructive — so it is safe on any image and
 * stays consistent with the append-only, schema-is-the-wire-format contract
 * (docs/shared_data_sync.md §1). Runs on the raw handle before the read-only
 * write guard, so a viewer that receives an older image still converges.
 */
async function ensureRuntimeSchema(db: Database): Promise<void> {
  // Register EVERY additively-added column that current runtime queries read or
  // write. Anything missing here becomes a silent failure the moment an older
  // image is opened (undo restore, sync pull, or a REVERT TO AN OLDER BACKUP).
  // A new migration that adds such a column MUST add a matching line below —
  // this is the mechanism behind "updates stay compatible with existing DBs".
  await ensureColumn(db, "slides", "stage_deparaffinized_at", "TEXT");
  await ensureColumn(db, "samples", "preselected_stains", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "slides", "depth_label", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "slides", "depth_note", "TEXT NOT NULL DEFAULT ''");
  // 0023 — slide-letter high-water mark (#73) and archiving (#74).
  await ensureColumn(db, "samples", "slides_issued", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(db, "samples", "archived_at", "TEXT");
  // 0024 — what a slide was ASKED for, kept apart from what it became. Read on
  // every slide row in the Logs and the rack panel, so an older image without
  // them would break both.
  await ensureColumn(db, "slides", "requested_assay_type", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "slides", "requested_assay_name", "TEXT NOT NULL DEFAULT ''");
  // Marker table for one-time data translations (see reconcileStainRequests).
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`,
  );
}

/**
 * One-time DATA translation for the stain-request model change.
 *
 * `preselected_stains` used to hold EVERY agent ever chosen/requested for a
 * block, with the "needs stain" flag derived as (preselected − produced). The
 * new model treats the column as the block's OUTSTANDING requests directly:
 * requests append (duplicates allowed) and a cut trims what it fulfils. Existing
 * databases carry the old, untrimmed shape — so without translation an already
 * cut-and-stained block would light up "needs stain" forever.
 *
 * This runs exactly once per database image (guarded by a marker in schema_meta,
 * which — unlike app_settings — rides WITH the image, so reverting an old backup
 * re-translates it while a translated image is left alone). It rewrites each
 * block's list to (chosen − already-produced), matching what the old flag showed.
 */
async function reconcileStainRequests(db: Database): Promise<void> {
  const done = await db.select<Array<{ value: string }>>(
    `SELECT value FROM schema_meta WHERE key = 'stain_requests_reconciled'`,
  );
  if (done[0]?.value === "1") return;

  const samples = await db.select<Array<{ id: number; preselected_stains: string }>>(
    `SELECT id, preselected_stains FROM samples WHERE preselected_stains <> ''`,
  );
  for (const s of samples) {
    const chosen = parsePreselectedStains(s.preselected_stains);
    if (chosen.length === 0) continue;
    // Agents already cut as a stain slide for this block are fulfilled.
    const producedRows = await db.select<Array<{ assay_name: string }>>(
      `SELECT DISTINCT sl.assay_name FROM slides sl
         JOIN section_requests sr ON sr.id = sl.section_request_id
        WHERE sr.sample_id = ? AND sl.purpose = 'stain' AND sl.assay_name <> ''
          AND sl.current_stage != 'removed'`,
      [s.id],
    );
    const produced = new Set(producedRows.map((r) => r.assay_name.toLowerCase()));
    const outstanding = chosen.filter((a) => !produced.has(a.assay_name.toLowerCase()));
    if (outstanding.length !== chosen.length) {
      await db.execute(`UPDATE samples SET preselected_stains = ? WHERE id = ?`, [
        outstanding.length ? JSON.stringify(outstanding) : "",
        s.id,
      ]);
    }
  }
  await db.execute(
    `INSERT INTO schema_meta (key, value) VALUES ('stain_requests_reconciled', '1')
       ON CONFLICT(key) DO UPDATE SET value = '1'`,
  );
}

/**
 * One-time DATA repair for #112 — outstanding requests a cut already fulfilled.
 *
 * Two bugs let these accumulate: the trim in `createSectionRequests` skipped any
 * group whose `assay_type` was blank, and `removeFromRequests` demanded an exact
 * type match. Both are fixed, but the rows they stranded are still in the live
 * database, showing a block flagged for a stain whose slide is sitting in Needs
 * Sectioning — exactly what #112 reports.
 *
 * MULTISET subtraction, not "drop every agent that has a slide": asking for the
 * same agent twice is legitimate (#62/#66) and queues two slides, so only as
 * many outstanding entries are removed as there are slides to account for them.
 *
 * It cannot be perfect, and it is worth being honest about why: "stale because
 * the trim failed" and "deliberately re-requested after an earlier cut" are the
 * same two rows in the same two tables. This resolves the ambiguity towards
 * clearing, because a flag that cannot be cleared is worse than one that has to
 * be set again — and #112 also adds a control for removing and re-adding
 * requests by hand, so either mistake is recoverable in one click.
 *
 * Guarded by `schema_meta`, which rides WITH the database image: reverting an
 * old backup re-repairs it, a repaired image is left alone.
 */
async function reconcileFulfilledRequests(db: Database): Promise<void> {
  const done = await db.select<Array<{ value: string }>>(
    `SELECT value FROM schema_meta WHERE key = 'fulfilled_requests_reconciled'`,
  );
  if (done[0]?.value === "1") return;

  const samples = await db.select<Array<{ id: number; preselected_stains: string }>>(
    `SELECT id, preselected_stains FROM samples WHERE preselected_stains <> ''`,
  );
  for (const s of samples) {
    const outstanding = parsePreselectedStains(s.preselected_stains);
    if (outstanding.length === 0) continue;
    // One row per live agent-bearing slide, so a block cut twice for the same
    // agent accounts for two outstanding entries.
    const produced = await db.select<Array<{ assay_type: string; assay_name: string }>>(
      `SELECT sl.assay_type, sl.assay_name FROM slides sl
         JOIN section_requests sr ON sr.id = sl.section_request_id
        WHERE sr.sample_id = ? AND sl.purpose = 'stain' AND sl.assay_name <> ''
          AND sl.current_stage != 'removed'`,
      [s.id],
    );
    if (produced.length === 0) continue;
    const remaining = removeFromRequests(outstanding, produced);
    if (remaining.length !== outstanding.length) {
      await db.execute(`UPDATE samples SET preselected_stains = ? WHERE id = ?`, [
        remaining.length ? JSON.stringify(remaining) : "",
        s.id,
      ]);
    }
  }
  await db.execute(
    `INSERT INTO schema_meta (key, value) VALUES ('fulfilled_requests_reconciled', '1')
       ON CONFLICT(key) DO UPDATE SET value = '1'`,
  );
}

/**
 * One-time DATA repair for issue #81 — separate racks that already merged.
 *
 * Before the fix, `getOpenStainRack` matched any rack at `current_stage =
 * 'stain_requested'`, and the protocol checkbox advances a rack by stamping
 * `stage_stained_at` WITHOUT moving `current_stage`. So a rack that was already
 * stained (but not yet coverslipped) still looked "open", and samples moved into
 * staining afterwards were loaded into it — with no way to pull them back apart.
 *
 * Live databases therefore carry these contaminated racks already. The split is
 * unambiguous because the checkbox stamps its members at tick time: within one
 * rack, a slide whose own `stage_stained_at` is NULL while the RACK's is set can
 * only have arrived after the tick. Those late arrivals move to a fresh loading
 * rack per (agent, source rack), preserving the original rack's real members and
 * their timestamps.
 *
 * Purely corrective and idempotent: no schema change, guarded by a schema_meta
 * marker that rides with the image (so reverting an old backup re-repairs it,
 * and an already-repaired image is left alone).
 */
async function splitContaminatedStainRacks(db: Database): Promise<void> {
  // This runs inside getDb(), so an unexpected image (one predating the
  // agent-scoped rack columns, say) must not stop the app from opening at all.
  // The repair is corrective, not load-bearing — skip it and carry on.
  try {
    await splitContaminatedStainRacksInner(db);
  } catch (error) {
    console.warn("Skipped the #81 stain-rack repair on this database image:", error);
  }
}

async function splitContaminatedStainRacksInner(db: Database): Promise<void> {
  const done = await db.select<Array<{ value: string }>>(
    `SELECT value FROM schema_meta WHERE key = 'stain_racks_split_81'`,
  );
  if (done[0]?.value === "1") return;

  // Racks holding a MIX of worked and unworked slides.
  //
  // Keyed off the SLIDES, not the stack columns: the cut-group drawer's
  // checkboxes stamp slides without touching slide_stacks, so a rack
  // contaminated through that path has all-NULL stack columns and the original
  // stack-column condition skipped it entirely. Coverslipped-only contamination
  // was missed for the same reason.
  const contaminated = await db.select<Array<{ id: number; assay_type: string; assay_name: string }>>(
    `SELECT ss.id, ss.assay_type, ss.assay_name
       FROM slide_stacks ss
      WHERE ss.kind = 'stain' AND ss.closed_at IS NULL
        AND ss.current_stage = 'stain_requested'
        AND EXISTS (
          SELECT 1 FROM slides w
           WHERE w.stack_id = ss.id AND w.purpose = 'stain'
             AND (w.stage_stained_at IS NOT NULL
               OR w.stage_refrax_at IS NOT NULL
               OR w.stage_coverslipped_at IS NOT NULL
               OR w.stage_dried_at IS NOT NULL)
        )
        AND EXISTS (
          SELECT 1 FROM slides sl
           WHERE sl.stack_id = ss.id AND sl.purpose = 'stain'
             AND sl.stage_stained_at IS NULL
             AND sl.stage_refrax_at IS NULL
             AND sl.stage_coverslipped_at IS NULL
             AND sl.stage_dried_at IS NULL
        )`,
  );

  let unrepaired = 0;
  for (const rack of contaminated) {
    // The late arrivals: members with NO substage work of their own.
    const strays = await db.select<Array<{ id: number }>>(
      `SELECT id FROM slides
        WHERE stack_id = ? AND purpose = 'stain'
          AND stage_stained_at IS NULL
          AND stage_refrax_at IS NULL
          AND stage_coverslipped_at IS NULL
          AND stage_dried_at IS NULL`,
      [rack.id],
    );
    if (strays.length === 0) continue;
    const result = await db.execute(
      `INSERT INTO slide_stacks
        (kind, assay_type, assay_name, sample_id, current_stage, stage_stain_requested_at)
       VALUES ('stain', ?, ?, NULL, 'stain_requested', ?)`,
      [rack.assay_type, rack.assay_name, nowTimestamp()],
    );
    if (result.lastInsertId == null) {
      // Could not mint the replacement rack — leave this one contaminated AND
      // leave the marker unwritten so the next open tries again.
      unrepaired += 1;
      continue;
    }
    for (const stray of strays) {
      await db.execute(`UPDATE slides SET stack_id = ? WHERE id = ?`, [result.lastInsertId, stray.id]);
    }
  }

  // Only claim the repair is done if it actually completed. Writing the marker
  // unconditionally meant a database this failed on never got a second chance.
  if (unrepaired > 0) {
    console.warn(`#81 repair left ${unrepaired} rack(s) unsplit; will retry on next open.`);
    return;
  }
  await db.execute(
    `INSERT INTO schema_meta (key, value) VALUES ('stain_racks_split_81', '1')
       ON CONFLICT(key) DO UPDATE SET value = '1'`,
  );
}

/**
 * One-time removal of the retired "Dried" protocol step from checklist runs that
 * already exist (#80).
 *
 * `ensureChecklist` REUSES a run keyed on (scope, stage_key), so shortening the
 * label list only affected runs created after the upgrade. Any rack whose
 * checklist existed before it kept a required third item and read "0/3" — the
 * technician could tick Stained and Coverslipped and the rack still would not
 * reach Ready for Imaging, because `checklistComplete` counted the Dried item as
 * outstanding. Those are precisely the racks that were mid-protocol on upgrade
 * day.
 *
 * Deleting the item preserves the progress already recorded on the other two
 * steps. A rack that was waiting ONLY on drying becomes fully complete; it
 * advances the next time any step is toggled.
 */
async function retireDryingChecklistStep(db: Database): Promise<void> {
  try {
    const done = await db.select<Array<{ value: string }>>(
      `SELECT value FROM schema_meta WHERE key = 'drying_step_retired_80'`,
    );
    if (done[0]?.value === "1") return;
    await db.execute(
      `DELETE FROM checklist_items
        WHERE label = 'Dried'
          AND checklist_run_id IN (
            SELECT id FROM checklist_runs WHERE stage_key LIKE '%_workflow_v%'
          )`,
    );
    await db.execute(
      `INSERT INTO schema_meta (key, value) VALUES ('drying_step_retired_80', '1')
         ON CONFLICT(key) DO UPDATE SET value = '1'`,
    );
  } catch (error) {
    console.warn("Skipped retiring the drying checklist step on this image:", error);
  }
}

async function ensureColumn(
  db: Database,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  const cols = await db.select<Array<{ name: string }>>(`PRAGMA table_info(${table})`);
  if (cols.some((c) => c.name === column)) return;
  await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * Absolute path of the live SQLite file, asked of SQLite itself so we never
 * hardcode the tauri-plugin-sql storage dir. The workstation reads this path
 * to publish a snapshot; the viewer overwrites it when swapping one in.
 */
export async function getDbFilePath(): Promise<string> {
  const db = await getDb();
  const rows = await db.select<Array<{ file: string }>>(
    `SELECT file FROM pragma_database_list WHERE name = 'main'`,
  );
  const file = rows[0]?.file;
  if (!file) throw new Error("Could not resolve the database file path.");
  return file;
}

/**
 * Close the pooled connection and drop the memoized promise so the next
 * getDb() reopens the file. The viewer calls this before overwriting the
 * SQLite file with a downloaded snapshot, then re-opens against the new bytes.
 */
export async function resetDb(): Promise<void> {
  if (!dbPromise) return;
  try {
    const db = await dbPromise;
    await db.close();
  } catch {
    // Best-effort: even if close fails, drop the handle so we reopen fresh.
  }
  dbPromise = null;
}

// ---- Whole-database snapshots (undo/redo) -----------------------------------

/**
 * A snapshot is the raw bytes of the entire SQLite database file — a complete,
 * point-in-time IMAGE of every table. Undo/redo simply swap one of these images
 * back in wholesale: there is nothing to keep in sync — no per-row dump, no
 * topological ordering, no trigger re-firing on restore, no exclude list to
 * drift. The database is the single source of truth and the UI is a pure
 * reflection of it (React Query refetches after a restore), so "undo" is exactly
 * "revert to a previous instance of the database" and nothing more.
 */
export type DbImage = Uint8Array;

/**
 * Capture the current database as a byte image. We checkpoint the WAL into the
 * main file first so the on-disk image is complete — the -wal sidecar holding
 * un-checkpointed writes is exactly what made naive file copies lossy before.
 * Databases not in WAL mode simply no-op the checkpoint.
 */
export async function snapshotDb(): Promise<DbImage> {
  const db = await getDb();
  try {
    await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Not in WAL mode (or checkpoint unsupported): the main file is already current.
  }
  const path = await getDbFilePath();
  const bytes = await invoke<number[]>("read_file", { path });
  return Uint8Array.from(bytes);
}

/**
 * Restore a database image: close the live connection, overwrite the SQLite file
 * with the snapshot bytes, then reopen against them. These are the exact
 * mechanics the sync viewer already uses to swap in a downloaded snapshot —
 * proven, WAL-safe (the closed connection has no dirty -wal), and atomic from
 * the app's point of view. Callers refetch afterwards.
 */
export async function restoreDb(image: DbImage): Promise<void> {
  const path = await getDbFilePath(); // resolve while the connection is still open
  await resetDb(); // close + drop the pooled handle so the file is unlocked
  await invoke("save_file", { path, contents: Array.from(image) });
  await getDb(); // reopen eagerly so callers see a ready connection
}

/**
 * Restore a database image but keep the SESSION/CONFIG state (the user directory
 * and app_settings, including who is signed in). Those are not undoable workflow
 * data — rewinding them would delete lab users added mid-session or silently
 * change the signed-in user (#1). Users are only ever added or toggled, so the
 * live set is always a superset by id; re-applying it with upserts (no deletes)
 * keeps every foreign-key reference valid.
 */
export async function restoreDbPreservingSession(image: DbImage): Promise<void> {
  const live = await getDb();
  const users = await live.select<
    Array<{ id: number; name: string; initials: string; is_active: number; created_at: string }>
  >(`SELECT id, name, initials, is_active, created_at FROM users`);
  const settings = await live.select<Array<{ key: string; value: string }>>(
    `SELECT key, value FROM app_settings`,
  );

  await restoreDb(image);

  const db = await getDb();
  for (const u of users) {
    await db.execute(
      `INSERT INTO users (id, name, initials, is_active, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, initials = excluded.initials, is_active = excluded.is_active`,
      [u.id, u.name, u.initials, u.is_active, u.created_at],
    );
  }
  for (const s of settings) {
    await db.execute(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [s.key, s.value],
    );
  }
}

// ---- Workstation settings (#92) ---------------------------------------------

/**
 * Read the configurable defaults. Missing keys fall back, so this works against
 * every database written before the settings dialogue existed — which is all of
 * them.
 */
export async function getAppSettings(): Promise<AppSettings> {
  const db = await getDb();
  const rows = await db.select<Array<{ key: string; value: string }>>(
    `SELECT key, value FROM app_settings`,
  );
  return parseSettings(rows);
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  const db = await getDb();
  for (const row of settingsToRows(settings)) {
    await db.execute(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [row.key, row.value],
    );
  }
}

// ---- Projects ---------------------------------------------------------------

export async function listProjects(activeOnly = false): Promise<Project[]> {
  const db = await getDb();
  const where = activeOnly ? "WHERE p.is_active = 1" : "";
  return db.select<Project[]>(
    `SELECT p.*, COUNT(s.id) AS sample_count
       FROM projects p
       LEFT JOIN samples s ON s.project_id = p.id
       ${where}
      GROUP BY p.id
      ORDER BY p.is_active DESC, p.code COLLATE NOCASE, p.name COLLATE NOCASE`,
  );
}

export async function addProject(input: {
  code: string;
  name: string;
  team_lead: string;
  is_active: boolean;
  lead_user_id: number;
}): Promise<number> {
  const db = await getDb();
  const res = await db.execute(
    `INSERT INTO projects (code, name, team_lead, is_active, lead_user_id) VALUES (?, ?, ?, ?, ?)`,
    [input.code.trim().toUpperCase(), input.name.trim(), input.team_lead.trim(), input.is_active ? 1 : 0, input.lead_user_id],
  );
  return res.lastInsertId ?? 0;
}

// ---- Users and current session ---------------------------------------------

export async function listUsers(activeOnly = false): Promise<LabUser[]> {
  const db = await getDb();
  return db.select<LabUser[]>(
    `SELECT * FROM users ${activeOnly ? "WHERE is_active = 1" : ""}
      ORDER BY is_active DESC, name COLLATE NOCASE`,
  );
}

// The three session writes (#128). Each one is how somebody gets THROUGH the
// signed-out gate, so none of them can be behind it.
export async function addUser(input: { name: string; initials: string }): Promise<number> {
  const db = await getDb();
  const res = await sessionExecute(
    db,
    `INSERT INTO users (name, initials) VALUES (?, ?)`,
    [input.name.trim(), input.initials.trim().toUpperCase()],
  );
  return res.lastInsertId ?? 0;
}

export async function setUserActive(userId: number, isActive: boolean): Promise<void> {
  const db = await getDb();
  await sessionExecute(db, `UPDATE users SET is_active = ? WHERE id = ?`, [
    isActive ? 1 : 0,
    userId,
  ]);
  if (!isActive) {
    await sessionExecute(
      db,
      `UPDATE app_settings SET value = '' WHERE key = 'active_user_id' AND value = ?`,
      [String(userId)],
    );
  }
}

export async function getActiveUser(): Promise<LabUser | null> {
  const db = await getDb();
  const rows = await db.select<LabUser[]>(
    `SELECT u.* FROM users u
      JOIN app_settings s ON s.key = 'active_user_id' AND CAST(s.value AS INTEGER) = u.id
     WHERE u.is_active = 1 LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function setActiveUser(userId: number | null): Promise<void> {
  const db = await getDb();
  if (userId !== null) {
    const rows = await db.select<Array<{ id: number }>>(
      `SELECT id FROM users WHERE id = ? AND is_active = 1`,
      [userId],
    );
    if (!rows.length) throw new Error("That user is no longer active.");
  }
  await sessionExecute(
    db,
    `INSERT INTO app_settings (key, value) VALUES ('active_user_id', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [userId === null ? "" : String(userId)],
  );
}

export async function setProjectActive(projectId: number, isActive: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE projects SET is_active = ? WHERE id = ?`, [isActive ? 1 : 0, projectId]);
}

/**
 * Update a project, carrying a CODE change through to everything named after it
 * (#106).
 *
 * A sample's code is `<PROJECT>-NNNN` and a slide's is `<PROJECT>-NNNN-X`, both
 * stored as text rather than derived at read time. Renaming the project used to
 * touch only the projects row, so every existing block and slide kept the old
 * acronym for ever — the log then showed two prefixes for one project and no
 * way to tell they were the same. A rename either means something or it does
 * not; if it does, it has to reach the things it named.
 *
 * The rewrite is a prefix swap up to the first hyphen, not a re-mint: numbers,
 * letters and ordering are untouched, so nothing is renumbered and no code that
 * has been written on a physical slide changes its meaning. That is also why
 * zero-padded legacy codes (#87) survive it — `SUBSTR` keeps whatever followed
 * the old prefix exactly as it was.
 */
export async function updateProject(
  projectId: number,
  input: { code: string; name: string; team_lead: string; lead_user_id: number },
): Promise<void> {
  const db = await getDb();
  const newCode = input.code.trim().toUpperCase();
  const rows = await db.select<Array<{ code: string }>>(
    `SELECT code FROM projects WHERE id = ?`,
    [projectId],
  );
  const oldCode = rows[0]?.code ?? "";

  await db.execute(
    `UPDATE projects SET code = ?, name = ?, team_lead = ?, lead_user_id = ? WHERE id = ?`,
    [newCode, input.name.trim(), input.team_lead.trim(), input.lead_user_id, projectId],
  );

  if (!oldCode || oldCode === newCode) return;
  const like = `${oldCode}-%`;
  const keep = oldCode.length + 1; // 1-indexed: first char AFTER the old prefix

  // Slides first: their WHERE clause reaches them through their sample's
  // project, and the samples' own codes are about to stop matching the old
  // prefix. Order matters only for readability here — the predicate is on
  // project_id, not on the code — but keeping it means the two statements can
  // never be reordered into a bug.
  await db.execute(
    `UPDATE slides SET slide_code = ? || SUBSTR(slide_code, ?)
      WHERE slide_code LIKE ?
        AND section_request_id IN (
          SELECT sr.id FROM section_requests sr
            JOIN samples s ON s.id = sr.sample_id
           WHERE s.project_id = ?
        )`,
    [newCode, keep, like, projectId],
  );
  await db.execute(
    `UPDATE samples SET sample_code = ? || SUBSTR(sample_code, ?)
      WHERE project_id = ? AND sample_code LIKE ?`,
    [newCode, keep, projectId, like],
  );
  // Outstanding stain requests address blocks by code, so they would otherwise
  // point at a block that no longer answers to that name.
  await db.execute(
    `UPDATE stain_requests SET sample_code = ? || SUBSTR(sample_code, ?)
      WHERE sample_code LIKE ?`,
    [newCode, keep, like],
  );
}

/** Permanently delete a project — only when it holds no samples, so no sample,
 *  slide, or workflow record is ever orphaned. */
export async function deleteProject(projectId: number): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Array<{ n: number }>>(
    `SELECT COUNT(*) AS n FROM samples WHERE project_id = ?`,
    [projectId],
  );
  if ((rows[0]?.n ?? 0) > 0) {
    throw new Error("This project still has samples. Deactivate it instead, or remove its samples first.");
  }
  await db.execute(`DELETE FROM projects WHERE id = ?`, [projectId]);
}

// ---- Sample IDs -------------------------------------------------------------

async function nextSampleNumber(projectId: number): Promise<number> {
  const db = await getDb();
  const rows = await db.select<Array<{ next_number: number }>>(
    `SELECT COALESCE(MAX(project_sample_number), 0) + 1 AS next_number
       FROM samples WHERE project_id = ?`,
    [projectId],
  );
  return rows[0]?.next_number ?? 1;
}

export async function nextSampleCode(projectId: number, projectCode: string): Promise<string> {
  const n = await nextSampleNumber(projectId);
  return formatSampleCode(projectCode, n);
}

// ---- Samples ----------------------------------------------------------------

export async function addSample(input: NewSampleInput, projectCode: string): Promise<number> {
  // #88 — a sample without a description is unidentifiable at the bench and
  // nobody ever goes back to fill one in, so the batch entered last month stays
  // anonymous for good. Enforced HERE, at the one place samples are created,
  // rather than only in the dialog: the dialog's Create button is the thing a
  // future entry point would forget to reproduce, and this is the invariant the
  // 0.7.2 review said to fix at the choke point rather than the call site.
  //
  // Only NEW samples. Existing blank descriptions are left alone — they are
  // editable from the Logs row and the sample drawer (#79), and refusing to open
  // a database because of a row written last year would be absurd.
  if (!input.sample_description.trim()) {
    throw new Error("Every sample needs a description.");
  }
  const db = await getDb();
  const timestamp = nowTimestamp();
  const number = await nextSampleNumber(input.project_id);
  const code = formatSampleCode(projectCode, number);

  const preselected = input.preselected_stains?.length
    ? JSON.stringify(input.preselected_stains)
    : "";
  const res = await db.execute(
    `INSERT INTO samples (
        project_id, project_sample_number, sample_code, sample_description, date_added,
        processing_type, fixative_agent, needs_decalcification, cut_notes, slide_notes,
        stains, preselected_stains, overall_notes, current_stage, stage_received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`,
    [
      input.project_id,
      number,
      code,
      input.sample_description.trim(),
      todayIso(),
      input.processing_type,
      input.fixative_agent,
      input.needs_decalcification ? 1 : 0,
      input.cut_notes.trim(),
      input.slide_notes.trim(),
      input.stains.trim(),
      preselected,
      input.overall_notes.trim(),
      timestamp,
    ],
  );
  return res.lastInsertId ?? 0;
}

// changeSampleProject() is GONE (#99). Moving a block between projects re-numbered
// it and rewrote every slide label; the dropdown that drove it is removed and the
// capability with it, so a block's identity is fixed at intake. Reverses #60.

export async function listOpenSamples(): Promise<Sample[]> {
  const db = await getDb();
  // The needs-stain flag is simply the block's OUTSTANDING stain requests
  // (`preselected_stains`, treated as a multiset): agents chosen at creation or
  // requested since, minus the ones already fulfilled by a cut (trimmed in
  // createSectionRequests). A duplicate request queues a second slide (#62/#66),
  // and re-requesting an already-produced agent flags the block again (#41).
  const rows = await db.select<Array<Sample>>(
    `SELECT s.*, p.code AS project_code, p.name AS project_name, p.team_lead AS team_lead,
            -- Is there a cutting plan waiting to be cut (#110, corrected #112)?
            --
            -- TWO conditions, and both are load-bearing:
            --  · the event, because every block is auto-seeded a plan the
            --    moment it reaches Embedded Inventory. Only a deliberate save
            --    writes a sectioning_plan timeline event, so without this the
            --    whole column would be flagged and the flag would mean nothing.
            --  · the COLUMN still holding a plan, because createSectionRequests
            --    clears sectioning_plan once the cut is sent. The first version
            --    of this tested the event alone — and an event is never
            --    cleared, so a block stayed flagged for ever after one saved
            --    plan, cut or not. That is #112: "already has a stack with the
            --    requested stain in the needs sectioning stage".
            (
              s.sectioning_plan <> '' AND EXISTS (
                SELECT 1 FROM sample_timeline_events e
                 WHERE e.sample_id = s.id AND e.event_type = 'sectioning_plan'
              )
            ) AS plan_saved
       FROM samples s
       JOIN projects p ON p.id = s.project_id
      WHERE p.is_active = 1 AND s.current_stage != 'analyzed' AND s.block_exhausted = 0
        AND s.current_stage != 'removed' -- a removed block leaves the board (#96)
        AND s.archived_at IS NULL
      ORDER BY s.is_priority DESC, s.prioritized_at DESC, s.date_added ASC, s.id ASC`,
  );
  return rows.map((sample) => {
    const pending = parsePreselectedStains(sample.preselected_stains);
    return { ...sample, pending_stains: pending.length ? JSON.stringify(pending) : "" } as Sample;
  });
}

export async function updateSampleStage(sampleId: number, stageKey: string): Promise<void> {
  const db = await getDb();
  const column = STAGE_COLUMNS[stageKey];
  if (!column) throw new Error(`Unknown stage: ${stageKey}`);
  const timestamp = nowTimestamp();
  await db.execute(
    `UPDATE samples
        SET current_stage = ?, ${column} = COALESCE(${column}, ?)
      WHERE id = ?`,
    [stageKey, timestamp, sampleId],
  );
  // On reaching Embedded Inventory, auto-fill the sectioning plan from the
  // stains chosen at creation so the block is a one-click send (issues #1, #4).
  if (stageKey === "embedded") await ensureAutoSectioningPlan(sampleId);
}

/** Seed the sectioning plan for an embedded sample from its preselected stains,
 *  unless a plan already exists. */
export async function ensureAutoSectioningPlan(sampleId: number): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Array<{ preselected_stains: string; sectioning_plan: string }>>(
    `SELECT preselected_stains, sectioning_plan FROM samples WHERE id = ?`,
    [sampleId],
  );
  const row = rows[0];
  if (!row || row.sectioning_plan) return;
  // Every newly embedded block gets at least the configured total with the
  // configured minimum extras (issue #4, counts configurable since #92); with no
  // preselected stains that is simply that many extras.
  const preselected = parsePreselectedStains(row.preselected_stains);
  const plan = buildAutoSectioningPlan(preselected, await getAppSettings());
  await db.execute(`UPDATE samples SET sectioning_plan = ? WHERE id = ?`, [JSON.stringify(plan), sampleId]);
}

/**
 * Move a sample backward to an earlier stage: set current_stage and clear the
 * timestamps for every stage after the target (reverting timeline + checklist
 * events the user is dragging back past). The target stage's own timestamp is kept.
 */
export async function revertToStage(sampleId: number, stageKey: string): Promise<void> {
  const db = await getDb();
  const targetOrder = STAGE_ORDER[stageKey];
  if (targetOrder === undefined) throw new Error(`Unknown stage: ${stageKey}`);
  const clearColumns = STAGES.filter((s) => STAGE_ORDER[s.key] > targetOrder).map((s) => s.column);
  const setClause = ["current_stage = ?", ...clearColumns.map((c) => `${c} = NULL`)].join(", ");
  await db.execute(`UPDATE samples SET ${setClause} WHERE id = ?`, [stageKey, sampleId]);
}

/** Directly set (or clear, with null) a single stage-timestamp column. */
export async function setStageTimestamp(
  sampleId: number,
  column: string,
  value: string | null,
): Promise<void> {
  if (!STAGE_COLUMN_SET.has(column)) throw new Error(`Illegal column: ${column}`);
  const db = await getDb();
  await db.execute(`UPDATE samples SET ${column} = ? WHERE id = ?`, [value, sampleId]);
}

/** Record the processor-pickup time when a sample leaves the pickup queue. */
export async function setPickedUp(sampleId: number, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE samples SET stage_picked_up_at = COALESCE(stage_picked_up_at, ?) WHERE id = ?`,
    [value, sampleId],
  );
}

export async function updateSampleDetails(
  sampleId: number,
  input: Omit<NewSampleInput, "project_id">,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE samples
        SET sample_description = ?, processing_type = ?, fixative_agent = ?,
            needs_decalcification = ?, cut_notes = ?, slide_notes = ?, stains = ?, overall_notes = ?
      WHERE id = ?`,
    [
      input.sample_description.trim(),
      input.processing_type,
      input.fixative_agent,
      input.needs_decalcification ? 1 : 0,
      input.cut_notes.trim(),
      input.slide_notes.trim(),
      input.stains.trim(),
      input.overall_notes.trim(),
      sampleId,
    ],
  );
}

// deleteSample() is GONE (#83). Deleting a sample cascaded through
// section_requests into slides, so one click erased a block, every cut group it
// ever had, and every slide those groups produced — the single most destructive
// operation in a product whose job is to be a record. There is no non-destructive
// rewrite of it either, because "the sample never existed" is not a state this
// app should be able to reach. `setSampleArchived` is the replacement and always
// was: it clears the board, hides the row from the Logs by default, renumbers
// nothing, and restores whole.

export async function getSample(sampleId: number): Promise<Sample | null> {
  const db = await getDb();
  const rows = await db.select<Sample[]>(`SELECT * FROM samples WHERE id = ?`, [sampleId]);
  return rows[0] ?? null;
}

// Columns that a snapshot restore is allowed to overwrite (everything mutable).
const RESTORE_COLUMNS = [
  "project_sample_number", "sample_code", "sample_description", "date_added",
  "processing_type", "fixative_agent", "needs_decalcification", "cut_notes",
  "slide_notes", "stains", "preselected_stains", "overall_notes", "sectioning_plan", "current_stage",
  "stage_received_at", "decalc_completed_at", "fixative_placed_at", "fixative_removed_at",
  "ethanol_placed_at", "processing_started_at", "stage_processed_at", "stage_needs_embedding_at",
  "stage_embedded_at", "stage_needs_sectioning_at", "stage_sectioned_at", "stage_stain_requested_at",
  "stage_stained_at", "stage_deparaffinized_at", "stage_ihc_at", "stage_pictures_taken_at",
  "stage_analyzed_at", "stage_picked_up_at", "block_exhausted",
  "is_priority", "prioritized_at",
] as const;

export async function setSamplePriority(sampleId: number, priority: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE samples
        SET is_priority = ?, prioritized_at = CASE WHEN ? = 1 THEN ? ELSE NULL END
      WHERE id = ?`,
    [priority ? 1 : 0, priority ? 1 : 0, nowTimestamp(), sampleId],
  );
}

/** Restore a previously captured sample snapshot (for undo of moves/edits). */
export async function restoreSample(snapshot: Sample): Promise<void> {
  const db = await getDb();
  const assignments = RESTORE_COLUMNS.map((c) => `${c} = ?`).join(", ");
  const values = RESTORE_COLUMNS.map((c) => (snapshot as unknown as Record<string, unknown>)[c]);
  await db.execute(`UPDATE samples SET ${assignments} WHERE id = ?`, [...values, snapshot.id]);
}

/** Re-insert a deleted sample with its original id (for undo of delete). */
export async function reinsertSample(snapshot: Sample): Promise<void> {
  const db = await getDb();
  const cols = ["id", "project_id", ...RESTORE_COLUMNS, "created_at"];
  const placeholders = cols.map(() => "?").join(", ");
  const values = cols.map((c) => (snapshot as unknown as Record<string, unknown>)[c]);
  await db.execute(`INSERT INTO samples (${cols.join(", ")}) VALUES (${placeholders})`, values);
}

export async function updateSectioningPlan(
  sampleId: number,
  plan: Array<{ duplicates: number; stains?: string }>,
): Promise<void> {
  const db = await getDb();
  const existing = await db.select<Array<{ sectioning_plan: string }>>(
    `SELECT sectioning_plan FROM samples WHERE id = ?`,
    [sampleId],
  );
  const previous = existing[0]?.sectioning_plan ?? "";
  const next = JSON.stringify(plan);
  if (previous === next) return;
  await db.execute(`UPDATE samples SET sectioning_plan = ? WHERE id = ?`, [
    next,
    sampleId,
  ]);
  const summary = plan.length
    ? `Sectioning plan ${previous ? "updated" : "created"}: ${plan
        .map((row) => `×${row.duplicates}${row.stains ? ` (${row.stains})` : ""}`)
        .join(", ")}`
    : "Sectioning plan cleared";
  await db.execute(
    `INSERT INTO sample_timeline_events
      (sample_id, user_id, event_type, summary, details, created_at)
     VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
             'sectioning_plan', ?, ?, ?)`,
    [sampleId, summary, JSON.stringify({ before: previous, after: next }), nowTimestamp()],
  );
}

/**
 * The change manifest: who did what, most recent first (#77).
 *
 * `audit_events` has been populated by database triggers since 0010 and carries
 * `user_id` on every row — but nothing in the app ever SELECTed from it, so the
 * question the issue actually asks ("who made what changes") had no answer
 * anywhere in the product. The user name is joined here rather than stored on
 * the row, so renaming a user corrects the history rather than forking it.
 * Rows written while nobody was signed in are surfaced honestly as "Unsigned".
 */
export async function listAuditEvents(limit = 500): Promise<AuditEvent[]> {
  const db = await getDb();
  return db.select<AuditEvent[]>(
    `SELECT ae.id, ae.action, ae.entity_type, ae.entity_id, ae.summary, ae.created_at,
            ae.user_id,
            COALESCE(NULLIF(u.name, ''), '') AS user_name,
            COALESCE(s.sample_code, '') AS sample_code,
            COALESCE(p.code, '') AS project_code
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.user_id
       LEFT JOIN samples s ON s.id = ae.sample_id
       LEFT JOIN projects p ON p.id = s.project_id
      ORDER BY ae.created_at DESC, ae.id DESC
      LIMIT ?`,
    [limit],
  );
}

export interface SlideRemoval {
  slide_id: number;
  reason: string;
  at: string;
  user_name: string;
}

export interface SampleRemoval {
  sample_id: number;
  reason: string;
  at: string;
  user_name: string;
}

/**
 * Why each removed slide was removed, keyed by slide id (#83).
 *
 * Read from the sample timeline rather than the slide row: the reason belongs to
 * the *event*, and putting it there is what let removal ship without a schema
 * change. Rows whose `details` predate the JSON shape, or that were written by a
 * build that stored bare text, degrade to that text as the reason rather than
 * being dropped — a removal with an unparseable reason is still a removal, and
 * losing the flag would be worse than losing the wording.
 */
export async function listSlideRemovals(): Promise<SlideRemoval[]> {
  const db = await getDb();
  const rows = await db.select<Array<{ details: string; created_at: string; user_name: string | null }>>(
    `SELECT e.details, e.created_at, u.name AS user_name
       FROM sample_timeline_events e
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.event_type = 'slide_removed'
      ORDER BY e.created_at DESC, e.id DESC`,
  );
  const out: SlideRemoval[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.details ?? "") as { slide_id?: number; reason?: string };
      if (typeof parsed?.slide_id !== "number") continue;
      out.push({
        slide_id: parsed.slide_id,
        reason: parsed.reason?.trim() || "No reason recorded.",
        at: row.created_at,
        user_name: row.user_name ?? "",
      });
    } catch {
      continue;
    }
  }
  return out;
}

/** Why each removed BLOCK was removed, keyed by sample id (#96). Same shape and
 *  same tolerance as `listSlideRemovals` — see its note. */
export async function listSampleRemovals(): Promise<SampleRemoval[]> {
  const db = await getDb();
  const rows = await db.select<Array<{ sample_id: number; details: string; created_at: string; user_name: string | null }>>(
    `SELECT e.sample_id, e.details, e.created_at, u.name AS user_name
       FROM sample_timeline_events e
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.event_type = 'sample_removed'
      ORDER BY e.created_at DESC, e.id DESC`,
  );
  const out: SampleRemoval[] = [];
  for (const row of rows) {
    let reason = "";
    try {
      const parsed = JSON.parse(row.details ?? "") as { reason?: string };
      reason = parsed?.reason?.trim() ?? "";
    } catch {
      reason = (row.details ?? "").trim();
    }
    out.push({
      sample_id: row.sample_id,
      reason: reason || "No reason recorded.",
      at: row.created_at,
      user_name: row.user_name ?? "",
    });
  }
  return out;
}

export async function listSampleTimelineEvents(sampleId: number): Promise<SampleTimelineEvent[]> {
  const db = await getDb();
  return db.select<SampleTimelineEvent[]>(
    `SELECT e.*, u.name AS user_name
       FROM sample_timeline_events e
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.sample_id = ?
      ORDER BY e.created_at DESC, e.id DESC`,
    [sampleId],
  );
}

// ---- Export queries (all data, not just open samples) -----------------------

export async function listAllSamples(): Promise<Sample[]> {
  const db = await getDb();
  return db.select<Sample[]>(
    `SELECT s.*, p.code AS project_code, p.name AS project_name, p.team_lead AS team_lead
       FROM samples s JOIN projects p ON p.id = s.project_id
      ORDER BY p.code, s.project_sample_number`,
  );
}

export async function listAllSectionRequests(): Promise<SectionRequest[]> {
  const db = await getDb();
  return db.select<SectionRequest[]>(
    `SELECT sr.*, s.sample_code AS parent_code, s.sample_description AS parent_description,
            s.stains AS parent_stains, p.code AS project_code, p.name AS project_name
       FROM section_requests sr
       JOIN samples s ON s.id = sr.sample_id
       JOIN projects p ON p.id = s.project_id
      ORDER BY p.code, s.project_sample_number, sr.id`,
  );
}

export async function listAllSlides(): Promise<Slide[]> {
  const db = await getDb();
  return db.select<Slide[]>(
    `SELECT sl.*, s.sample_code AS parent_code,
            p.code AS project_code,
            -- The cut group's stage: a slide whose group is still in
            -- needs_sectioning has not been cut, whatever stage_cut_at says on
            -- rows written by builds that stamped it at creation (#95).
            sr.current_stage AS section_stage
       FROM slides sl
       JOIN section_requests sr ON sr.id = sl.section_request_id
       JOIN samples s ON s.id = sr.sample_id
       JOIN projects p ON p.id = s.project_id
      -- slide_ordinal is a PER-SECTION counter that restarts at 1 for every cut
      -- group, so a twice-cut block came out A, E, B, F, C, G here (#75). The
      -- Logs view sorts client-side, but this query also feeds the Excel export
      -- and the auto-synced Slide Status sheet, which had no such correction.
      -- Order by the cut group first, then position within it.
      ORDER BY p.code, s.project_sample_number, sl.section_request_id, sl.slide_ordinal`,
  );
}

/**
 * Every live slide belonging to one block, newest cut group last (#101).
 *
 * `section_stage` rides along for the same reason `listAllSlides` carries it: a
 * slide whose group is still queued for sectioning has not been cut, whatever
 * its own stage says (#95), and the drawer has to say "awaiting cut" rather than
 * claim it is in staining.
 */
export async function listSlidesForSample(sampleId: number): Promise<Slide[]> {
  const db = await getDb();
  return db.select<Slide[]>(
    `SELECT sl.*, sr.current_stage AS section_stage
       FROM slides sl
       JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sr.sample_id = ? AND sl.current_stage != 'removed'
      ORDER BY sl.section_request_id, sl.slide_ordinal`,
    [sampleId],
  );
}

/**
 * Archive / restore a sample (#74). Archiving only sets a timestamp — nothing is
 * deleted and no code is reissued, so an archived sample can come back exactly
 * as it was. `listOpenSamples` hides archived blocks from the board; the Logs
 * view hides them by default behind a "show archived" toggle.
 */
export async function setSampleArchived(sampleId: number, archived: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE samples SET archived_at = ? WHERE id = ?`, [
    archived ? nowTimestamp() : null,
    sampleId,
  ]);
}

export async function setSamplesArchived(sampleIds: number[], archived: boolean): Promise<void> {
  for (const id of sampleIds) await setSampleArchived(id, archived);
}

export async function setBlockExhausted(sampleId: number, exhausted: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE samples SET block_exhausted = ? WHERE id = ?`, [
    exhausted ? 1 : 0,
    sampleId,
  ]);
}

/** Free-text notes on a sample (the block's general notes) and on a slide. */
/**
 * Update only the description (#79). `updateSampleDetails` rewrites eight
 * columns from a whole NewSampleInput, which is the wrong shape for a plain text
 * field — it would write back whatever the caller happened to be holding for
 * fixative, notes and the rest. This touches the one column.
 */
export async function setSampleDescription(sampleId: number, description: string): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE samples SET sample_description = ? WHERE id = ?`, [
    description.trim(),
    sampleId,
  ]);
}

export async function setSampleNotes(sampleId: number, notes: string): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE samples SET overall_notes = ? WHERE id = ?`, [notes, sampleId]);
}

export async function setSlideNotes(slideId: number, notes: string): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE slides SET notes = ? WHERE id = ?`, [notes, slideId]);
}

/** Tag a set of slides as a depth grouping (#69): a shared label ("surface",
 *  "100um deep", …) plus an optional note. An empty label clears the tag. */
export async function setSlidesDepthTag(
  slideIds: number[],
  label: string,
  note: string,
): Promise<void> {
  if (slideIds.length === 0) return;
  const db = await getDb();
  const placeholders = slideIds.map(() => "?").join(", ");
  // Removed slides are excluded rather than rejected. Every sibling mutation
  // (setSlidePicturesTaken, reassignSlide, relabelSlideToSample, removeSlide)
  // refuses a removed slide outright, and this one silently retagged one — a
  // removed slide is the record of glass that is gone, so its depth can no
  // longer be established by anyone.
  //
  // Skipping rather than throwing because this is the only one of the five that
  // acts on a SELECTION: a technician tagging eleven slides, one of which was
  // broken last week, should get the ten tagged, not an error and nothing done.
  await db.execute(
    `UPDATE slides SET depth_label = ?, depth_note = ?
      WHERE id IN (${placeholders}) AND current_stage <> 'removed'`,
    [label.trim(), note.trim(), ...slideIds],
  );
}

// ---- Processing batches ----------------------------------------------------

function formatLocalTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export async function startProcessingBatch(input: {
  sampleIds: number[];
  processingType: "Short" | "Long";
  operatorName: string;
  startedAt: string;
  checklistLabels: string[];
  notes?: string;
}): Promise<number> {
  if (input.sampleIds.length === 0) throw new Error("Select at least one sample.");
  const db = await getDb();
  const placeholders = input.sampleIds.map(() => "?").join(", ");
  const samples = await db.select<Sample[]>(
    `SELECT * FROM samples WHERE id IN (${placeholders}) ORDER BY id`,
    input.sampleIds,
  );
  if (samples.length !== input.sampleIds.length) throw new Error("One or more samples no longer exist.");

  const incompatible = samples.filter((s) => s.processing_type !== input.processingType);
  if (incompatible.length > 0) {
    throw new Error(`Selected samples do not share the ${input.processingType} protocol.`);
  }
  const notReady = samples.filter(
    (s) =>
      (s.needs_decalcification === 1 && !s.decalc_completed_at) ||
      !s.fixative_placed_at ||
      !s.fixative_removed_at ||
      !s.ethanol_placed_at,
  );
  if (notReady.length > 0) {
    throw new Error(
      `Complete preprocessing first: ${notReady.map((s) => s.sample_code).join(", ")}`,
    );
  }

  // A sample already committed to a planned run must be confirmed there, not
  // started in a different batch (issues #4, #24).
  const planned = await db.select<Array<{ sample_code: string }>>(
    `SELECT s.sample_code
       FROM processing_batch_members pbm
       JOIN processing_batches pb ON pb.id = pbm.batch_id
       JOIN samples s ON s.id = pbm.sample_id
      WHERE pbm.sample_id IN (${placeholders}) AND pb.status = 'planned'`,
    input.sampleIds,
  );
  if (planned.length > 0) {
    throw new Error(
      `Already in a planned run — confirm that run instead: ${planned.map((r) => r.sample_code).join(", ")}`,
    );
  }

  // Running two batches at once is entirely the technician's call (issue #23):
  // there is no "processor busy" guard and no override prompt. A second (or
  // planned) run may start whenever the user says so — the app never blocks it.

  const started = parseTimestamp(input.startedAt) ?? new Date();
  const readyAt = new Date(
    started.getTime() + processingDurationHours(input.processingType) * 3600_000,
  );
  let batchId = 0;
  try {
    const batchResult = await db.execute(
      `INSERT INTO processing_batches
        (processing_type, operator_name, status, started_at, ready_at, notes)
       VALUES (?, ?, 'processing', ?, ?, ?)`,
      [
        input.processingType,
        input.operatorName.trim(),
        input.startedAt,
        formatLocalTimestamp(readyAt),
        input.notes?.trim() ?? "",
      ],
    );
    batchId = batchResult.lastInsertId ?? 0;
    for (const sample of samples) {
      await db.execute(
        `INSERT INTO processing_batch_members (batch_id, sample_id) VALUES (?, ?)`,
        [batchId, sample.id],
      );
    }
    await db.execute(
      `UPDATE samples
          SET current_stage = 'processing_started',
              processing_started_at = ?
        WHERE id IN (${placeholders})`,
      [input.startedAt, ...input.sampleIds],
    );

    const runResult = await db.execute(
      `INSERT INTO checklist_runs
        (scope_type, scope_id, stage_key, protocol_name, protocol_version, completed_at)
       VALUES ('processing_batch', ?, 'processing_started', ?, 1, ?)`,
      [batchId, `${input.processingType} processing`, input.startedAt],
    );
    const runId = runResult.lastInsertId ?? 0;
    for (let i = 0; i < input.checklistLabels.length; i += 1) {
      const label = input.checklistLabels[i];
      await db.execute(
        `INSERT INTO checklist_items
          (checklist_run_id, item_key, label, sort_order, is_required, is_complete,
           completed_by, completed_at)
         VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
        [runId, `start-${i + 1}`, label, i, input.operatorName.trim(), input.startedAt],
      );
    }
    return batchId;
  } catch (error) {
    // The Tauri SQL plugin dispatches execute calls through a connection pool,
    // so a manual BEGIN/COMMIT sequence is not guaranteed to stay on one
    // connection. Compensate for a partial batch instead of holding a pooled
    // SQLite write lock across calls.
    if (batchId > 0) {
      try {
        await db.execute(
          `DELETE FROM checklist_items
            WHERE checklist_run_id IN (
              SELECT id FROM checklist_runs
               WHERE scope_type = 'processing_batch' AND scope_id = ?
            )`,
          [batchId],
        );
        await db.execute(
          `DELETE FROM checklist_runs WHERE scope_type = 'processing_batch' AND scope_id = ?`,
          [batchId],
        );
        await db.execute(`DELETE FROM processing_batch_members WHERE batch_id = ?`, [batchId]);
        await db.execute(`DELETE FROM processing_batches WHERE id = ?`, [batchId]);
        for (const sample of samples) {
          await db.execute(
            `UPDATE samples SET current_stage = ?, processing_started_at = ? WHERE id = ?`,
            [sample.current_stage, sample.processing_started_at, sample.id],
          );
        }
      } catch {
        // Preserve and report the original operation error.
      }
    }
    throw error;
  }
}

/**
 * Schedule a processing run for a future start (issues #4, #24). The batch is
 * created with status 'planned'; its member samples stay in pre-processing until
 * the technician confirms the actual start via confirmProcessingBatchStart. No
 * concurrency guard applies — a planned run is not yet in the processor.
 */
export async function planProcessingBatch(input: {
  sampleIds: number[];
  processingType: "Short" | "Long";
  operatorName: string;
  plannedStartAt: string;
  notes?: string;
}): Promise<number> {
  if (input.sampleIds.length === 0) throw new Error("Select at least one sample.");
  const db = await getDb();
  const placeholders = input.sampleIds.map(() => "?").join(", ");
  const samples = await db.select<Sample[]>(
    `SELECT * FROM samples WHERE id IN (${placeholders}) ORDER BY id`,
    input.sampleIds,
  );
  if (samples.length !== input.sampleIds.length) throw new Error("One or more samples no longer exist.");

  const incompatible = samples.filter((s) => s.processing_type !== input.processingType);
  if (incompatible.length > 0) {
    throw new Error(`Selected samples do not share the ${input.processingType} protocol.`);
  }
  const notReady = samples.filter(
    (s) =>
      (s.needs_decalcification === 1 && !s.decalc_completed_at) ||
      !s.fixative_placed_at ||
      !s.fixative_removed_at ||
      !s.ethanol_placed_at,
  );
  if (notReady.length > 0) {
    throw new Error(
      `Complete preprocessing first: ${notReady.map((s) => s.sample_code).join(", ")}`,
    );
  }

  // A sample can only be committed to one open (planned or running) batch.
  const alreadyBatched = await db.select<Array<{ sample_code: string }>>(
    `SELECT s.sample_code
       FROM processing_batch_members pbm
       JOIN processing_batches pb ON pb.id = pbm.batch_id
       JOIN samples s ON s.id = pbm.sample_id
      WHERE pbm.sample_id IN (${placeholders})
        AND pb.status IN ('planned', 'processing')`,
    input.sampleIds,
  );
  if (alreadyBatched.length > 0) {
    throw new Error(
      `Already committed to a batch: ${alreadyBatched.map((r) => r.sample_code).join(", ")}`,
    );
  }

  const planned = parseTimestamp(input.plannedStartAt) ?? new Date();
  const readyAt = new Date(
    planned.getTime() + processingDurationHours(input.processingType) * 3600_000,
  );
  const batchResult = await db.execute(
    `INSERT INTO processing_batches
      (processing_type, operator_name, status, started_at, planned_start_at, ready_at, notes)
     VALUES (?, ?, 'planned', ?, ?, ?, ?)`,
    [
      input.processingType,
      input.operatorName.trim(),
      // started_at is NOT NULL; seed it with the planned time until confirmed.
      input.plannedStartAt,
      input.plannedStartAt,
      formatLocalTimestamp(readyAt),
      input.notes?.trim() ?? "",
    ],
  );
  const batchId = batchResult.lastInsertId ?? 0;
  for (const sample of samples) {
    await db.execute(
      `INSERT INTO processing_batch_members (batch_id, sample_id) VALUES (?, ?)`,
      [batchId, sample.id],
    );
  }
  return batchId;
}

/**
 * Confirm that a planned run actually started (issue #4). Transitions the batch
 * to 'processing', stamps the real start (defaulting to the planned time),
 * recomputes the ready time, and moves every member into the processor so the
 * countdown begins.
 */
export async function confirmProcessingBatchStart(
  batchId: number,
  actualStartedAt?: string,
): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Array<{ status: string; processing_type: string; planned_start_at: string | null }>>(
    `SELECT status, processing_type, planned_start_at FROM processing_batches WHERE id = ?`,
    [batchId],
  );
  const batch = rows[0];
  if (!batch) throw new Error("That processing batch no longer exists.");
  if (batch.status !== "planned") throw new Error("Only a planned run can be confirmed as started.");
  const startedAt = actualStartedAt ?? batch.planned_start_at ?? nowTimestamp();
  const started = parseTimestamp(startedAt) ?? new Date();
  const readyAt = new Date(
    started.getTime() + processingDurationHours(batch.processing_type) * 3600_000,
  );
  await db.execute(
    `UPDATE processing_batches
        SET status = 'processing', started_at = ?, ready_at = ?
      WHERE id = ?`,
    [startedAt, formatLocalTimestamp(readyAt), batchId],
  );
  await db.execute(
    `UPDATE samples
        SET current_stage = 'processing_started', processing_started_at = ?
      WHERE id IN (SELECT sample_id FROM processing_batch_members WHERE batch_id = ?)`,
    [startedAt, batchId],
  );
}

/** Return a batch to 'planned' (undo of confirmProcessingBatchStart). The
 * caller restores the member samples' snapshots separately. */
export async function revertProcessingBatchToPlanned(batchId: number): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Array<{ processing_type: string; planned_start_at: string | null }>>(
    `SELECT processing_type, planned_start_at FROM processing_batches WHERE id = ?`,
    [batchId],
  );
  const batch = rows[0];
  if (!batch) return;
  const planned = parseTimestamp(batch.planned_start_at ?? "") ?? new Date();
  const readyAt = new Date(
    planned.getTime() + processingDurationHours(batch.processing_type) * 3600_000,
  );
  await db.execute(
    `UPDATE processing_batches SET status = 'planned', started_at = ?, ready_at = ? WHERE id = ?`,
    [batch.planned_start_at ?? formatLocalTimestamp(planned), formatLocalTimestamp(readyAt), batchId],
  );
}

/** Current member sample ids of a batch (for the planned-run editor, issue #32). */
export async function getBatchMemberIds(batchId: number): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<Array<{ sample_id: number }>>(
    `SELECT sample_id FROM processing_batch_members WHERE batch_id = ? ORDER BY sample_id`,
    [batchId],
  );
  return rows.map((r) => r.sample_id);
}

/**
 * Replace a run's member samples (issues #32, #91).
 *
 * Both PLANNED and RUNNING batches are editable. Forgetting a sample, or not
 * selecting them all when the batch was created, is a routine mistake that is
 * only noticed once the processor is already going — and until #91 the only
 * remedy was to abandon the run. The new set must share the protocol, have
 * completed preprocessing (the reporter's own note), and not already be
 * committed to a different open batch.
 *
 * Editing a RUNNING batch has to move samples between stages, which a planned
 * batch never needed: its members are still sitting in pre-processing either
 * way. Added samples join the run in progress; removed ones go back to where
 * they came from.
 */
export async function updateBatchMembers(
  batchId: number,
  sampleIds: number[],
): Promise<void> {
  if (sampleIds.length === 0) throw new Error("A run needs at least one sample.");
  const db = await getDb();
  const batchRows = await db.select<
    Array<{ status: string; processing_type: string; started_at: string }>
  >(
    `SELECT status, processing_type, started_at FROM processing_batches WHERE id = ?`,
    [batchId],
  );
  const batch = batchRows[0];
  if (!batch) throw new Error("That processing batch no longer exists.");
  if (batch.status !== "planned" && batch.status !== "processing") {
    throw new Error("Only a planned or running batch's samples can be edited.");
  }
  const running = batch.status === "processing";
  const placeholders = sampleIds.map(() => "?").join(", ");
  const samples = await db.select<Sample[]>(
    `SELECT * FROM samples WHERE id IN (${placeholders}) ORDER BY id`,
    sampleIds,
  );
  if (samples.length !== sampleIds.length) throw new Error("One or more samples no longer exist.");

  // Who is joining and who is leaving — read BEFORE the membership is rewritten,
  // and before validation, because the rules differ. A sample already IN the run
  // is past pre-processing by definition once the run starts, so the "still
  // waiting to be processed" check below can only be applied to newcomers.
  const previousIds = (
    await db.select<Array<{ sample_id: number }>>(
      `SELECT sample_id FROM processing_batch_members WHERE batch_id = ?`,
      [batchId],
    )
  ).map((r) => r.sample_id);
  const next = new Set(sampleIds);
  const joined = sampleIds.filter((id) => !previousIds.includes(id));
  const left = previousIds.filter((id) => !next.has(id));

  const incompatible = samples.filter((s) => s.processing_type !== batch.processing_type);
  if (incompatible.length > 0) {
    throw new Error(`Not ${batch.processing_type} protocol: ${incompatible.map((s) => s.sample_code).join(", ")}`);
  }
  const notReady = samples.filter(
    (s) =>
      (s.needs_decalcification === 1 && !s.decalc_completed_at) ||
      !s.fixative_placed_at ||
      !s.fixative_removed_at ||
      !s.ethanol_placed_at,
  );
  if (notReady.length > 0) {
    throw new Error(`Complete preprocessing first: ${notReady.map((s) => s.sample_code).join(", ")}`);
  }
  // #91 — and it must still be WAITING for the processor. Every check above is a
  // "has this already happened" timestamp, and all of them stay true for the
  // rest of the block's life, so a block that has been processed, embedded and
  // sectioned passes them all. Without this, the Embedded Inventory was eligible
  // to be loaded back into the machine.
  const alreadyPast = samples.filter(
    (s) => joined.includes(s.id) && !PREPROCESSING_STAGES.has(s.current_stage),
  );
  if (alreadyPast.length > 0) {
    throw new Error(
      `Already past pre-processing: ${alreadyPast.map((s) => s.sample_code).join(", ")}`,
    );
  }
  const conflict = await db.select<Array<{ sample_code: string }>>(
    `SELECT s.sample_code
       FROM processing_batch_members pbm
       JOIN processing_batches pb ON pb.id = pbm.batch_id
       JOIN samples s ON s.id = pbm.sample_id
      WHERE pbm.sample_id IN (${placeholders}) AND pb.id != ?
        AND pb.status IN ('planned', 'processing')`,
    [...sampleIds, batchId],
  );
  if (conflict.length > 0) {
    throw new Error(`Already committed to another batch: ${conflict.map((r) => r.sample_code).join(", ")}`);
  }

  await db.execute(`DELETE FROM processing_batch_members WHERE batch_id = ?`, [batchId]);
  for (const id of sampleIds) {
    await db.execute(
      `INSERT INTO processing_batch_members (batch_id, sample_id) VALUES (?, ?)`,
      [batchId, id],
    );
  }

  // A PLANNED run needs nothing further: nobody has moved, so membership is the
  // whole story. A RUNNING one is a physical fact — the samples are in the
  // machine — so the stage has to follow the membership or the board shows a
  // block sitting in pre-processing while it is actually being processed.
  if (!running) return;
  for (const id of joined) {
    // The run's own start time, not now(): one batch, one timer. The sample
    // shares the existing ready_at, which is the honest reading of "I put it in
    // the same load" — it gets less than the full protocol duration, and the
    // drawer says so before you add it.
    await db.execute(
      `UPDATE samples SET current_stage = 'processing_started', processing_started_at = ?
        WHERE id = ?`,
      [batch.started_at, id],
    );
  }
  for (const id of left) {
    // Back to the end of pre-processing, which is where a sample waits to be
    // loaded. revertToStage clears every timestamp after the target, so the
    // sample does not keep a processing_started_at for a run it is no longer in.
    await revertToStage(id, "in_ethanol");
  }
}

type ProcessingBatchRow = Omit<ProcessingBatch, "member_ids" | "member_codes"> & {
  member_ids_csv: string;
  member_codes_csv: string;
};

export async function listOpenProcessingBatches(): Promise<ProcessingBatch[]> {
  const db = await getDb();
  const rows = await db.select<ProcessingBatchRow[]>(
    `SELECT pb.*,
            GROUP_CONCAT(s.id) AS member_ids_csv,
            GROUP_CONCAT(s.sample_code) AS member_codes_csv,
            COUNT(s.id) AS member_count,
            CASE
              -- A planned run parks in the Processor window (issues #4, #24)
              -- even though its samples are still in pre-processing.
              WHEN pb.status = 'planned' THEN 'processing_started'
              WHEN SUM(CASE WHEN s.current_stage = 'processing_started' THEN 1 ELSE 0 END) > 0
                THEN 'processing_started'
              ELSE 'processed'
            END AS current_stage,
            COALESCE((SELECT SUM(ci.is_complete)
                        FROM checklist_runs cr
                        JOIN checklist_items ci ON ci.checklist_run_id = cr.id
                       WHERE cr.scope_type = 'processing_batch' AND cr.scope_id = pb.id), 0)
              AS checklist_completed,
            COALESCE((SELECT COUNT(*)
                        FROM checklist_runs cr
                        JOIN checklist_items ci ON ci.checklist_run_id = cr.id
                       WHERE cr.scope_type = 'processing_batch' AND cr.scope_id = pb.id), 0)
              AS checklist_total
       FROM processing_batches pb
       JOIN processing_batch_members pbm ON pbm.batch_id = pb.id
       JOIN samples s ON s.id = pbm.sample_id
      WHERE pb.status = 'planned'
         OR s.current_stage IN ('processing_started', 'processed')
      GROUP BY pb.id
      ORDER BY pb.status = 'planned', pb.started_at ASC, pb.id ASC`,
  );
  return rows.map((row) => ({
    ...row,
    member_ids: String(row.member_ids_csv ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number),
    member_codes: String(row.member_codes_csv ?? "").split(",").filter(Boolean),
  }));
}

export async function listAllProcessingBatches(): Promise<ProcessingBatch[]> {
  const db = await getDb();
  const rows = await db.select<ProcessingBatchRow[]>(
    `SELECT pb.*,
            GROUP_CONCAT(s.id) AS member_ids_csv,
            GROUP_CONCAT(s.sample_code) AS member_codes_csv,
            COUNT(s.id) AS member_count,
            pb.status AS current_stage,
            COALESCE((SELECT SUM(ci.is_complete)
                        FROM checklist_runs cr
                        JOIN checklist_items ci ON ci.checklist_run_id = cr.id
                       WHERE cr.scope_type = 'processing_batch' AND cr.scope_id = pb.id), 0)
              AS checklist_completed,
            COALESCE((SELECT COUNT(*)
                        FROM checklist_runs cr
                        JOIN checklist_items ci ON ci.checklist_run_id = cr.id
                       WHERE cr.scope_type = 'processing_batch' AND cr.scope_id = pb.id), 0)
              AS checklist_total
       FROM processing_batches pb
       JOIN processing_batch_members pbm ON pbm.batch_id = pb.id
       JOIN samples s ON s.id = pbm.sample_id
      GROUP BY pb.id
      ORDER BY pb.started_at, pb.id`,
  );
  return rows.map((row) => ({
    ...row,
    member_ids: String(row.member_ids_csv ?? "").split(",").filter(Boolean).map(Number),
    member_codes: String(row.member_codes_csv ?? "").split(",").filter(Boolean),
  }));
}

export async function getProcessingBatchSamples(batchId: number): Promise<Sample[]> {
  const db = await getDb();
  return db.select<Sample[]>(
    `SELECT s.*
       FROM samples s
       JOIN processing_batch_members pbm ON pbm.sample_id = s.id
      WHERE pbm.batch_id = ? ORDER BY s.id`,
    [batchId],
  );
}

export async function moveProcessingBatch(batchId: number, stageKey: string): Promise<void> {
  if (stageKey !== "processed" && stageKey !== "needs_embedding") {
    throw new Error("Processing batches can move only to Pickup or Needs Embedding.");
  }
  const db = await getDb();
  const timestamp = nowTimestamp();
  if (stageKey === "processed") {
    await db.execute(
      `UPDATE samples
          SET current_stage = 'processed',
              stage_processed_at = COALESCE(stage_processed_at, ?)
        WHERE id IN (SELECT sample_id FROM processing_batch_members WHERE batch_id = ?)`,
      [timestamp, batchId],
    );
    await db.execute(`UPDATE processing_batches SET status = 'ready' WHERE id = ?`, [batchId]);
  } else {
    await db.execute(
      `UPDATE samples
          SET current_stage = 'needs_embedding',
              stage_picked_up_at = COALESCE(stage_picked_up_at, ?),
              stage_needs_embedding_at = COALESCE(stage_needs_embedding_at, ?)
        WHERE id IN (SELECT sample_id FROM processing_batch_members WHERE batch_id = ?)`,
      [timestamp, timestamp, batchId],
    );
    await db.execute(
      `UPDATE processing_batches
          SET status = 'completed', collected_at = COALESCE(collected_at, ?),
              completed_at = COALESCE(completed_at, ?)
        WHERE id = ?`,
      [timestamp, timestamp, batchId],
    );
  }
}

/**
 * Correct a processing batch's start time (issue #6). Recomputes the expected
 * ready time from the protocol duration and rewrites each member's
 * processing_started_at so the batch, its samples, and the countdown stay
 * consistent. Only meaningful while the batch is still processing.
 */
export async function updateProcessingBatchStart(
  batchId: number,
  startedAt: string,
): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Array<{ processing_type: string }>>(
    `SELECT processing_type FROM processing_batches WHERE id = ?`,
    [batchId],
  );
  const type = rows[0]?.processing_type;
  if (!type) throw new Error("That processing batch no longer exists.");
  const started = parseTimestamp(startedAt) ?? new Date();
  const readyAt = new Date(started.getTime() + processingDurationHours(type) * 3600_000);
  await db.execute(
    `UPDATE processing_batches SET started_at = ?, ready_at = ? WHERE id = ?`,
    [startedAt, formatLocalTimestamp(readyAt), batchId],
  );
  await db.execute(
    `UPDATE samples SET processing_started_at = ?
      WHERE id IN (SELECT sample_id FROM processing_batch_members WHERE batch_id = ?)`,
    [startedAt, batchId],
  );
}

// deleteProcessingBatch() is GONE (#83). It erased a processing run, its members
// and its protocol checklist — the evidence that the run happened and that its
// steps were performed. Nothing ever called it, so it was a loaded gun with no
// trigger; under "nothing is ever deleted" it should not be sitting there for a
// future button to wire up either.

export async function listChecklistItems(
  scopeType: string,
  scopeId: number,
  stageKey: string,
): Promise<ChecklistItem[]> {
  const db = await getDb();
  return db.select<ChecklistItem[]>(
    `SELECT ci.* FROM checklist_items ci
       JOIN checklist_runs cr ON cr.id = ci.checklist_run_id
      WHERE cr.scope_type = ? AND cr.scope_id = ? AND cr.stage_key = ?
      ORDER BY ci.sort_order, ci.id`,
    [scopeType, scopeId, stageKey],
  );
}

export async function ensureChecklist(input: {
  scopeType: string;
  scopeId: number;
  stageKey: string;
  protocolName: string;
  labels: string[];
}): Promise<ChecklistItem[]> {
  const db = await getDb();
  const existing = await db.select<Array<{ id: number }>>(
    `SELECT id FROM checklist_runs WHERE scope_type = ? AND scope_id = ? AND stage_key = ?`,
    [input.scopeType, input.scopeId, input.stageKey],
  );
  let runId = existing[0]?.id;
  if (runId == null) {
    const result = await db.execute(
      `INSERT INTO checklist_runs
        (scope_type, scope_id, stage_key, protocol_name, protocol_version)
       VALUES (?, ?, ?, ?, 1)`,
      [input.scopeType, input.scopeId, input.stageKey, input.protocolName],
    );
    runId = result.lastInsertId ?? 0;
    for (let i = 0; i < input.labels.length; i += 1) {
      await db.execute(
        `INSERT INTO checklist_items
          (checklist_run_id, item_key, label, sort_order, is_required)
         VALUES (?, ?, ?, ?, 1)`,
        [runId, `step-${i + 1}`, input.labels[i], i],
      );
    }
  }
  return listChecklistItems(input.scopeType, input.scopeId, input.stageKey);
}

export async function setChecklistItemComplete(
  itemId: number,
  complete: boolean,
  operatorName: string,
): Promise<void> {
  const db = await getDb();
  const timestamp = complete ? nowTimestamp() : null;

  // A protocol is an ORDER, not a set of independent boxes. You stain, then you
  // coverslip; a coverslip seals the section, so the reverse cannot happen. The
  // checklist rendered every step as its own button with no guard at all, so
  // ticking Coverslipped first was a click away — and it produced a slide whose
  // record said it was coverslipped on Tuesday and stained on Wednesday.
  //
  // Found by the swarm: `CC-0021-C`, cut 02:32, coverslipped 02:33, stained
  // 02:34. Nothing else in the app notices, because each stamp is written by its
  // own step and no one compares them.
  const position = await db.select<
    Array<{ run_id: number; sort_order: number; label: string }>
  >(
    `SELECT checklist_run_id AS run_id, sort_order, label FROM checklist_items WHERE id = ?`,
    [itemId],
  );
  const step = position[0];
  if (step) {
    if (complete) {
      const earlier = await db.select<Array<{ label: string }>>(
        `SELECT label FROM checklist_items
          WHERE checklist_run_id = ? AND sort_order < ? AND is_required = 1 AND is_complete = 0
          ORDER BY sort_order LIMIT 1`,
        [step.run_id, step.sort_order],
      );
      if (earlier[0]) {
        throw new Error(`Record "${earlier[0].label}" before "${step.label}".`);
      }
    } else {
      // …and the same going backwards: un-ticking a step while a later one is
      // done would leave the same impossible record by the other route.
      const later = await db.select<Array<{ label: string }>>(
        `SELECT label FROM checklist_items
          WHERE checklist_run_id = ? AND sort_order > ? AND is_complete = 1
          ORDER BY sort_order DESC LIMIT 1`,
        [step.run_id, step.sort_order],
      );
      if (later[0]) {
        throw new Error(`Undo "${later[0].label}" before un-recording "${step.label}".`);
      }
    }
  }

  await db.execute(
    `UPDATE checklist_items
        SET is_complete = ?, completed_by = ?, completed_at = ?
      WHERE id = ?`,
    [complete ? 1 : 0, complete ? operatorName.trim() : "", timestamp, itemId],
  );
  const rows = await db.select<Array<{ checklist_run_id: number }>>(
    `SELECT checklist_run_id FROM checklist_items WHERE id = ?`,
    [itemId],
  );
  const runId = rows[0]?.checklist_run_id;
  if (runId != null) {
    await db.execute(
      `UPDATE checklist_runs
          SET completed_at = CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM checklist_items
               WHERE checklist_run_id = ? AND is_required = 1 AND is_complete = 0
            ) THEN COALESCE(completed_at, ?)
            ELSE NULL
          END
        WHERE id = ?`,
      [runId, nowTimestamp(), runId],
    );
  }
}

export async function checklistComplete(
  scopeType: string,
  scopeId: number,
  stageKey: string,
): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<Array<{ total: number; remaining: number }>>(
    `SELECT COUNT(ci.id) AS total,
            COALESCE(SUM(CASE WHEN ci.is_required = 1 AND ci.is_complete = 0 THEN 1 ELSE 0 END), 0)
              AS remaining
       FROM checklist_runs cr
       JOIN checklist_items ci ON ci.checklist_run_id = cr.id
      WHERE cr.scope_type = ? AND cr.scope_id = ? AND cr.stage_key = ?`,
    [scopeType, scopeId, stageKey],
  );
  return (rows[0]?.total ?? 0) > 0 && (rows[0]?.remaining ?? 1) === 0;
}

export async function syncAssayWorkflowStep(
  sectionRequestId: number,
  assayType: "stain" | "ihc",
  sortOrder: number,
  complete: boolean,
): Promise<void> {
  const db = await getDb();
  const timestamp = complete ? nowTimestamp() : null;
  // Steps: 0 Stained/IHC, 1 Coverslipped (+refrax). (Deparaffinization was
  // dropped as a tracked step — #59; drying likewise — #80. Both columns are
  // retained for compat.)
  //
  // Step 2 (Dried) is KEPT here on purpose even though no new checklist offers
  // it: `ensureChecklist` reuses an existing run, so a rack that was already
  // mid-protocol when this build landed still has its three-item checklist and
  // must be able to finish it. Deleting this branch would strand those racks.
  // Same rule as the rack path (`syncAssayStackWorkflowStep`): tick COALESCEs so
  // an earlier, truthful date survives, and untick clears only what THIS group
  // stamped. Both sets of checkboxes drive the same slides, so a fix on one side
  // only is no fix at all — that is the shape #81 was reported in twice.
  const clearMatching = async (columns: string[], keyColumn: string, sectionColumn: string) => {
    const rows = await db.select<Array<{ stamp: string | null }>>(
      `SELECT ${sectionColumn} AS stamp FROM section_requests WHERE id = ?`,
      [sectionRequestId],
    );
    const stamp = rows[0]?.stamp ?? null;
    if (stamp === null) return;
    await db.execute(
      `UPDATE slides SET ${columns.map((c) => `${c} = NULL`).join(", ")}
        WHERE section_request_id = ? AND purpose = 'stain' AND assay_type = ? AND ${keyColumn} = ?
          ${keyColumn === "stage_stained_at" ? "AND stage_coverslipped_at IS NULL" : ""}`,
      [sectionRequestId, assayType, stamp],
    );
  };

  if (sortOrder === 0) {
    const sectionColumn = assayType === "ihc" ? "stage_ihc_at" : "stage_stained_at";
    if (complete) {
      await db.execute(
        `UPDATE slides SET stage_stained_at = COALESCE(stage_stained_at, ?)
          WHERE section_request_id = ? AND purpose = 'stain' AND assay_type = ?`,
        [timestamp, sectionRequestId, assayType],
      );
    } else {
      await clearMatching(["stage_stained_at"], "stage_stained_at", sectionColumn);
    }
    await db.execute(
      `UPDATE section_requests SET ${sectionColumn} = ${complete ? `COALESCE(${sectionColumn}, ?)` : "?"} WHERE id = ?`,
      [timestamp, sectionRequestId],
    );
  } else if (sortOrder === 1) {
    if (complete) {
      // Same rule as the rack path: staining comes first, physically.
      const unstained = await db.select<Array<{ slide_code: string }>>(
        `SELECT slide_code FROM slides
          WHERE section_request_id = ? AND purpose = 'stain' AND assay_type = ?
            AND current_stage <> 'removed' AND stage_stained_at IS NULL
          LIMIT 1`,
        [sectionRequestId, assayType],
      );
      if (unstained[0]) {
        throw new Error(
          `${displayCode(unstained[0].slide_code)} has not been stained yet — record staining before coverslipping.`,
        );
      }
      await db.execute(
        // Same atomic condition as the rack path.
        `UPDATE slides
            SET stage_refrax_at = COALESCE(stage_refrax_at, ?),
                stage_coverslipped_at = COALESCE(stage_coverslipped_at, ?)
          WHERE section_request_id = ? AND purpose = 'stain' AND assay_type = ?
            AND stage_stained_at IS NOT NULL`,
        [timestamp, timestamp, sectionRequestId, assayType],
      );
    } else {
      await clearMatching(
        ["stage_refrax_at", "stage_coverslipped_at"],
        "stage_coverslipped_at",
        "stage_coverslipped_at",
      );
    }
    await db.execute(
      `UPDATE section_requests
          SET stage_refrax_at = ${complete ? "COALESCE(stage_refrax_at, ?)" : "?"},
              stage_coverslipped_at = ${complete ? "COALESCE(stage_coverslipped_at, ?)" : "?"}
        WHERE id = ?`,
      [timestamp, timestamp, sectionRequestId],
    );
  } else if (sortOrder === 2) {
    if (complete) {
      await db.execute(
        `UPDATE slides SET stage_dried_at = COALESCE(stage_dried_at, ?)
          WHERE section_request_id = ? AND purpose = 'stain' AND assay_type = ?`,
        [timestamp, sectionRequestId, assayType],
      );
    } else {
      await clearMatching(["stage_dried_at"], "stage_dried_at", "stage_dried_at");
    }
    await db.execute(
      `UPDATE section_requests SET stage_dried_at = ${complete ? "COALESCE(stage_dried_at, ?)" : "?"} WHERE id = ?`,
      [timestamp, sectionRequestId],
    );
  }

  const assayTypes = await db.select<Array<{ assay_type: "stain" | "ihc" }>>(
    `SELECT DISTINCT assay_type FROM slides
      WHERE section_request_id = ? AND purpose = 'stain' AND assay_type IN ('stain', 'ihc')
        AND current_stage != 'removed'`,
    [sectionRequestId],
  );
  if (assayTypes.length === 0) return;
  const completion = await Promise.all(
    assayTypes.map((row) =>
      checklistComplete("section_request", sectionRequestId, `${row.assay_type}_workflow_v5`),
    ),
  );
  if (completion.every(Boolean)) {
    const readyAt = nowTimestamp();
    await db.execute(
      `UPDATE slides
          SET current_stage = 'ready_for_imaging',
              stage_ready_for_imaging_at = COALESCE(stage_ready_for_imaging_at, ?)
        WHERE section_request_id = ? AND purpose = 'stain'`,
      [readyAt, sectionRequestId],
    );
    await db.execute(
      `UPDATE section_requests
          SET current_stage = 'ready_for_imaging',
              stage_ready_for_imaging_at = COALESCE(stage_ready_for_imaging_at, ?)
        WHERE id = ?`,
      [readyAt, sectionRequestId],
    );
  }
}

// ---- Section requests (children of embedded blocks) -------------------------

const SECTION_RESTORE_COLUMNS = [
  "duplicates", "stains", "notes", "current_stage",
  ...SECTION_STAGES.map((s) => s.column),
] as const;

const SECTION_COLUMN_SET = new Set(Object.values(SECTION_STAGE_COLUMNS));

// Per-sample slide code: EE-0001-A, -B, … (no depth, 0.3.3). Letters continue
// across successive cuts of the same block.
function slideCodeFor(parentCode: string, ordinal: number): string {
  return `${parentCode}-${duplicateLabel(ordinal).toUpperCase()}`;
}

/**
 * The next slide LETTER for a sample — issued from a high-water mark, never from
 * a live count (issue #73).
 *
 * Letters used to come from `COUNT(slides for this sample) + 1`, so deleting a
 * slide handed its letter to the next cut: create C, create D, delete C, and the
 * next slide came out as C again — two different physical slides sharing a code.
 * `samples.slides_issued` only ever moves forward, so a deleted letter stays
 * burned and the next slide is E.
 *
 * The MAX() with the live count is the compatibility path: on a database that
 * predates the column it reads 0, so the count still governs and behaviour is
 * identical to before. The first cut on the new build writes the mark and it
 * takes over from there.
 */
async function nextSlideLetter(db: Database, sampleId: number): Promise<number> {
  // NEVER a live COUNT. A count is lowered by any removal, and requiring each
  // removal path to compensate is exactly the per-call-site fragility that let
  // #73 ship broken. Both terms below only ever rise: the persisted mark, and
  // the highest letter still visible in the sample's slide codes (a safety net
  // for rows written before the mark existed, or by any future path that forgets
  // to record).
  //
  // The code scan below deliberately has NO `current_stage != 'removed'` filter.
  // A removed slide keeps its code, and that is the point: its letter must stay
  // burned (#83). Sample deletion still cascades, which is why the persisted
  // mark is the primary term rather than this scan.
  const rows = await db.select<Array<{ issued: number; codes: string }>>(
    `SELECT COALESCE((SELECT slides_issued FROM samples WHERE id = ?), 0) AS issued,
            COALESCE((SELECT GROUP_CONCAT(sl.slide_code)
                        FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
                       WHERE sr.sample_id = ?), '') AS codes`,
    [sampleId, sampleId],
  );
  const row = rows[0];
  return Math.max(row?.issued ?? 0, highestLetterOrdinal(row?.codes ?? "")) + 1;
}

/**
 * The highest slide-letter ordinal appearing in a comma-separated list of slide
 * codes ("EE-0001-A,EE-0001-AB" → 28). Unknown shapes contribute 0.
 */
function highestLetterOrdinal(codes: string): number {
  let highest = 0;
  for (const code of codes.split(",")) {
    // The letters must follow a NUMERIC segment — "EE-0001-C", or the pre-0.3.3
    // "EE-0001-D01-a". Matching a bare trailing word would read "not-a-code" as
    // the letter "code" (ordinal 62977) and shove the mark into the far future.
    const suffix = /\d[^-]*-([A-Za-z]+)$/.exec(code.trim())?.[1];
    if (!suffix) continue;
    let ordinal = 0;
    for (const ch of suffix.toUpperCase()) ordinal = ordinal * 26 + (ch.charCodeAt(0) - 64);
    if (ordinal > highest) highest = ordinal;
  }
  return highest;
}

/**
 * One-time backfill of `samples.slides_issued` from the letters already present
 * in each sample's slide codes.
 *
 * A database created before 0023 has the mark at 0 while its slides already
 * occupy letters. Until the mark catches up, a delete could hand a live letter
 * to the next cut — `UNIQUE constraint failed: slides.slide_code`. Running this
 * at open means the mark is correct for every sample BEFORE any delete can
 * happen, which is what makes deletes safe without each delete path
 * compensating. Idempotent (MAX only ever raises), so a re-run — including after
 * reverting an old backup — is harmless.
 */
async function backfillSlideLetterMarks(db: Database): Promise<void> {
  try {
    const done = await db.select<Array<{ value: string }>>(
      `SELECT value FROM schema_meta WHERE key = 'slide_letter_marks_backfilled'`,
    );
    if (done[0]?.value === "1") return;
    const rows = await db.select<Array<{ sample_id: number; codes: string }>>(
      `SELECT sr.sample_id AS sample_id, GROUP_CONCAT(sl.slide_code) AS codes
         FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
        GROUP BY sr.sample_id`,
    );
    for (const row of rows) {
      const highest = highestLetterOrdinal(row.codes ?? "");
      if (highest > 0) await recordSlidesIssued(db, row.sample_id, highest);
    }
    await db.execute(
      `INSERT INTO schema_meta (key, value) VALUES ('slide_letter_marks_backfilled', '1')
         ON CONFLICT(key) DO UPDATE SET value = '1'`,
    );
  } catch (error) {
    // Corrective, not load-bearing — never block the app from opening. The
    // marker is only written on success, so a failure retries on the next open.
    console.warn("Skipped the slide-letter mark backfill on this image:", error);
  }
}

/** Record how far a sample's letter sequence has advanced (never backwards). */
async function recordSlidesIssued(db: Database, sampleId: number, lastLetter: number): Promise<void> {
  await db.execute(
    `UPDATE samples SET slides_issued = MAX(COALESCE(slides_issued, 0), ?) WHERE id = ?`,
    [lastLetter, sampleId],
  );
}

/**
 * Create section-request cut groups (no depth); each produces `duplicates`
 * slides. A group carrying an assay agent preassigns + saves its slides as that
 * stain (0.3.3 preselected stains); otherwise the slides are saved extras.
 */
export async function createSectionRequests(
  sampleId: number,
  groups: Array<{ duplicates: number; stains?: string; assay_type?: string; assay_name?: string }>,
): Promise<number[]> {
  // Letter allocation is a read-then-write across `await`, so two cuts of the
  // same block started together take the same letters and the second dies on
  // UNIQUE(slide_code). The unwind below already guarantees a failed call leaves
  // the database exactly as it found it, which is what makes retrying the whole
  // call safe — and retrying is the only thing that works, because any check
  // before the insert is itself racy. Found by the concurrent swarm.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await createSectionRequestsOnce(sampleId, groups);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/UNIQUE constraint failed:\s*slides\.slide_code/i.test(message) || attempt >= 4) {
        throw /UNIQUE constraint failed:\s*slides\.slide_code/i.test(message)
          ? new Error("Could not allocate slide letters — try that cut again in a moment.")
          : error;
      }
    }
  }
}

async function createSectionRequestsOnce(
  sampleId: number,
  groups: Array<{ duplicates: number; stains?: string; assay_type?: string; assay_name?: string }>,
): Promise<number[]> {
  if (groups.length === 0) return [];
  const db = await getDb();
  // A block can only be cut once it has reached Embedded Inventory (issue #7).
  const sampleRows = await db.select<Array<{ current_stage: string; sample_code: string }>>(
    `SELECT current_stage, sample_code FROM samples WHERE id = ?`,
    [sampleId],
  );
  const stage = sampleRows[0]?.current_stage;
  if (!stage || (STAGE_ORDER[stage] ?? -1) < STAGE_ORDER.embedded) {
    throw new Error("This block must be embedded before it can be sent to sectioning.");
  }
  const parentCode = sampleRows[0]?.sample_code ?? `BLOCK-${sampleId}`;
  const timestamp = nowTimestamp();
  const ids: number[] = [];
  // Slide letters run per sample across all its slides, and are never reused
  // once issued (#73).
  let nextOrdinal = await nextSlideLetter(db, sampleId);
  // COMPENSATION. This loop writes several rows across two tables with no
  // transaction, so a failure part-way used to leave a half-built cut group
  // behind — and the failure was reachable: before the allocator fix a reused
  // letter threw on UNIQUE(slide_code) mid-loop, leaving a section that claimed
  // N slides but held fewer. That group's card could not be opened, so it could
  // not be deleted either. Undo does not help, because commit() only records the
  // undo entry AFTER the mutation returns. If anything throws, unwind what this
  // call created so the database is left exactly as it was found.
  const createdSections: number[] = [];
  try {
  for (const g of groups) {
    const count = Math.max(1, g.duplicates);
    const preassigned = Boolean(g.assay_type && g.assay_name);
    const res = await db.execute(
      `INSERT INTO section_requests
        (sample_id, duplicates, stains, current_stage, stage_needs_sectioning_at)
       VALUES (?, ?, ?, 'needs_sectioning', ?)`,
      [sampleId, count, g.stains ?? (preassigned ? g.assay_name : "") ?? "", timestamp],
    );
    // A section_requests row may already exist even when no id came back, so
    // record it for cleanup BEFORE deciding whether to continue — skipping
    // straight to the next group is what orphaned it.
    if (res.lastInsertId != null) createdSections.push(res.lastInsertId);
    if (res.lastInsertId == null) continue;
    const sectionId = res.lastInsertId;
    ids.push(sectionId);
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      if (preassigned) {
        // Preselected stain: the slide is saved to that agent, ready for a
        // one-click Start Assays (issues #1, #3).
        await db.execute(
          // No stage_cut_at. The slide is PLANNED here, not cut — this runs when
          // the group is sent to Needs Sectioning, which is a queue, not a
          // microtome. Stamping it here made every waiting slide read as Cut in
          // the log, and made undoing a sectioning look broken (#95). The stamp
          // happens in updateSectionStage, when the group actually leaves the
          // queue.
          // requested_* is the ORDER: written once, here, and never touched by a
          // later correction. assay_* goes on meaning "what this glass is", so
          // the two can differ and the log can say a PAS was asked for and an
          // H&E was made.
          `INSERT INTO slides
            (section_request_id, slide_ordinal, slide_code, purpose, stain_name,
             assay_type, assay_name, requested_assay_type, requested_assay_name,
             assignment_saved, slice_count, control_agent, current_stage)
           VALUES (?, ?, ?, 'stain', ?, ?, ?, ?, ?, 1, 2, 'IgG', 'assigned')`,
          [
            sectionId,
            ordinal,
            slideCodeFor(parentCode, nextOrdinal),
            g.assay_name,
            g.assay_type,
            g.assay_name,
            g.assay_type,
            g.assay_name,
          ],
        );
      } else {
        // Extras are a deliberate, saved disposition chosen at cut time — no
        // separate assignment step needed (issues #34, #38). They still stay out
        // of the Extras inventory until the section leaves Needs Sectioning
        // (issue #12), via listExtraSlides' stage filter.
        await db.execute(
          // Planned, not cut — see the stain branch above (#95).
          `INSERT INTO slides
            (section_request_id, slide_ordinal, slide_code, purpose, assignment_saved, current_stage)
           VALUES (?, ?, ?, 'extra', 1, 'extra')`,
          [sectionId, ordinal, slideCodeFor(parentCode, nextOrdinal)],
        );
      }
      nextOrdinal += 1;
    }
  }
  } catch (error) {
    // Unwind newest-first so slides go before their section.
    for (const sectionId of [...createdSections].reverse()) {
      await db.execute(`DELETE FROM slides WHERE section_request_id = ?`, [sectionId])
        .catch(() => undefined);
      await db.execute(`DELETE FROM section_requests WHERE id = ?`, [sectionId])
        .catch(() => undefined);
    }
    throw error;
  }
  // Burn every letter this cut consumed so a later deletion can't hand one back.
  await recordSlidesIssued(db, sampleId, nextOrdinal - 1);

  // Archive the fulfilled plan as a timeline event, then clear the live plan so
  // re-opening Send for Cutting always starts a WHOLLY NEW plan rather than the
  // one that was just cut. The slides themselves are the durable record.
  const slideCount = groups.reduce((total, g) => total + Math.max(1, g.duplicates), 0);
  const planSummary = groups
    .map((g) => `×${Math.max(1, g.duplicates)} ${g.assay_name ? g.assay_name : g.stains ? g.stains : "extra"}`)
    .join(", ");
  await db.execute(
    `INSERT INTO sample_timeline_events
      (sample_id, user_id, event_type, summary, details, created_at)
     VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
             'sectioning_cut', ?, ?, ?)`,
    [sampleId, `Cut ${slideCount} slide${slideCount === 1 ? "" : "s"}: ${planSummary}`, JSON.stringify(groups), timestamp],
  );
  await db.execute(`UPDATE samples SET sectioning_plan = '' WHERE id = ?`, [sampleId]);

  // Cutting FULFILS outstanding stain requests: remove from the block's
  // preselected/requested multiset one entry per preassigned slide actually cut,
  // so the "needs stain" flag clears exactly when a physical slide exists for it
  // (issues #41/#62/#66). Extras don't fulfil a request. See listOpenSamples,
  // where pending_stains == the (untrimmed) outstanding multiset.
  // Keyed on the NAME, not on name+type (#112). Requiring `assay_type` too
  // meant a group carrying an agent with a blank type could never fulfil
  // anything, so its request stayed outstanding for ever and the block kept a
  // flag no cut could clear — with the slide sitting right there in Needs
  // Sectioning. `stains` is the older field name for the same thing and is
  // accepted for plans written by earlier builds.
  const cut: Array<{ assay_type: string; assay_name: string }> = [];
  for (const g of groups) {
    const name = (g.assay_name || g.stains || "").trim();
    if (!name) continue;
    for (let i = 0; i < Math.max(1, g.duplicates); i += 1) {
      cut.push({ assay_type: g.assay_type ?? "", assay_name: name });
    }
  }
  if (cut.length > 0) {
    const preRows = await db.select<Array<{ preselected_stains: string }>>(
      `SELECT preselected_stains FROM samples WHERE id = ?`,
      [sampleId],
    );
    const remaining = removeFromRequests(parsePreselectedStains(preRows[0]?.preselected_stains), cut);
    await db.execute(`UPDATE samples SET preselected_stains = ? WHERE id = ?`, [
      remaining.length ? JSON.stringify(remaining) : "",
      sampleId,
    ]);
  }
  return ids;
}

/**
 * Remove up to one entry per `toRemove` item from an outstanding-requests list,
 * returning what stays outstanding.
 *
 * The agent NAME is the identity; the type only has to agree when both sides
 * state one (#112). Insisting on an exact type match let a blank or
 * differently-typed entry survive a cut that plainly fulfilled it, which is how
 * a block ended up flagged for a stain whose slide already existed.
 */
function removeFromRequests(
  current: Array<{ assay_type: string; assay_name: string }>,
  toRemove: Array<{ assay_type: string; assay_name: string }>,
): Array<{ assay_type: string; assay_name: string }> {
  const remaining = [...current];
  const sameAgent = (
    a: { assay_type: string; assay_name: string },
    b: { assay_type: string; assay_name: string },
  ) =>
    a.assay_name.trim().toLowerCase() === b.assay_name.trim().toLowerCase() &&
    (!a.assay_type || !b.assay_type || a.assay_type === b.assay_type);
  for (const r of toRemove) {
    // Prefer an exact type match so a genuine stain/IHC pair of the same name
    // is not consumed by the wrong one; fall back to name alone.
    let idx = remaining.findIndex(
      (a) => a.assay_type === r.assay_type && sameAgent(a, r),
    );
    if (idx < 0) idx = remaining.findIndex((a) => sameAgent(a, r));
    if (idx >= 0) remaining.splice(idx, 1);
  }
  return remaining;
}


/**
 * The auto-generated sectioning plan for an embedded sample with preselected
 * stains (issue #4): one preassigned cut group per stain, plus enough extras to
 * reach the configured total, never fewer than the configured minimum extras.
 *
 * The counts used to be the literals 2 and 4 (#92). `settings` is a parameter
 * rather than a read inside, so this stays pure and the dialog can preview the
 * same arithmetic the write will use.
 */
export function buildAutoSectioningPlan(
  preselected: Array<{ assay_type: string; assay_name: string }>,
  settings: AppSettings,
): Array<{ duplicates: number; stains?: string; assay_type?: string; assay_name?: string }> {
  const stains = preselected.map((a) => ({
    duplicates: 1,
    stains: a.assay_name,
    assay_type: a.assay_type,
    assay_name: a.assay_name,
  }));
  const extras = plannedExtras(settings, preselected.length);
  return [...stains, { duplicates: extras, stains: "" }];
}

/** Parse a sample's stored preselected stains (JSON), tolerating empty/legacy. */
/**
 * The preselected agents as a human-readable list ("CD3, H&E").
 *
 * `pending_stains` is a JSON blob (listOpenSamples stringifies it), so rendering
 * the column directly prints `[{"assay_type":"ihc","assay_name":"CD3"}]` at the
 * user. Three separate places did that; this is the one way to say it.
 */
export function pendingStainNames(raw: string | null | undefined): string {
  return parsePreselectedStains(raw)
    .map((a) => a.assay_name)
    .join(", ");
}

export function parsePreselectedStains(
  raw: string | null | undefined,
): Array<{ assay_type: string; assay_name: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a) => a && a.assay_name)
      .map((a) => ({ assay_type: String(a.assay_type || "stain"), assay_name: String(a.assay_name) }));
  } catch {
    return [];
  }
}

export async function listOpenSectionRequests(): Promise<SectionRequest[]> {
  const db = await getDb();
  return db.select<SectionRequest[]>(
    `SELECT sr.*,
            s.project_id     AS project_id,
            s.sample_code    AS parent_code,
            s.sample_description AS parent_description,
            p.code           AS project_code,
            p.name           AS project_name,
            s.stains         AS parent_stains,
            s.is_priority    AS is_priority,
            s.prioritized_at AS prioritized_at,
            COUNT(sl.id)     AS slide_count,
            COALESCE(SUM(CASE WHEN sl.purpose = 'stain' THEN 1 ELSE 0 END), 0)
                             AS assay_slide_count,
            COALESCE(SUM(CASE WHEN sl.assignment_saved = 1 THEN 1 ELSE 0 END), 0)
                             AS assigned_slide_count,
            COALESCE(SUM(CASE WHEN sl.purpose = 'extra' THEN 1 ELSE 0 END), 0)
                             AS extra_slide_count,
            COALESCE(GROUP_CONCAT(
              CASE
                WHEN sl.purpose = 'stain' THEN
                  CASE WHEN sl.assay_type = 'ihc'
                    THEN 'IHC: ' || sl.assay_name
                    ELSE 'Stain: ' || COALESCE(NULLIF(sl.assay_name, ''), sl.stain_name)
                  END
                WHEN sl.purpose = 'extra' THEN 'Extra'
                WHEN sl.purpose = 'control' THEN 'Control'
                WHEN sl.purpose = 'exception' THEN 'Exception'
                ELSE NULL
              END,
              ' · '
            ), '')           AS slide_summary,
            COALESCE(GROUP_CONCAT(
              CASE WHEN sl.purpose = 'stain' THEN
                sl.slide_code || ': ' || CASE WHEN sl.assay_type = 'ihc'
                  THEN 'IHC: ' || sl.assay_name
                  ELSE 'Stain: ' || COALESCE(NULLIF(sl.assay_name, ''), sl.stain_name)
                END
              ELSE NULL END,
              ' · '
            ), '')           AS assay_slide_summary
       FROM section_requests sr
       JOIN samples s  ON s.id = sr.sample_id
       JOIN projects p ON p.id = s.project_id
      -- Removed slides must not reach the card's slide summary or its counts,
      -- so they are excluded in the JOIN rather than the WHERE — a WHERE clause
      -- would drop the whole GROUPed row for a group whose only slide is gone
      -- (#83).
      LEFT JOIN slides sl ON sl.section_request_id = sr.id AND sl.current_stage != 'removed'
      WHERE p.is_active = 1 AND sr.current_stage != 'analyzed'
        AND sr.current_stage != 'removed' -- a retired cut group leaves the board (#83)
        AND s.archived_at IS NULL -- archiving clears the board (#74)
      GROUP BY sr.id
      HAVING NOT (
        sr.current_stage = 'ready_for_imaging'
        AND COALESCE(SUM(CASE WHEN sl.purpose = 'stain' THEN 1 ELSE 0 END), 0) = 0
      )
      ORDER BY s.is_priority DESC, s.prioritized_at DESC, sr.id ASC`,
  );
}

export async function getSectionRequest(id: number): Promise<SectionRequest | null> {
  const db = await getDb();
  const rows = await db.select<SectionRequest[]>(
    `SELECT * FROM section_requests WHERE id = ?`,
    [id],
  );
  return rows[0] ?? null;
}

async function ensureSlidesForSectionRequest(id: number): Promise<void> {
  // A viewer must never write — but this is called from READ paths
  // (listSlidesForSectionRequest / listSlidesForSections). Letting it try the
  // INSERT means guardWrites rejects, and the rejection propagates out of the
  // *read*, so the drawer falls back to an empty list. One uninitialised group
  // would blank the slide rows of every group on the card — destroying exactly
  // the read #72 promises viewers ("see cutting plans and existing tags").
  // The initialiser is a workstation-side repair; on a viewer, show what exists.
  if (viewerReadOnly) return;

  const db = await getDb();
  const rows = await db.select<
    Array<{
      duplicates: number;
      sample_id: number;
      sample_code: string;
      existing_count: number;
      current_stage: string;
      stage_sectioned_at: string | null;
    }>
  >(
    `SELECT sr.duplicates, sr.sample_id, s.sample_code, COUNT(sl.id) AS existing_count,
            sr.current_stage, sr.stage_sectioned_at
       FROM section_requests sr
       JOIN samples s ON s.id = sr.sample_id
       LEFT JOIN slides sl ON sl.section_request_id = sr.id AND sl.current_stage != 'removed'
      WHERE sr.id = ?
      GROUP BY sr.id`,
    [id],
  );
  const row = rows[0];
  if (!row) return;

  // ONLY initialise a section that has no slides at all.
  //
  // This used to top a section up to `duplicates`, with the next ordinal taken
  // from a live COUNT. Two bugs fell out of that, both reachable from the
  // "Remove slides" controls (#73/#83):
  //   1. deleting a slide silently RESURRECTED it on the next open, so a slide
  //      the technician removed as lost or mis-entered simply came back; and
  //   2. `slides` carries UNIQUE(section_request_id, slide_ordinal), so deleting
  //      a slide from the MIDDLE of a group made the count collide with an
  //      ordinal that was still occupied — "UNIQUE constraint failed" thrown
  //      from a function that runs on EVERY open of that card, permanently
  //      bricking it, with removeSections poisoned too so it could not even be
  //      deleted.
  // Slides for a real cut are created eagerly by createSectionRequests; this
  // path exists only to initialise legacy rows that predate that. Restricting it
  // to empty sections makes both failures impossible by construction rather than
  // by remembering to compensate at each delete site.
  if (row.existing_count > 0) return;

  // An emptied group is NOT an uninitialised one. `duplicates` is kept in step
  // with removals (syncSectionDuplicates), so 0 here means "the bench removed
  // every slide" — refilling it would undo that, and would do so again on every
  // open. Legacy rows that genuinely predate eager creation still carry the
  // column's `NOT NULL DEFAULT 1`, so they initialise as before (#83).
  if (row.duplicates <= 0) return;

  // New slides continue the sample's letter sequence (A, B, …), never reusing a
  // letter a deleted slide already consumed (#73).
  let nextLetter = await nextSlideLetter(db, row.sample_id);
  // These rows are being back-filled for a group that already exists, so "now"
  // is never the cut time. If the group has left Needs Sectioning it was cut at
  // some point and its own stage_sectioned_at is the closest honest record; if
  // it is still queued, it has not been cut and the stamp stays NULL (#95).
  const cutAt =
    row.current_stage === "needs_sectioning" ? null : row.stage_sectioned_at ?? nowTimestamp();
  for (let ordinal = 1; ordinal <= row.duplicates; ordinal += 1) {
    await db.execute(
      `INSERT INTO slides
        (section_request_id, slide_ordinal, slide_code, purpose, assignment_saved, current_stage, stage_cut_at)
       VALUES (?, ?, ?, 'extra', 1, 'extra', ?)`,
      [id, ordinal, slideCodeFor(row.sample_code, nextLetter), cutAt],
    );
    nextLetter += 1;
  }
  await recordSlidesIssued(db, row.sample_id, nextLetter - 1);
}

export async function listSlidesForSectionRequest(id: number): Promise<Slide[]> {
  await ensureSlidesForSectionRequest(id);
  const db = await getDb();
  return db.select<Slide[]>(
    `SELECT * FROM slides WHERE section_request_id = ? AND current_stage != 'removed'
      ORDER BY slide_ordinal`,
    [id],
  );
}

/** Slides across several cut groups — a Needs-Sectioning card groups every
 *  section_request of a sample, so its drawer must show all of them, not just
 *  the first group's slides. */
export async function listSlidesForSections(sectionIds: number[]): Promise<Slide[]> {
  if (sectionIds.length === 0) return [];
  for (const id of sectionIds) await ensureSlidesForSectionRequest(id);
  const db = await getDb();
  const placeholders = sectionIds.map(() => "?").join(", ");
  return db.select<Slide[]>(
    // section_request_id FIRST: slide_ordinal restarts at 1 in every cut group,
    // so ordering by it across several groups interleaves them — a twice-cut
    // block listed A, C, B, D (#75). Same correction as listAllSlides.
    `SELECT * FROM slides WHERE section_request_id IN (${placeholders})
        AND current_stage != 'removed'
      ORDER BY section_request_id, slide_ordinal, id`,
    sectionIds,
  );
}

export async function listExtraSlides(): Promise<Slide[]> {
  const db = await getDb();
  return db.select<Slide[]>(
    `SELECT sl.*, s.id AS sample_id, s.sample_code AS parent_code,
            s.sample_description, s.is_priority, p.code AS project_code, p.name AS project_name
       FROM slides sl
       JOIN section_requests sr ON sr.id = sl.section_request_id
       JOIN samples s ON s.id = sr.sample_id
       JOIN projects p ON p.id = s.project_id
      WHERE sl.purpose = 'extra' AND sl.assignment_saved = 1
        AND sl.current_stage = 'extra' AND p.is_active = 1
        -- Archived samples leave the board entirely (#74). Extras never advance
        -- past current_stage='extra', so without this an archived block's extras
        -- sat in the inventory permanently.
        AND s.archived_at IS NULL
        -- Only after the cut group has left the Fresh/assignment tab (issue #12):
        -- a slide saved as 'extra' during assignment must not surface in the
        -- inventory until its section is dispositioned onward.
        AND sr.current_stage NOT IN ('needs_sectioning', 'sectioned', 'assignment_required')
      ORDER BY s.is_priority DESC, p.code COLLATE NOCASE, s.project_sample_number, sl.id`,
  );
}

/**
 * Stain/IHC slides across several sections at once — used by the imaging
 * checklist so a sample's grouped Ready-for-Imaging sections (e.g. an original
 * stack plus a separately-stained extra) show a checkbox for every slide
 * (issue #14), not just the representative section's.
 */
export async function listStainSlidesForSections(sectionIds: number[]): Promise<Slide[]> {
  if (sectionIds.length === 0) return [];
  const db = await getDb();
  const placeholders = sectionIds.map(() => "?").join(", ");
  return db.select<Slide[]>(
    `SELECT sl.*, s.sample_code AS parent_code
       FROM slides sl
       JOIN section_requests sr ON sr.id = sl.section_request_id
       JOIN samples s ON s.id = sr.sample_id
      WHERE sl.section_request_id IN (${placeholders}) AND sl.purpose = 'stain'
        AND sl.current_stage != 'removed'
      ORDER BY sl.section_request_id, sl.slide_ordinal, sl.id`,
    sectionIds,
  );
}

// The substages a cross-sample stain rack occupies while it moves through the
// reagents. Downstream stages (ready_for_imaging onward) are per-sample.
const STAIN_RACK_STAGES = [
  "stain_requested", "stained", "ihc_complete",
  "refrax_complete", "coverslipped", "dried",
];

/** The one open per-sample downstream stack for (sample, stage), if any. */
export async function getOpenSampleStack(
  sampleId: number,
  stageKey: string,
  excludeId?: number,
): Promise<SlideStack | null> {
  const db = await getDb();
  const rows = await db.select<SlideStack[]>(
    `SELECT * FROM slide_stacks
      WHERE kind = 'sample' AND sample_id = ? AND current_stage = ?
        AND closed_at IS NULL AND (? IS NULL OR id != ?)
      ORDER BY id ASC LIMIT 1`,
    [sampleId, stageKey, excludeId ?? null, excludeId ?? null],
  );
  return rows[0] ?? null;
}

/**
 * The open "loading" rack for an assay agent — the cross-sample stain stack
 * still at stain_requested that newly-staining slides of this agent join. Racks
 * that have advanced never accept new members (they scatter at imaging), so
 * there is at most one loading rack per agent.
 *
 * A rack leaves "loading" the moment ANY substage work is recorded, and that
 * happens two different ways (issue #81):
 *   • a board move — `updateSlideStackStage` sets `current_stage`, and
 *   • a protocol checkbox — `syncAssayStackWorkflowStep` stamps only the
 *     substage timestamp (stained / coverslipped / …) and deliberately leaves
 *     `current_stage` at 'stain_requested' until the whole checklist is done.
 * Matching on `current_stage` alone therefore missed the checkbox path: a rack
 * whose "Stained" box was ticked still looked like a loading rack, so freshly
 * moved samples merged into it and could no longer be separated. Require the
 * substage stamps to be clear as well, so a rack that has started its protocol
 * is closed to new members.
 */
export async function getOpenStainRack(
  assayType: string,
  assayName: string,
): Promise<SlideStack | null> {
  const db = await getDb();
  const rows = await db.select<SlideStack[]>(
    `SELECT * FROM slide_stacks
      WHERE kind = 'stain' AND assay_type = ? AND assay_name = ?
        AND current_stage = 'stain_requested' AND closed_at IS NULL
        AND stage_stained_at IS NULL
        AND stage_ihc_at IS NULL
        AND stage_refrax_at IS NULL
        AND stage_coverslipped_at IS NULL
        AND stage_dried_at IS NULL
        -- …and NO MEMBER SLIDE has been worked on either.
        --
        -- The stack columns above are only written by updateSlideStackStage and
        -- syncAssayStackWorkflowStep — the RACK drawer's checkboxes. There is a
        -- SECOND set of the same checkboxes in the cut-group drawer, wired to
        -- syncAssayWorkflowStep, which stamps slides and section_requests
        -- and never touches slide_stacks. Keying "is this rack still loading?"
        -- off the stack row therefore missed that path entirely, and the rack
        -- kept absorbing new samples — the reported bug, via a route the first
        -- fix never looked at.
        --
        -- The SLIDES are the real record of what has been stained: every path
        -- that advances a protocol must write them, because that is what the
        -- bench is tracking. Deriving from them closes both checkboxes and any
        -- third one added later.
        AND NOT EXISTS (
          SELECT 1 FROM slides sl
           WHERE sl.stack_id = slide_stacks.id
             AND sl.purpose = 'stain'
             AND (sl.stage_stained_at IS NOT NULL
               OR sl.stage_refrax_at IS NOT NULL
               OR sl.stage_coverslipped_at IS NOT NULL
               OR sl.stage_dried_at IS NOT NULL)
        )
        -- …and it is not already FULL (#123).
        --
        -- A rack holds a fixed number of slides — 24 by default, configurable
        -- because it is a fact about the lab's hardware. Without this the app
        -- piled every slide waiting for an agent into one rack, so the board
        -- showed a single rack of forty that nobody could actually carry. A full
        -- rack is skipped and the next slide opens a fresh one, which is exactly
        -- what happens at the bench.
        --
        -- Removed slides do not count: the glass is gone, so its place is free.
        AND (
          SELECT COUNT(*) FROM slides sl
           WHERE sl.stack_id = slide_stacks.id AND sl.current_stage <> 'removed'
        ) < ?
      ORDER BY id ASC LIMIT 1`,
    [assayType, assayName, rackCapacity(await getAppSettings(), assayType)],
  );
  return rows[0] ?? null;
}

export async function getSlideStack(id: number): Promise<SlideStack | null> {
  const db = await getDb();
  const rows = await db.select<SlideStack[]>(`SELECT * FROM slide_stacks WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

/**
 * Retire a rack outright — it was merged into another, or the user retired it.
 *
 * Closed, not deleted (#83). The rack and its protocol checklist are the record
 * of reagent steps that were actually performed on real slides; dropping the row
 * because the rack was consumed by a merge would erase that. Every rack read
 * already filters `closed_at IS NULL`, so this is invisible on the board.
 */
export async function closeSlideStack(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    // Never retire a rack that still holds live glass.
    //
    // Callers use this after moving every slide out — a scatter, a merge — so
    // the condition is normally satisfied and this behaves exactly as before.
    // What it stops is the racing case: a slide landing in the rack between the
    // caller reading its members and this statement running. Closing then would
    // put live glass somewhere the board never draws, which is the worst
    // outcome available and is what the concurrent swarm kept reaching.
    //
    // Analyzed and removed slides do NOT hold a rack open: a stack reaching
    // `analyzed` is retired WITH its slides, which is the record, not a leak.
    `UPDATE slide_stacks SET closed_at = COALESCE(closed_at, ?)
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM slides
           WHERE stack_id = ? AND current_stage NOT IN ('analyzed', 'removed')
        )`,
    [nowTimestamp(), id, id],
  );
}

/**
 * Retire a rack once its last slide has left it (#83).
 *
 * Closed, not deleted — nothing in this app is ever deleted. `closed_at` is the
 * mechanism 0018 already built for exactly this, and every rack lookup already
 * filters `closed_at IS NULL`, so the board behaves identically to the old
 * DELETE while the rack (and its completed protocol checklist) survives for the
 * record. The checklist runs are kept for the same reason: they are the evidence
 * that the reagent steps were performed.
 */
export async function closeSlideStackIfEmpty(id: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE slide_stacks
        SET closed_at = ?
      WHERE id = ? AND closed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM slides WHERE stack_id = ?)`,
    [nowTimestamp(), id, id],
  );
  // …and then sweep. Asking about ONE rack at ONE moment loses the race where
  // two calls each empty a different slide out of the same rack: each looks,
  // still sees the other's slide, declines to close — and both finish, leaving
  // an empty rack on the board promising work that does not exist. The swarm
  // reached this in six rounds.
  //
  // The sweep is a single statement over every rack, so it has no window of its
  // own, and it is cheap: `slide_stacks` is small and this only runs when a
  // slide has just moved. Every existing caller of this function gets it, which
  // is deliberate — the alternative is remembering to sweep at each of them,
  // and forgetting one is how this class of bug arrives in the first place.
  await closeEmptyOpenStacks();
  return result.rowsAffected > 0;
}

/** Retire every rack that has been left empty, whatever emptied it. */
export async function closeEmptyOpenStacks(): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE slide_stacks
        SET closed_at = ?
      WHERE closed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM slides WHERE stack_id = slide_stacks.id)`,
    [nowTimestamp()],
  );
  return result.rowsAffected;
}

/**
 * The twin of {@link closeSlideStackIfEmpty}: a rack holding live glass is not
 * retired, whatever happened a moment ago.
 *
 * Choosing a rack and putting a slide in it are separated by `await`, so a rack
 * read as open can be retired by another call before the slide lands — and then
 * the slide is inside something the board no longer draws, which is the worst
 * outcome available. The concurrent swarm reached it: `DD-0004-B` alive in stack
 * 53, closed 02:58.
 *
 * Rather than lock, this makes the outcome self-correcting: whoever finishes
 * last leaves the rack in the state its contents demand. One statement, so no
 * window of its own.
 */
export async function reopenSlideStackIfPopulated(id: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE slide_stacks
        SET closed_at = NULL
      WHERE id = ? AND closed_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM slides
           WHERE stack_id = ? AND current_stage NOT IN ('analyzed', 'removed')
        )`,
    [id, id],
  );
  return result.rowsAffected > 0;
}

export async function reinsertSlideStack(snapshot: SlideStack): Promise<void> {
  const db = await getDb();
  const columns = [
    "id", "kind", "assay_type", "assay_name", "sample_id", "current_stage",
    ...Object.values(STACK_STAGE_COLUMNS), "closed_at", "created_at",
  ];
  const values = columns.map((column) => (snapshot as unknown as Record<string, unknown>)[column]);
  await db.execute(
    `INSERT INTO slide_stacks (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values,
  );
}

export interface ChecklistRunSnapshot {
  id: number;
  scope_type: string;
  scope_id: number;
  stage_key: string;
  protocol_name: string;
  protocol_version: number;
  completed_at: string | null;
  created_at: string;
  items: ChecklistItem[];
}

export async function listChecklistRunsForScope(
  scopeType: string,
  scopeId: number,
): Promise<ChecklistRunSnapshot[]> {
  const db = await getDb();
  const runs = await db.select<Array<Omit<ChecklistRunSnapshot, "items">>>(
    `SELECT * FROM checklist_runs WHERE scope_type = ? AND scope_id = ? ORDER BY id`,
    [scopeType, scopeId],
  );
  return Promise.all(runs.map(async (run) => ({
    ...run,
    items: await db.select<ChecklistItem[]>(
      `SELECT * FROM checklist_items WHERE checklist_run_id = ? ORDER BY sort_order, id`,
      [run.id],
    ),
  })));
}

export async function reinsertChecklistRuns(snapshots: ChecklistRunSnapshot[]): Promise<void> {
  const db = await getDb();
  for (const run of snapshots) {
    await db.execute(
      `INSERT INTO checklist_runs
        (id, scope_type, scope_id, stage_key, protocol_name, protocol_version, completed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [run.id, run.scope_type, run.scope_id, run.stage_key, run.protocol_name,
        run.protocol_version, run.completed_at, run.created_at],
    );
    for (const item of run.items) {
      await db.execute(
        `INSERT INTO checklist_items
          (id, checklist_run_id, item_key, label, sort_order, is_required, is_complete,
           completed_by, completed_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [item.id, item.checklist_run_id, item.item_key, item.label, item.sort_order,
          item.is_required, item.is_complete, item.completed_by, item.completed_at, item.notes],
      );
    }
  }
}

/** The loading rack for an agent, creating it if none is open. */
async function getOrCreateStainRack(assayType: string, assayName: string): Promise<number> {
  const existing = await getOpenStainRack(assayType, assayName);
  if (existing) return existing.id;
  const db = await getDb();
  const timestamp = nowTimestamp();
  const result = await db.execute(
    `INSERT INTO slide_stacks
      (kind, assay_type, assay_name, sample_id, current_stage, stage_stain_requested_at)
     VALUES ('stain', ?, ?, NULL, 'stain_requested', ?)`,
    [assayType, assayName, timestamp],
  );
  if (result.lastInsertId == null) throw new Error("Could not create the stain rack.");
  return result.lastInsertId;
}

/**
 * Load a section's stain slides into their agents' racks. A section can carry
 * several agents (H&E + SafO + CD31), so each slide joins the cross-sample
 * loading rack for its own agent (issue #5 rework, 0.3.3).
 */
async function attachSectionStainSlidesToRacks(sectionId: number): Promise<void> {
  const db = await getDb();
  const agents = await db.select<Array<{ assay_type: string; assay_name: string }>>(
    `SELECT DISTINCT assay_type, assay_name
       FROM slides
      WHERE section_request_id = ? AND purpose = 'stain'
        AND current_stage != 'removed'`,
    [sectionId],
  );
  // Where these slides are coming FROM, captured before the move. A slide is not
  // always arriving from nowhere: a group sent back to stain_requested pulls its
  // slides out of whatever stack they were in, and if that empties a per-sample
  // stack, the stack stays on the board promising work that no longer exists.
  //
  // Third instance of one pattern — `reassignSlide` and `removeSlide` had it too.
  // Moving a slide out of a stack and retiring the stack it emptied are one
  // operation; every place that does the first must do the second.
  const vacated = await db.select<Array<{ stack_id: number }>>(
    `SELECT DISTINCT stack_id FROM slides
      WHERE section_request_id = ? AND purpose = 'stain' AND stack_id IS NOT NULL`,
    [sectionId],
  );

  for (const agent of agents) {
    const rackId = await getOrCreateStainRack(agent.assay_type, agent.assay_name);
    await db.execute(
      `UPDATE slides SET stack_id = ?
        WHERE section_request_id = ? AND purpose = 'stain'
          AND assay_type = ? AND assay_name = ?`,
      [rackId, sectionId, agent.assay_type, agent.assay_name],
    );
  }

  for (const previous of vacated) await closeSlideStackIfEmpty(previous.stack_id);
  const landed = await db.select<Array<{ stack_id: number }>>(
    `SELECT DISTINCT stack_id FROM slides
      WHERE section_request_id = ? AND purpose = 'stain' AND stack_id IS NOT NULL`,
    [sectionId],
  );
  for (const rack of landed) await reopenSlideStackIfPopulated(rack.stack_id);
}

const STACK_STAGE_COLUMNS: Record<string, string> = {
  stain_requested: "stage_stain_requested_at",
  stained: "stage_stained_at",
  ihc_complete: "stage_ihc_at",
  refrax_complete: "stage_refrax_at",
  coverslipped: "stage_coverslipped_at",
  dried: "stage_dried_at",
  ready_for_imaging: "stage_ready_for_imaging_at",
  pictures_taken: "stage_pictures_taken_at",
  analyzed: "stage_analyzed_at",
};

const STACK_RESTORE_COLUMNS = [
  "kind", "assay_type", "assay_name", "sample_id", "current_stage",
  ...Object.values(STACK_STAGE_COLUMNS), "closed_at",
] as const;

export async function restoreSlideStack(snapshot: SlideStack): Promise<void> {
  const db = await getDb();
  const assignments = STACK_RESTORE_COLUMNS.map((column) => `${column} = ?`).join(", ");
  const values = STACK_RESTORE_COLUMNS.map(
    (column) => (snapshot as unknown as Record<string, unknown>)[column],
  );
  await db.execute(`UPDATE slide_stacks SET ${assignments} WHERE id = ?`, [...values, snapshot.id]);
}

export async function listOpenSlideStacks(): Promise<SlideStack[]> {
  const db = await getDb();
  // A 'stain' rack spans samples (sample_id NULL); a 'sample' stack owns one.
  // Member facts (sample codes, priority, project activity) are derived from the
  // slides so both kinds render from one query. parent_code is the display
  // handle: the agent name for a rack, the sample code for a sample stack.
  return db.select<SlideStack[]>(
    `SELECT ss.*,
            s.project_id,
            CASE WHEN ss.kind = 'stain' THEN ss.assay_name ELSE s.sample_code END AS parent_code,
            CASE WHEN ss.kind = 'stain' THEN '' ELSE s.sample_description END AS parent_description,
            COALESCE(MAX(COALESCE(s.is_priority, msamp.is_priority)), 0) AS is_priority,
            COALESCE(p.code, mproj.code) AS project_code,
            COALESCE(p.name, mproj.name) AS project_name,
            COUNT(sl.id) AS slide_count,
            COALESCE(SUM(CASE WHEN sl.purpose = 'stain' THEN 1 ELSE 0 END), 0)
              AS assay_slide_count,
            COALESCE(MAX(CASE WHEN sl.purpose = 'stain' AND sl.assay_type = 'stain' THEN 1 ELSE 0 END), 0)
              AS has_stain,
            COALESCE(MAX(CASE WHEN sl.purpose = 'stain' AND sl.assay_type = 'ihc' THEN 1 ELSE 0 END), 0)
              AS has_ihc,
            COALESCE(GROUP_CONCAT(DISTINCT msamp.sample_code), '') AS member_sample_codes,
            COALESCE(GROUP_CONCAT(
              CASE WHEN sl.purpose = 'stain' THEN
                sl.slide_code || ': ' || CASE WHEN sl.assay_type = 'ihc'
                  THEN 'IHC: ' || sl.assay_name
                  ELSE 'Stain: ' || COALESCE(NULLIF(sl.assay_name, ''), sl.stain_name)
                END
              END,
              ' · '
            ), '') AS slide_summary,
            -- Plain, delimited agent list for filtering (issue #82). slide_summary
            -- is display text; parsing it back out would be brittle.
            COALESCE(GROUP_CONCAT(DISTINCT NULLIF(sl.assay_name, '')), '') AS agent_names,
            -- Which H&E rack this is: the 1st, the 7th, the 30th.
            --
            -- Two racks for the same agent are two identical cards, and "the H&E
            -- rack" stops identifying anything the moment there are two of them.
            -- This replaces the amber "new rack" tag, which only said THAT there
            -- was an earlier one, never which of them you were looking at.
            --
            -- Counted over EVERY rack for the agent, closed ones included, so the
            -- number is fixed for the life of the rack. Counting only open racks
            -- would renumber the survivors each time one finished — the rack a
            -- technician wrote "H&E 2" on in marker would silently become H&E 1.
            CASE WHEN ss.kind = 'stain' THEN (
              SELECT COUNT(*) FROM slide_stacks earlier
               WHERE earlier.kind = 'stain'
                 AND earlier.assay_type = ss.assay_type
                 AND earlier.assay_name = ss.assay_name
                 AND earlier.id <= ss.id
            ) END AS rack_ordinal
       FROM slide_stacks ss
       LEFT JOIN samples s ON s.id = ss.sample_id
       LEFT JOIN projects p ON p.id = s.project_id
       LEFT JOIN slides sl ON sl.stack_id = ss.id
       LEFT JOIN section_requests msr ON msr.id = sl.section_request_id
       LEFT JOIN samples msamp ON msamp.id = msr.sample_id
       LEFT JOIN projects mproj ON mproj.id = msamp.project_id
      WHERE ss.closed_at IS NULL
        AND (ss.kind = 'stain' OR p.is_active = 1)
        -- Archiving clears the board (#74). A PER-SAMPLE stack goes with its
        -- sample. A cross-sample RACK holds other people's slides, so it only
        -- goes once every member's sample is archived — otherwise archiving one
        -- block would hide a rack the rest of the lab is still working.
        AND (
          (ss.sample_id IS NOT NULL AND s.archived_at IS NULL)
          OR (
            ss.sample_id IS NULL AND (
              EXISTS (
                SELECT 1 FROM slides live_sl
                  JOIN section_requests live_sr ON live_sr.id = live_sl.section_request_id
                  JOIN samples live_s ON live_s.id = live_sr.sample_id
                 WHERE live_sl.stack_id = ss.id AND live_s.archived_at IS NULL
              )
              -- A rack with no members yet is not "fully archived"; keep it.
              OR NOT EXISTS (SELECT 1 FROM slides any_sl WHERE any_sl.stack_id = ss.id)
            )
          )
        )
      GROUP BY ss.id
      ORDER BY is_priority DESC, ss.created_at ASC, ss.id ASC`,
  );
}

/** Distinct sample ids owning slides in a stack (a stain rack spans several). */
export async function listStackSampleIds(stackId: number): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<Array<{ sample_id: number }>>(
    `SELECT DISTINCT sr.sample_id
       FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sl.stack_id = ?`,
    [stackId],
  );
  return rows.map((r) => r.sample_id);
}

export async function listSlidesForStack(stackId: number): Promise<Slide[]> {
  const db = await getDb();
  return db.select<Slide[]>(
    `SELECT sl.*, s.sample_code AS parent_code,
            p.code AS project_code, p.name AS project_name
       FROM slides sl
       JOIN section_requests sr ON sr.id = sl.section_request_id
       JOIN samples s ON s.id = sr.sample_id
       JOIN projects p ON p.id = s.project_id
      WHERE sl.stack_id = ?
      -- Order by the project + the NUMERIC sample number, not the code text.
      -- A BINARY sort over mixed-width codes puts "EE-10" before "EE-2" (#87).
      ORDER BY p.code, s.project_sample_number, sl.slide_ordinal, sl.id`,
    [stackId],
  );
}

export async function updateSlideStackStage(stackId: number, stageKey: string): Promise<number> {
  const column = STACK_STAGE_COLUMNS[stageKey];
  if (!column) throw new Error(`Unknown slide-stack stage: ${stageKey}`);
  const source = await getSlideStack(stackId);
  if (!source) throw new Error("That slide stack no longer exists.");
  const db = await getDb();
  const timestamp = nowTimestamp();
  const slideColumn = SECTION_STAGE_COLUMNS[stageKey];

  // Completing imaging must never invent a photograph.
  //
  // A per-sample stack keeps accepting slides after its imaging session: a
  // second rack scattering in is not a bug but a rule — `idx_slide_stacks_sample_stage`
  // makes one open stack per (sample, stage) a UNIQUE constraint, so there is
  // nowhere else for a late arrival to go. That is fine for the board (one card
  // per block) and fatal for the record: the old code advanced the stack and
  // stamped EVERY member, so glass that arrived after the operator left the
  // microscope was recorded as photographed.
  //
  // Since the slides cannot be set aside, the action is refused instead, naming
  // the glass. The operator images it, or removes it — both of which are true
  // things to say. Silently stamping it is not.
  if (stageKey === "pictures_taken") {
    const unimaged = await db.select<Array<{ code: string }>>(
      `SELECT sl.slide_code AS code
         FROM slides sl
        WHERE sl.stack_id = ? AND sl.purpose = 'stain'
          AND sl.current_stage <> 'removed'
          AND sl.stage_pictures_taken_at IS NULL
        ORDER BY sl.slide_ordinal, sl.id`,
      [stackId],
    );
    if (unimaged.length > 0) {
      const names = unimaged.map((row) => displayCode(row.code)).join(", ");
      throw new Error(
        `${names} ${unimaged.length === 1 ? "has" : "have"} no images captured yet. ` +
          "Tick each slide that was photographed — or remove the ones that were not — before completing imaging.",
      );
    }
  }
  const setSlideStage = async (targetStackId: number) => {
    if (slideColumn) {
      await db.execute(
        `UPDATE slides SET current_stage = ?, ${slideColumn} = COALESCE(${slideColumn}, ?)
          WHERE stack_id = ? AND purpose = 'stain'`,
        [stageKey, timestamp, targetStackId],
      );
    } else {
      await db.execute(
        `UPDATE slides SET current_stage = ? WHERE stack_id = ? AND purpose = 'stain'`,
        [stageKey, targetStackId],
      );
    }
  };

  // A cross-sample stain rack: advances through the reagent substages as a unit
  // and NEVER merges with another rack. When it leaves staining it SCATTERS —
  // each member slide rejoins its own sample's per-sample imaging stack.
  if (source.kind === "stain") {
    if (STAIN_RACK_STAGES.includes(stageKey)) {
      await setSlideStage(stackId);
      await db.execute(
        `UPDATE slide_stacks SET current_stage = ?, ${column} = COALESCE(${column}, ?) WHERE id = ?`,
        [stageKey, timestamp, stackId],
      );
      return stackId;
    }
    // Scatter into per-sample stacks at the downstream stage.
    const members = await db.select<Array<{ id: number; sample_id: number }>>(
      `SELECT sl.id, sr.sample_id
         FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
        WHERE sl.stack_id = ?`,
      [stackId],
    );
    for (const member of members) {
      const target = await getOrCreateSampleStack(member.sample_id, stageKey, timestamp);
      await db.execute(
        slideColumn
          ? `UPDATE slides SET stack_id = ?, current_stage = ?, ${slideColumn} = COALESCE(${slideColumn}, ?) WHERE id = ?`
          : `UPDATE slides SET stack_id = ?, current_stage = ? WHERE id = ?`,
        slideColumn ? [target, stageKey, timestamp, member.id] : [target, stageKey, member.id],
      );
    }
    await closeSlideStack(stackId); // rack consumed
    // The per-sample stacks these slides landed in may have been retired by a
    // call that finished between our choosing them and our writing to them.
    for (const member of members) {
      const landed = await db.select<Array<{ stack_id: number | null }>>(
        `SELECT stack_id FROM slides WHERE id = ?`,
        [member.id],
      );
      if (landed[0]?.stack_id != null) await reopenSlideStackIfPopulated(landed[0].stack_id);
    }
    return stackId;
  }

  // A per-sample stack: advance, merging with the same sample's stack already at
  // the destination stage (companion convergence, unchanged from 0.3.2).
  await setSlideStage(stackId);
  const mergeTarget = stageKey === "analyzed"
    ? null
    : await getOpenSampleStack(source.sample_id ?? -1, stageKey, source.id);
  if (mergeTarget) {
    await db.execute(`UPDATE slides SET stack_id = ? WHERE stack_id = ?`, [mergeTarget.id, source.id]);
    await db.execute(
      `UPDATE slide_stacks SET ${column} = COALESCE(${column}, ?) WHERE id = ?`,
      [timestamp, mergeTarget.id],
    );
    await closeSlideStack(source.id);
    return mergeTarget.id;
  }
  await db.execute(
    `UPDATE slide_stacks
        SET current_stage = ?, ${column} = COALESCE(${column}, ?),
            closed_at = CASE WHEN ? = 'analyzed' THEN COALESCE(closed_at, ?) ELSE NULL END
      WHERE id = ?`,
    [stageKey, timestamp, stageKey, timestamp, stackId],
  );
  return stackId;
}

/** The one open per-sample stack for (sample, stage), created if absent. */
async function getOrCreateSampleStack(
  sampleId: number,
  stageKey: string,
  timestamp: string,
): Promise<number> {
  const existing = await getOpenSampleStack(sampleId, stageKey);
  if (existing) return existing.id;
  const db = await getDb();
  const column = STACK_STAGE_COLUMNS[stageKey] ?? "stage_ready_for_imaging_at";
  const result = await db.execute(
    `INSERT INTO slide_stacks (kind, sample_id, current_stage, ${column})
     VALUES ('sample', ?, ?, ?)`,
    [sampleId, stageKey, timestamp],
  );
  if (result.lastInsertId == null) throw new Error("Could not create the sample stack.");
  return result.lastInsertId;
}

export async function syncAssayStackWorkflowStep(
  stackId: number,
  assayType: "stain" | "ihc",
  sortOrder: number,
  complete: boolean,
): Promise<void> {
  const db = await getDb();
  const timestamp = complete ? nowTimestamp() : null;
  // Steps: 0 Stained/IHC, 1 Coverslipped (+refrax). (Deparaffinization was
  // dropped as a tracked step — #59; drying likewise — #80. Both columns are
  // retained for compat.)
  //
  // Step 2 (Dried) is KEPT here on purpose even though no new checklist offers
  // it: `ensureChecklist` reuses an existing run, so a rack that was already
  // mid-protocol when this build landed still has its three-item checklist and
  // must be able to finish it. Deleting this branch would strand those racks.
  // A rack step writes the SLIDES, and a rack is not the only thing that ever
  // stains a slide: a slide reassigned in (#115) can arrive already stained, on
  // a different day, in a different rack. So:
  //
  //   ticking   COALESCEs — an existing date is the truth about that glass and
  //             a later rack tick does not get to rewrite it. Before this, the
  //             statement was a bare `SET`, so ticking a rack rewrote the
  //             stained date of every member; a slide stained in 2020 and moved
  //             in today read as stained today.
  //   unticking clears ONLY the slides this rack stamped, identified by their
  //             carrying the rack's own timestamp. A bare `SET … = NULL` wiped
  //             the whole rack, including dates it never wrote.
  //
  // (If a slide arrived already carrying a stamp equal to this rack's, to the
  // second, unticking will clear it too. That needs two racks stamping in the
  // same second and a move between them; the alternative is a per-slide
  // provenance column, which is not worth a wire-format change for it.)
  const clearMatching = async (columns: string[], keyColumn: string, stackColumn: string) => {
    const rows = await db.select<Array<Record<string, string | null>>>(
      `SELECT ${stackColumn} AS stamp FROM slide_stacks WHERE id = ?`,
      [stackId],
    );
    const stamp = rows[0]?.stamp ?? null;
    if (stamp === null) return;
    await db.execute(
      // Never strand a later stamp: clearing the stain under a coverslip leaves
      // the same impossible record by the other route, and the condition has to
      // be in the statement for the same reason as above.
      `UPDATE slides SET ${columns.map((c) => `${c} = NULL`).join(", ")}
        WHERE stack_id = ? AND purpose = 'stain' AND assay_type = ? AND ${keyColumn} = ?
          ${keyColumn === "stage_stained_at" ? "AND stage_coverslipped_at IS NULL" : ""}`,
      [stackId, assayType, stamp],
    );
  };

  if (sortOrder === 0) {
    const stackColumn = assayType === "ihc" ? "stage_ihc_at" : "stage_stained_at";
    if (complete) {
      // A slide that ALREADY carries a stained date is going through the stainer
      // a second time — a pale H&E re-run, a counterstain, or a slide that moved
      // in from another rack. The column holds one date and keeps the first
      // (above), so without this the second run would leave no trace at all.
      // The timeline is where a thing that happened twice gets to be said twice.
      const restained = await db.select<Array<{ code: string; sample_id: number; at: string }>>(
        `SELECT sl.slide_code AS code, sr.sample_id AS sample_id, sl.stage_stained_at AS at
           FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
          WHERE sl.stack_id = ? AND sl.purpose = 'stain' AND sl.assay_type = ?
            AND sl.current_stage <> 'removed' AND sl.stage_stained_at IS NOT NULL`,
        [stackId, assayType],
      );
      await db.execute(
        `UPDATE slides SET stage_stained_at = COALESCE(stage_stained_at, ?)
          WHERE stack_id = ? AND purpose = 'stain' AND assay_type = ?`,
        [timestamp, stackId, assayType],
      );
      for (const slide of restained) {
        await db.execute(
          `INSERT INTO sample_timeline_events
            (sample_id, user_id, event_type, summary, details, created_at)
           VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
                   'slide_restained', ?, ?, ?)`,
          [
            slide.sample_id,
            `${displayCode(slide.code)} went through the stainer again`,
            JSON.stringify({ slide_code: slide.code, first_stained_at: slide.at, again_at: timestamp }),
            timestamp,
          ],
        );
      }
    } else {
      await clearMatching(["stage_stained_at"], "stage_stained_at", stackColumn);
    }
    await db.execute(
      `UPDATE slide_stacks SET ${stackColumn} = ${complete ? `COALESCE(${stackColumn}, ?)` : "?"} WHERE id = ?`,
      [timestamp, stackId],
    );
  } else if (sortOrder === 1) {
    if (complete) {
      // A coverslip seals the section, so it cannot precede the stain. The
      // checklist guards the order too, but this function is exported and two
      // components call it directly — the rule belongs where the stamp is
      // written, not only where the box is ticked. The swarm reached exactly
      // this: a slide cut 02:32, coverslipped 02:33, stained 02:34.
      const unstained = await db.select<Array<{ slide_code: string }>>(
        `SELECT slide_code FROM slides
          WHERE stack_id = ? AND purpose = 'stain' AND assay_type = ?
            AND current_stage <> 'removed' AND stage_stained_at IS NULL
          LIMIT 1`,
        [stackId, assayType],
      );
      if (unstained[0]) {
        throw new Error(
          `${displayCode(unstained[0].slide_code)} has not been stained yet — record staining before coverslipping.`,
        );
      }
      // `AND stage_stained_at IS NOT NULL` is the enforcement; the check above is
      // only there to produce a sentence a human can read. A check and a write
      // separated by an `await` is a window: the swarm slipped an untick into it
      // and produced ten slides coverslipped before they were stained. Put the
      // condition in the statement and the window closes, because SQLite decides
      // per row at the moment of the write.
      await db.execute(
        `UPDATE slides
            SET stage_refrax_at = COALESCE(stage_refrax_at, ?),
                stage_coverslipped_at = COALESCE(stage_coverslipped_at, ?)
          WHERE stack_id = ? AND purpose = 'stain' AND assay_type = ?
            AND stage_stained_at IS NOT NULL`,
        [timestamp, timestamp, stackId, assayType],
      );
    } else {
      await clearMatching(
        ["stage_refrax_at", "stage_coverslipped_at"],
        "stage_coverslipped_at",
        "stage_coverslipped_at",
      );
    }
    await db.execute(
      `UPDATE slide_stacks
          SET stage_refrax_at = ${complete ? "COALESCE(stage_refrax_at, ?)" : "?"},
              stage_coverslipped_at = ${complete ? "COALESCE(stage_coverslipped_at, ?)" : "?"}
        WHERE id = ?`,
      [timestamp, timestamp, stackId],
    );
  } else if (sortOrder === 2) {
    if (complete) {
      await db.execute(
        `UPDATE slides SET stage_dried_at = COALESCE(stage_dried_at, ?)
          WHERE stack_id = ? AND purpose = 'stain' AND assay_type = ?`,
        [timestamp, stackId, assayType],
      );
    } else {
      await clearMatching(["stage_dried_at"], "stage_dried_at", "stage_dried_at");
    }
    await db.execute(
      `UPDATE slide_stacks SET stage_dried_at = ${complete ? "COALESCE(stage_dried_at, ?)" : "?"} WHERE id = ?`,
      [timestamp, stackId],
    );
  }

  const assayTypes = await db.select<Array<{ assay_type: "stain" | "ihc" }>>(
    `SELECT DISTINCT assay_type FROM slides
      WHERE stack_id = ? AND purpose = 'stain' AND assay_type IN ('stain', 'ihc')`,
    [stackId],
  );
  if (assayTypes.length === 0) return;
  const completion = await Promise.all(
    assayTypes.map((row) =>
      checklistComplete("slide_stack", stackId, `${row.assay_type}_workflow_v5`),
    ),
  );
  if (completion.every(Boolean)) await updateSlideStackStage(stackId, "ready_for_imaging");
}

export async function completeSlideStackImaging(stackId: number): Promise<number> {
  return updateSlideStackStage(stackId, "pictures_taken");
}

export async function removeSlidesForStack(stackId: number, reason: string): Promise<void> {
  const db = await getDb();
  // Read the membership BEFORE removing anything — `removeSlide` detaches each
  // slide from the rack, so afterwards nothing points back here (#83).
  const members = await db.select<Array<{ id: number; section_request_id: number }>>(
    `SELECT id, section_request_id FROM slides
      WHERE stack_id = ? AND current_stage != 'removed'`,
    [stackId],
  );
  // Routed through removeSlide rather than one bulk UPDATE so this path gets the
  // same letter high-water mark and the same per-slide timeline entry as the
  // drawer's one-at-a-time removal. The two paths disagreeing on the same slides
  // in the same drawer is exactly what #83 was reopened for.
  for (const member of members) await removeSlide(member.id, reason);
  const affected = [
    ...new Set(members.map((m) => m.section_request_id).filter((id) => id != null)),
  ];
  for (const sectionId of affected) await removeSectionRequestIfEmpty(sectionId);
}

export interface ExtraSlideAssignResult {
  stackId: number;
  createdStackId: number | null;
}

/**
 * Send an inventory extra into the sample's open stack while preserving the
 * section request that records where the physical slide was cut.
 */
/**
 * Route a newly-requested stain for a sample (issues #2, #39). The agent is
 * recorded on the sample, then the request is pulled from an available extra
 * first — that extra moves DIRECTLY into staining (joining the agent's rack) so
 * it shows up in the Staining lane and leaves the inventory in one step. If no
 * extra is free the flag rests on the block, which needs a fresh cut.
 */
export async function requestStainForSample(input: {
  sampleId: number;
  assayType: "stain" | "ihc";
  assayName: string;
}): Promise<{
  target: "extra" | "cut" | "block";
  slideId: number | null;
  stackId: number | null;
  createdStackId: number | null;
  sectionId?: number;
}> {
  const db = await getDb();
  const assayName = input.assayName.trim();
  // Pull from an available extra first — that fulfils the request immediately
  // (the extra becomes this stain and enters Staining), so nothing is added to
  // the outstanding multiset. Only when no extra is free does the request rest
  // on the block as an outstanding cut request.
  const extras = await db.select<Array<{ id: number }>>(
    // The section-stage filter is the same rule `listExtraSlides` applies (#12):
    // a slide saved as an extra is a PLAN until its group leaves the queue, and
    // the plan is not the cut (#95/#118).
    //
    // This query had no such filter, so the two disagreed about which extras
    // exist — the inventory correctly hid them, and this happily pulled one into
    // a staining rack. A block with a saved-but-unsent cutting plan would answer
    // "pulled from an extra" and put glass nobody had cut into Staining, where a
    // rack tick then recorded it as stained with no cut date. Found by the v2
    // fuzzer; the guard belongs here, at the one place that takes an extra.
    `SELECT sl.id FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sr.sample_id = ? AND sl.purpose = 'extra' AND sl.current_stage = 'extra'
        AND sr.current_stage NOT IN ('needs_sectioning', 'sectioned', 'assignment_required')
      ORDER BY sl.id LIMIT 1`,
    [input.sampleId],
  );
  if (extras.length > 0) {
    // The extra enters staining immediately (#39): join the cross-sample loading
    // rack for its agent, creating it if none is open.
    const openRack = await getOpenStainRack(input.assayType, assayName);
    const stackId = openRack?.id ?? (await getOrCreateStainRack(input.assayType, assayName));
    const timestamp = nowTimestamp();
    await db.execute(
      // An extra was cut for nothing in particular, so being pulled for this
      // agent IS its request — which is why requested_* is written here, unlike
      // a reassignment, where the order already exists and must survive.
      `UPDATE slides
          SET stack_id = ?, purpose = 'stain', assay_type = ?, assay_name = ?, stain_name = ?,
              requested_assay_type = ?, requested_assay_name = ?,
              assignment_saved = 1, slice_count = 2, control_agent = 'IgG',
              current_stage = 'stain_requested',
              stage_stain_requested_at = COALESCE(stage_stain_requested_at, ?)
        WHERE id = ?`,
      [stackId, input.assayType, assayName, assayName, input.assayType, assayName, timestamp, extras[0].id],
    );
    return {
      target: "extra",
      slideId: extras[0].id,
      stackId,
      createdStackId: openRack ? null : stackId,
    };
  }
  // No free extra — but the block may already be ON ITS WAY to the microtome
  // (#125). If a cut group is sitting in Needs Sectioning, the honest answer is
  // to put this agent on that cut, not to raise a second one.
  //
  // The old behaviour flagged the block for a fresh cut, so a block whose plan
  // read "H&E, extra, extra" and had not been cut yet came back asking to be
  // cut AGAIN the moment somebody requested PAS — two trips to the block for
  // work that was always going to happen in one. Nobody sections twice for that;
  // they add a slide to the ribbon they are about to take.
  //
  // Deliberately `needs_sectioning` only. A group that has left the queue has
  // been cut, and its glass exists — putting a new agent on it would be claiming
  // a section that was never taken. Those blocks still route to the extras
  // branch above, or to a genuine new cut below.
  const pendingCut = await db.select<Array<{ id: number }>>(
    `SELECT id FROM section_requests
      WHERE sample_id = ? AND current_stage = 'needs_sectioning'
      ORDER BY id LIMIT 1`,
    [input.sampleId],
  );
  if (pendingCut.length > 0) {
    // Appended, not inserted among the extras: slide_ordinal is the order the
    // glass comes off the block, and renumbering the existing slides to make the
    // list read prettily would rewrite a record of something already planned.
    const slideId = await addSlideToSection(pendingCut[0].id, {
      assayType: input.assayType,
      assayName,
    });
    return {
      target: "cut",
      slideId,
      stackId: null,
      createdStackId: null,
      sectionId: pendingCut[0].id,
    };
  }

  // Nothing free and nothing pending: the request flags the BLOCK for a fresh
  // cut. An exhausted block has no tissue left to cut, so that flag could never
  // be satisfied and the block would sit lit up forever — refuse it (issue #70).
  // Note this guards the cut path only: a request that an already-cut extra can
  // fulfil is handled above and stays allowed, because that slide physically
  // exists regardless of the block being spent.
  const exhaustedRows = await db.select<Array<{ block_exhausted: number; sample_code: string }>>(
    `SELECT block_exhausted, sample_code FROM samples WHERE id = ?`,
    [input.sampleId],
  );
  if (exhaustedRows[0]?.block_exhausted === 1) {
    throw new Error(
      `${exhaustedRows[0].sample_code} is marked exhausted and has no extra slides left — ` +
        `it cannot be cut again for ${assayName}.`,
    );
  }
  // Append an outstanding request (duplicates allowed, so asking for the same
  // agent twice queues two slides — #62/#66). This flags the block for a fresh
  // cut and prefills the Send-for-Cutting dialog with every outstanding agent,
  // including agents already produced on an earlier cut.
  const rows = await db.select<Array<{ preselected_stains: string }>>(
    `SELECT preselected_stains FROM samples WHERE id = ?`,
    [input.sampleId],
  );
  const current = parsePreselectedStains(rows[0]?.preselected_stains);
  current.push({ assay_type: input.assayType, assay_name: assayName });
  await db.execute(`UPDATE samples SET preselected_stains = ? WHERE id = ?`, [
    JSON.stringify(current),
    input.sampleId,
  ]);
  return { target: "block", slideId: null, stackId: null, createdStackId: null };
}

/**
 * Withdraw ONE outstanding stain request from a block (#112).
 *
 * The outstanding list is a multiset — asking twice queues two slides — so this
 * removes a single entry, not every entry naming that agent.
 *
 * This exists because the list is bookkeeping that can drift out of step with
 * the slides, and until now there was no way to correct it from the app: a
 * request stranded by a failed trim left the block flagged with no cure short of
 * editing the database. Both directions are now recoverable by hand — remove a
 * request that is no longer wanted, re-add one the repair pass cleared too
 * eagerly.
 */
export async function withdrawStainRequest(
  sampleId: number,
  assayType: string,
  assayName: string,
): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Array<{ preselected_stains: string }>>(
    `SELECT preselected_stains FROM samples WHERE id = ?`,
    [sampleId],
  );
  const current = parsePreselectedStains(rows[0]?.preselected_stains);
  const remaining = removeFromRequests(current, [
    { assay_type: assayType, assay_name: assayName },
  ]);
  if (remaining.length === current.length) return;
  await db.execute(`UPDATE samples SET preselected_stains = ? WHERE id = ?`, [
    remaining.length ? JSON.stringify(remaining) : "",
    sampleId,
  ]);
  await db.execute(
    `INSERT INTO sample_timeline_events
      (sample_id, user_id, event_type, summary, details, created_at)
     VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
             'stain_request_withdrawn', ?, ?, ?)`,
    [
      sampleId,
      `Withdrew stain request: ${assayName}`,
      JSON.stringify({ assay_type: assayType, assay_name: assayName }),
      nowTimestamp(),
    ],
  );
}

/** Resolve a sample's numeric id from its code (case-insensitive). */
export async function findSampleIdByCode(code: string): Promise<number | null> {
  const db = await getDb();
  // Match every spelling of the code (#87). Since new codes are minted unpadded
  // while older rows keep "EE-0001", a database in daily use holds both, and a
  // synced request may have been written by an instance on either build. This
  // lookup fails CLOSED and SILENTLY — githubSync's applyRequestToBlock just
  // returns when it gets null — so a padding mismatch would drop a technician's
  // request on the floor with no error anywhere.
  const variants = sampleCodeVariants(code);
  const placeholders = variants.map(() => "?").join(", ");
  const rows = await db.select<Array<{ id: number }>>(
    `SELECT id FROM samples WHERE sample_code IN (${placeholders}) COLLATE NOCASE LIMIT 1`,
    variants,
  );
  return rows[0]?.id ?? null;
}

/** Look up an agent's type (stain/ihc) from the catalog by name — lets a viewer
 *  request (which may only carry a name) resolve to a typed, formal request. */
export async function assayTypeByName(name: string): Promise<"stain" | "ihc" | null> {
  const db = await getDb();
  const rows = await db.select<Array<{ assay_type: string }>>(
    `SELECT assay_type FROM assay_catalog WHERE name = ? COLLATE NOCASE ORDER BY is_active DESC LIMIT 1`,
    [name.trim()],
  );
  const type = rows[0]?.assay_type;
  return type === "stain" || type === "ihc" ? type : null;
}

/** Undo of a stain request: return a slide to an inventory extra, unlinking it
 *  from any rack it joined and clearing the staining timestamp (#39). */
export async function revertSlideToExtra(slideId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE slides SET purpose = 'extra', assay_type = '', assay_name = '', stain_name = '',
            stack_id = NULL, current_stage = 'extra', stage_stain_requested_at = NULL
      WHERE id = ?`,
    [slideId],
  );
}

export async function assignExtraSlideToAssay(input: {
  slideId: number;
  assayType: "stain" | "ihc";
  assayName: string;
}): Promise<ExtraSlideAssignResult> {
  const db = await getDb();
  const timestamp = nowTimestamp();
  const assayName = input.assayName.trim();
  const rows = await db.select<Array<{
    sample_id: number;
    slide_code: string;
  }>>(
    `SELECT sr.sample_id, sl.slide_code
       FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sl.id = ? AND sl.purpose = 'extra' AND sl.current_stage = 'extra'`,
    [input.slideId],
  );
  const slide = rows[0];
  if (!slide) throw new Error("That extra slide is no longer available.");
  const catalog = await db.select<Array<{ id: number }>>(
    `SELECT id FROM assay_catalog WHERE assay_type = ? AND name = ? COLLATE NOCASE AND is_active = 1`,
    [input.assayType, assayName],
  );
  if (!catalog.length) throw new Error("Choose an active stain or IHC agent from the catalog.");

  // The extra enters staining: it joins the cross-sample loading rack for its
  // agent (creating it if none is open).
  const openRack = await getOpenStainRack(input.assayType, assayName);
  const stackId = openRack?.id ?? await getOrCreateStainRack(input.assayType, assayName);

  await db.execute(
    `UPDATE slides
        SET stack_id = ?,
            purpose = 'stain', assay_type = ?, assay_name = ?, stain_name = ?,
            current_stage = 'stain_requested', assignment_saved = 1,
            stage_stain_requested_at = COALESCE(stage_stain_requested_at, ?)
      WHERE id = ?`,
    [stackId, input.assayType, assayName, assayName, timestamp, input.slideId],
  );

  await reopenSlideStackIfPopulated(stackId);

  await db.execute(
    `INSERT INTO sample_timeline_events
      (sample_id, user_id, event_type, summary, created_at)
     VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
             'extra_slide_assigned', ?, ?)`,
    [slide.sample_id, `${slide.slide_code} assigned to ${input.assayType === "ihc" ? "IHC" : "stain"}: ${assayName}`, timestamp],
  );

  return {
    stackId,
    createdStackId: openRack ? null : stackId,
  };
}

export async function getSlide(id: number): Promise<Slide | null> {
  const db = await getDb();
  const rows = await db.select<Slide[]>(`SELECT * FROM slides WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function updateSlideAssignment(
  id: number,
  purpose: SlidePurpose,
  assayType: "" | "stain" | "ihc",
  assayName: string,
): Promise<void> {
  if (purpose === "stain" && (!assayType || !assayName.trim())) {
    throw new Error("Choose a stain or IHC agent for this slide.");
  }
  const db = await getDb();
  const stage =
    purpose === "stain"
      ? "assigned"
      : purpose === "unassigned"
        ? "cut"
        : purpose;
  await db.execute(
    `UPDATE slides
        SET purpose = ?, assay_type = ?, assay_name = ?, stain_name = ?, assignment_saved = 1,
            slice_count = 2, control_agent = 'IgG', current_stage = ?
      WHERE id = ?`,
    [
      purpose,
      purpose === "stain" ? assayType : "",
      purpose === "stain" ? assayName.trim() : "",
      purpose === "stain" ? assayName.trim() : "",
      stage,
      id,
    ],
  );
}

/**
 * Split slides out of their rack into a fresh one (#124).
 *
 * A rack is a physical thing: two dozen slides that travel together through the
 * reagents. Sometimes half of them need to go now and half tomorrow, or a rack
 * turns out to be over capacity after a busy morning. Until now the only way to
 * divide one was to reassign each slide to another agent and back, which is a
 * lie about the agent and does not reliably produce two racks anyway.
 *
 * Rules, each one a consequence of the rack model:
 *  · Every slide must come from the SAME rack. Splitting across racks is not a
 *    split, it is two of them, and doing it in one call would hide which slides
 *    came from where.
 *  · Not the whole rack. Moving every slide out retires the old rack and creates
 *    an identical one — a no-op with extra steps that silently changes the rack
 *    id the board has been pointing at.
 *  · One agent. A rack IS an agent plus the glass going through it.
 *  · The new rack starts empty, so the split cannot exceed capacity (#123) —
 *    checked anyway, because the ceiling is configurable and somebody will lower
 *    it below a rack that is already full.
 *
 * Work already done is untouched. A stained slide stays stained: it is the same
 * glass, in a different holder.
 */
export async function splitSlidesIntoNewRack(slideIds: number[]): Promise<number> {
  if (slideIds.length === 0) throw new Error("Choose the slides to move into a new rack.");
  const db = await getDb();
  const placeholders = slideIds.map(() => "?").join(", ");
  const rows = await db.select<
    Array<{
      id: number;
      stack_id: number | null;
      slide_code: string;
      assay_type: string;
      assay_name: string;
      current_stage: string;
      sample_id: number;
    }>
  >(
    `SELECT sl.id, sl.stack_id, sl.slide_code, sl.assay_type, sl.assay_name,
            sl.current_stage, sr.sample_id
       FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sl.id IN (${placeholders})`,
    slideIds,
  );
  if (rows.length === 0) throw new Error("Those slides no longer exist.");

  const live = rows.filter((row) => row.current_stage !== "removed");
  if (live.length === 0) throw new Error("Every one of those slides has been removed.");

  const sourceIds = [...new Set(live.map((row) => row.stack_id))];
  if (sourceIds.length > 1 || sourceIds[0] == null) {
    throw new Error("Split one rack at a time — those slides are not all in the same rack.");
  }
  const sourceId = sourceIds[0];

  const agents = [...new Set(live.map((row) => `${row.assay_type}:${row.assay_name}`))];
  if (agents.length > 1) {
    throw new Error("Those slides carry different agents — move them one agent at a time.");
  }

  const held = await db.select<Array<{ n: number }>>(
    `SELECT COUNT(*) AS n FROM slides WHERE stack_id = ? AND current_stage <> 'removed'`,
    [sourceId],
  );
  if (Number(held[0]?.n ?? 0) <= live.length) {
    throw new Error("That is the whole rack — there would be nothing left to split from.");
  }

  const assayType = live[0].assay_type;
  const assayName = live[0].assay_name;
  const capacity = rackCapacity(await getAppSettings(), assayType);
  if (live.length > capacity) {
    // Pluralised rather than articled: "a Alcian Blue rack" is what an "a/an"
    // guess produces the moment an agent starts with a vowel, and the catalogue
    // is the lab's to fill in.
    throw new Error(
      `${assayName} racks hold ${capacity} slides; you chose ${live.length}.`,
    );
  }

  // A NEW rack, deliberately — not getOpenStainRack, which would hand back a
  // half-full rack for the same agent and quietly merge instead of splitting.
  const timestamp = nowTimestamp();
  const created = await db.execute(
    `INSERT INTO slide_stacks
      (kind, assay_type, assay_name, sample_id, current_stage, stage_stain_requested_at)
     VALUES ('stain', ?, ?, NULL, 'stain_requested', ?)`,
    [assayType, assayName, timestamp],
  );
  if (created.lastInsertId == null) throw new Error("Could not create the new rack.");
  const newStackId = created.lastInsertId;

  const movedIds = live.map((row) => row.id);
  await db.execute(
    `UPDATE slides SET stack_id = ? WHERE id IN (${movedIds.map(() => "?").join(", ")})`,
    [newStackId, ...movedIds],
  );

  // One event per block, naming its own slides — a technician reading EE-4's
  // timeline should not have to read about somebody else's glass.
  for (const sampleId of new Set(live.map((row) => row.sample_id))) {
    const codes = live
      .filter((row) => row.sample_id === sampleId)
      .map((row) => displayCode(row.slide_code))
      .join(", ");
    await db.execute(
      `INSERT INTO sample_timeline_events
        (sample_id, user_id, event_type, summary, details, created_at)
       VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
               'rack_split', ?, ?, ?)`,
      [
        sampleId,
        `${codes} moved into a new ${assayName} rack`,
        JSON.stringify({ from_stack: sourceId, to_stack: newStackId, slides: movedIds }),
        timestamp,
      ],
    );
  }

  await closeSlideStackIfEmpty(sourceId);
  return newStackId;
}

/**
 * Pour several racks into one (#124).
 *
 * The inverse of a split and the more dangerous direction, because merging is
 * how a rack ends up holding glass at two different points in the protocol —
 * which is exactly what #81 was about. So the rule is strict: only racks that
 * have not started work can be merged.
 *
 * Rules:
 *  · Same agent, for the same reason a split is single-agent.
 *  · Nothing started. If any slide in any of them has been stained,
 *    coverslipped or dried, the racks are at different points, and merging would
 *    drop unstained glass into a batch that has already been through reagents.
 *  · The result must fit on the bench (#123).
 *  · Emptied racks are RETIRED, never deleted — the row stays, closed.
 */
export async function mergeSlideStacks(stackIds: number[]): Promise<number> {
  const unique = [...new Set(stackIds)];
  if (unique.length < 2) throw new Error("Choose at least two racks to merge.");
  const db = await getDb();
  const placeholders = unique.map(() => "?").join(", ");
  const racks = await db.select<
    Array<{
      id: number;
      kind: string;
      assay_type: string;
      assay_name: string;
      current_stage: string;
      closed_at: string | null;
      held: number;
      worked: number;
    }>
  >(
    `SELECT ss.id, ss.kind, ss.assay_type, ss.assay_name, ss.current_stage, ss.closed_at,
            (SELECT COUNT(*) FROM slides sl
              WHERE sl.stack_id = ss.id AND sl.current_stage <> 'removed') AS held,
            (SELECT COUNT(*) FROM slides sl
              WHERE sl.stack_id = ss.id AND sl.purpose = 'stain'
                AND (sl.stage_stained_at IS NOT NULL OR sl.stage_refrax_at IS NOT NULL
                  OR sl.stage_coverslipped_at IS NOT NULL OR sl.stage_dried_at IS NOT NULL)) AS worked
       FROM slide_stacks ss
      WHERE ss.id IN (${placeholders})
      ORDER BY ss.id`,
    unique,
  );
  if (racks.length < 2) throw new Error("Those racks no longer exist.");
  if (racks.some((rack) => rack.closed_at != null)) {
    throw new Error("One of those racks has been retired.");
  }
  if (racks.some((rack) => rack.kind !== "stain")) {
    throw new Error("Only staining and IHC racks can be merged.");
  }
  const agents = [...new Set(racks.map((rack) => `${rack.assay_type}:${rack.assay_name}`))];
  if (agents.length > 1) {
    const names = [...new Set(racks.map((rack) => rack.assay_name))].join(", ");
    throw new Error(`Those racks are for different agents (${names}).`);
  }
  if (racks.some((rack) => rack.worked > 0 || rack.current_stage !== "stain_requested")) {
    throw new Error(
      "One of those racks has already been through the reagents — merging it would put " +
        "unstained glass in with stained.",
    );
  }

  const total = racks.reduce((sum, rack) => sum + rack.held, 0);
  const capacity = rackCapacity(await getAppSettings(), racks[0].assay_type);
  if (total > capacity) {
    throw new Error(
      `That would make a rack of ${total}; ${racks[0].assay_name} racks hold ${capacity}.`,
    );
  }

  // The oldest rack wins, so the merged rack keeps the identity the board has
  // been showing all along instead of appearing as something new.
  const target = racks[0].id;
  const sources = racks.slice(1).map((rack) => rack.id);
  const sourceMarks = sources.map(() => "?").join(", ");
  const timestamp = nowTimestamp();

  const moving = await db.select<Array<{ id: number; slide_code: string; sample_id: number }>>(
    `SELECT sl.id, sl.slide_code, sr.sample_id
       FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sl.stack_id IN (${sourceMarks}) AND sl.current_stage <> 'removed'`,
    sources,
  );
  await db.execute(`UPDATE slides SET stack_id = ? WHERE stack_id IN (${sourceMarks})`, [
    target,
    ...sources,
  ]);

  for (const sampleId of new Set(moving.map((row) => row.sample_id))) {
    const codes = moving
      .filter((row) => row.sample_id === sampleId)
      .map((row) => displayCode(row.slide_code))
      .join(", ");
    await db.execute(
      `INSERT INTO sample_timeline_events
        (sample_id, user_id, event_type, summary, details, created_at)
       VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
               'rack_merged', ?, ?, ?)`,
      [
        sampleId,
        `${codes} merged into one ${racks[0].assay_name} rack`,
        JSON.stringify({
          into_stack: target,
          from_stacks: sources,
          slides: moving.map((row) => row.id),
        }),
        timestamp,
      ],
    );
  }

  for (const source of sources) await closeSlideStackIfEmpty(source);
  await reopenSlideStackIfPopulated(target);
  return target;
}

/**
 * Move ONE slide to a different agent, or back to being an extra (#115).
 *
 * `updateSlideAssignment` cannot do this once a slide has reached staining: it
 * rewrites the assay columns and resets `current_stage`, but leaves `stack_id`
 * pointing at the rack the slide is physically in. The slide would claim to be
 * CD31 while still sitting in the H&E rack, and the old rack would keep counting
 * it. Re-homing is the whole job, so it lives in its own function.
 *
 * Rules, all of them consequences of the rack model:
 *  · The slide leaves its current rack first, and that rack is retired if the
 *    slide was the last one in it (`closeSlideStackIfEmpty`, #83) — an empty
 *    rack on the board is a rack somebody will go looking for.
 *  · A new agent joins the OPEN loading rack for that agent, created if there
 *    is none. `getOpenStainRack` refuses a rack whose protocol has started
 *    (#81), so a reassigned slide can never be dropped into a batch that has
 *    already been through the reagents.
 *  · Back to extras means back to the inventory: no agent, no rack, and
 *    `current_stage = 'extra'`, which is exactly where an uncommitted cut slide
 *    starts life.
 *
 * Timestamps already earned are left alone. A slide that was stained as H&E and
 * is being re-cut as CD31 keeps its stained-at stamp, because that is what
 * happened to the physical glass — the record is not rewritten to suit the new
 * plan.
 */
export async function reassignSlide(
  slideId: number,
  target: { assayType: "stain" | "ihc"; assayName: string } | { extra: true },
): Promise<void> {
  const db = await getDb();
  const rows = await db.select<
    Array<{
      stack_id: number | null;
      current_stage: string;
      slide_code: string;
      assay_name: string | null;
      sample_id: number;
      stage_cut_at: string | null;
      stage_pictures_taken_at: string | null;
    }>
  >(
    `SELECT sl.stack_id, sl.current_stage, sl.slide_code, sl.assay_name, sr.sample_id,
            sl.stage_cut_at, sl.stage_pictures_taken_at
       FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sl.id = ?`,
    [slideId],
  );
  const slide = rows[0];
  if (!slide) throw new Error("That slide no longer exists.");
  if (slide.current_stage === "removed") {
    throw new Error("That slide was removed — restore it before reassigning it.");
  }
  // A slide that has not been cut is a line in a plan, not a piece of glass, and
  // it cannot be put on a stainer. Without this a planned slide could be moved
  // straight into a live rack and stained — recorded as stained with no cut date.
  // Change the plan instead: a queued cut group is editable (#116).
  if (!("extra" in target) && !slide.stage_cut_at) {
    throw new Error(
      "That slide has not been cut yet — change the cutting plan instead of assigning it to an agent.",
    );
  }
  // A slide that has already been imaged has finished a cycle. Sending it back
  // to a stainer starts a second one, and a slide carries ONE set of stamps — so
  // the new staining lands after the imaging that preceded it, and the record
  // reads "imaged, then stained", which is nonsense for a single pass. The swarm
  // found exactly that: BB-0022-A, cut 02:39, imaged 02:40, stained 02:41.
  //
  // Refused rather than resolved by clearing the old stamps, because those
  // record real work on real glass (#83), and rather than by keeping both,
  // because there is nowhere to keep them. Cutting another section is the
  // honest route and has been available since the "one more off this ribbon"
  // control landed.
  if (!("extra" in target) && slide.stage_pictures_taken_at) {
    throw new Error(
      "That slide has already been imaged — add another slide to its cut group instead of re-staining this one.",
    );
  }
  const previousStackId = slide.stack_id;

  if ("extra" in target) {
    await db.execute(
      `UPDATE slides
          SET purpose = 'extra', assay_type = '', assay_name = '', stain_name = '',
              assignment_saved = 1, stack_id = NULL, current_stage = 'extra'
        WHERE id = ?`,
      [slideId],
    );
  } else {
    const assayName = target.assayName.trim();
    if (!assayName) throw new Error("Choose a stain or IHC agent for this slide.");
    const openRack = await getOpenStainRack(target.assayType, assayName);
    const stackId = openRack?.id ?? (await getOrCreateStainRack(target.assayType, assayName));
    await db.execute(
      `UPDATE slides
          SET purpose = 'stain', assay_type = ?, assay_name = ?, stain_name = ?,
              assignment_saved = 1, slice_count = 2, control_agent = 'IgG',
              stack_id = ?, current_stage = 'stain_requested',
              stage_stain_requested_at = COALESCE(stage_stain_requested_at, ?)
        WHERE id = ?`,
      [target.assayType, assayName, assayName, stackId, nowTimestamp(), slideId],
    );
  }

  // Say it happened. A correction that leaves no trace reads, later, exactly
  // like the mistake never occurred — and the whole point of correcting a slide
  // rather than removing it is that the glass and its history are real.
  await db.execute(
    `INSERT INTO sample_timeline_events
      (sample_id, user_id, event_type, summary, details, created_at)
     VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
             'slide_reassigned', ?, ?, ?)`,
    [
      slide.sample_id,
      "extra" in target
        ? `${displayCode(slide.slide_code)} returned to extras from ${slide.assay_name || "no agent"}`
        : `${displayCode(slide.slide_code)} moved from ${slide.assay_name || "no agent"} to ${target.assayName.trim()}`,
      JSON.stringify({
        slide_id: slideId,
        slide_code: slide.slide_code,
        from: slide.assay_name ?? "",
        to: "extra" in target ? "extra" : target.assayName.trim(),
      }),
      nowTimestamp(),
    ],
  );

  if (previousStackId != null) await closeSlideStackIfEmpty(previousStackId);
  // Whoever finishes last leaves the rack matching its contents (see
  // reopenSlideStackIfPopulated).
  if (!("extra" in target)) {
    const landed = await db.select<Array<{ stack_id: number | null }>>(
      `SELECT stack_id FROM slides WHERE id = ?`,
      [slideId],
    );
    if (landed[0]?.stack_id != null) await reopenSlideStackIfPopulated(landed[0].stack_id);
  }
}

/**
 * Add one more slide to a cut group that already exists.
 *
 * The block ribbons better than the plan expected and the technician mounts an
 * extra section. Until now there was nowhere to put it: the only route was a
 * fresh cutting plan, which records a second, separate trip to the microtome on
 * a later date — a different thing from what happened.
 *
 * The new slide takes the next BURNED letter for its sample (never a count, see
 * `nextSlideLetter`), and joins the group where it is: if the group has already
 * been cut the slide is cut too, so it carries a cut stamp and goes straight to
 * the loading rack for its agent; if the group is still queued, it is planned
 * like its siblings and will be cut with them.
 */
export async function addSlideToSection(
  sectionId: number,
  target: { assayType: "stain" | "ihc"; assayName: string } | { extra: true },
): Promise<number> {
  const db = await getDb();
  const rows = await db.select<
    Array<{ sample_id: number; parent_code: string; section_stage: string; cut_at: string | null }>
  >(
    `SELECT sr.sample_id AS sample_id, s.sample_code AS parent_code,
            sr.current_stage AS section_stage,
            (SELECT MAX(sl.stage_cut_at) FROM slides sl WHERE sl.section_request_id = sr.id) AS cut_at
       FROM section_requests sr JOIN samples s ON s.id = sr.sample_id
      WHERE sr.id = ?`,
    [sectionId],
  );
  const section = rows[0];
  if (!section) throw new Error("That cut group no longer exists.");

  // Allocating a letter is a read-then-write across `await` boundaries, so two
  // overlapping calls — a double click, which is what a user does when the app
  // feels slow — can both read the same high-water mark and try the same code.
  //
  // Checking for a clash before inserting does NOT fix it: both callers pass the
  // check before either inserts. The only reliable arbiter is the UNIQUE index
  // on `slides.slide_code` itself, so the insert is attempted and a collision is
  // retried with a freshly read letter. Without this the loser of the race saw
  // `UNIQUE constraint failed: slides.slide_code` — the data was safe, the
  // message was a database internal.
  const timestamp = nowTimestamp();
  // "Already cut" is read off the SIBLING slides, not the group's stage: the
  // group's stage moves on for other reasons, and the cut stamp is the thing
  // that says a blade touched the block (#95).
  const alreadyCut = Boolean(section.cut_at);
  const assayName = "extra" in target ? "" : target.assayName.trim();
  if (!("extra" in target) && !assayName) {
    throw new Error("Choose a stain or IHC agent for this slide.");
  }

  let slideId = 0;
  let letter = 0;
  let code = "";
  for (let attempt = 0; ; attempt += 1) {
    letter = await nextSlideLetter(db, section.sample_id);
    code = slideCodeFor(section.parent_code, letter);
    const ordinalRows = await db.select<Array<{ next: number }>>(
      `SELECT COALESCE(MAX(slide_ordinal), 0) + 1 AS next FROM slides WHERE section_request_id = ?`,
      [sectionId],
    );
    const ordinal = Number(ordinalRows[0]?.next ?? 1);
    try {
      if ("extra" in target) {
        const result = await db.execute(
          `INSERT INTO slides
            (section_request_id, slide_ordinal, slide_code, purpose, assignment_saved,
             current_stage, stage_cut_at)
           VALUES (?, ?, ?, 'extra', 1, 'extra', ?)`,
          [sectionId, ordinal, code, alreadyCut ? timestamp : null],
        );
        if (result.lastInsertId == null) throw new Error("Could not add the slide.");
        slideId = result.lastInsertId;
      } else {
        let stackId: number | null = null;
        if (alreadyCut) {
          const openRack = await getOpenStainRack(target.assayType, assayName);
          stackId = openRack?.id ?? (await getOrCreateStainRack(target.assayType, assayName));
        }
        const result = await db.execute(
          `INSERT INTO slides
            (section_request_id, slide_ordinal, slide_code, purpose, stain_name,
             assay_type, assay_name, requested_assay_type, requested_assay_name,
             assignment_saved, slice_count, control_agent,
             current_stage, stack_id, stage_cut_at, stage_stain_requested_at)
           VALUES (?, ?, ?, 'stain', ?, ?, ?, ?, ?, 1, 2, 'IgG', ?, ?, ?, ?)`,
          [
            sectionId,
            ordinal,
            code,
            assayName,
            target.assayType,
            assayName,
            target.assayType,
            assayName,
            alreadyCut ? "stain_requested" : "assigned",
            stackId,
            alreadyCut ? timestamp : null,
            alreadyCut ? timestamp : null,
          ],
        );
        if (result.lastInsertId == null) throw new Error("Could not add the slide.");
        slideId = result.lastInsertId;
      }
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const raced = /UNIQUE constraint failed:\s*slides\.slide_code/i.test(message);
      if (!raced || attempt >= 4) {
        throw raced
          ? new Error("Could not allocate a slide letter — try that again in a moment.")
          : error;
      }
      // Someone else took this letter; read the mark again and try the next one.
    }
  }

  await recordSlidesIssued(db, section.sample_id, letter);
  const what = "extra" in target ? "as an extra" : `for ${target.assayName.trim()}`;
  await db.execute(
    `INSERT INTO sample_timeline_events
      (sample_id, user_id, event_type, summary, details, created_at)
     VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
             'slide_added', ?, ?, ?)`,
    [
      section.sample_id,
      `${code} added to an existing cut ${what}`,
      alreadyCut
        ? "Mounted from the same ribbon after the group had been cut."
        : "Added to the plan before the group was cut.",
      timestamp,
    ],
  );
  return slideId;
}

/**
 * Correct a slide that was labelled with the wrong block.
 *
 * This is the correction the model made impossible: a slide reaches its sample
 * only through `section_request_id`, and nothing anywhere updated that column,
 * so a slide cut from one block and written up as another could only be removed
 * and re-cut — which throws away the fact that the glass exists and is sitting
 * in a folder.
 *
 * The policy this implements:
 *
 *   • **The glass keeps its history.** Cut, stained, coverslipped, imaged,
 *     analyzed — all of it happened to this piece of glass and none of it is
 *     touched. Only the block it is filed under changes.
 *   • **It gets a fresh code under the correct block**, from that block's own
 *     burned sequence, because the code says which block a slide came from and
 *     the old one said the wrong thing.
 *   • **The old code stays burned** on the old block, so it can never be handed
 *     to a different piece of glass (#73).
 *   • **Both blocks say so.** A timeline event on each — the old block records
 *     what left and why, the new one records what arrived and where from. A
 *     correction that leaves no trace is indistinguishable from a mistake.
 *
 * The slide lands in a cut group belonging to the target block: an existing
 * group for the same agent if there is one, otherwise a new group created for
 * it, so the target's own cut history stays coherent.
 */
export async function relabelSlideToSample(
  slideId: number,
  targetSampleId: number,
  reason: string,
): Promise<void> {
  const note = reason.trim();
  if (!note) throw new Error("Say why this slide is being moved — the reason is the record.");
  const db = await getDb();

  const rows = await db.select<
    Array<{
      slide_code: string;
      purpose: SlidePurpose;
      current_stage: string;
      assay_type: string | null;
      assay_name: string | null;
      section_request_id: number;
      sample_id: number;
      parent_code: string;
    }>
  >(
    `SELECT sl.slide_code, sl.purpose, sl.current_stage, sl.assay_type, sl.assay_name,
            sl.section_request_id, sr.sample_id, s.sample_code AS parent_code
       FROM slides sl
       JOIN section_requests sr ON sr.id = sl.section_request_id
       JOIN samples s ON s.id = sr.sample_id
      WHERE sl.id = ?`,
    [slideId],
  );
  const slide = rows[0];
  if (!slide) throw new Error("That slide no longer exists.");
  if (slide.current_stage === "removed") {
    throw new Error("That slide was removed — it cannot be relabelled.");
  }
  if (slide.sample_id === targetSampleId) {
    throw new Error("That slide is already filed under this block.");
  }

  const targetRows = await db.select<Array<{ sample_code: string }>>(
    `SELECT sample_code FROM samples WHERE id = ?`,
    [targetSampleId],
  );
  const target = targetRows[0];
  if (!target) throw new Error("That block no longer exists.");

  // Land it in a group belonging to the TARGET. Prefer one already carrying the
  // same agent so the target's cut history reads as one cut, not many.
  //
  // A cut group names its agent in `stains` — it has no assay_type/assay_name of
  // its own; those live on the SLIDES. Matching on the wrong column here would
  // throw on every relabel, which is exactly what the harness caught.
  const agent = (slide.assay_name ?? "").trim();
  const groupRows = await db.select<Array<{ id: number }>>(
    `SELECT id FROM section_requests
      WHERE sample_id = ? AND COALESCE(stains, '') = ?
      ORDER BY id LIMIT 1`,
    [targetSampleId, agent],
  );
  let groupId = groupRows[0]?.id ?? null;
  if (groupId == null) {
    const created = await db.execute(
      `INSERT INTO section_requests
        (sample_id, duplicates, stains, current_stage, stage_needs_sectioning_at, stage_sectioned_at)
       VALUES (?, 0, ?, 'sectioned', ?, ?)`,
      [targetSampleId, agent, nowTimestamp(), nowTimestamp()],
    );
    if (created.lastInsertId == null) throw new Error("Could not file the slide under that block.");
    groupId = created.lastInsertId;
  }

  // Same allocation race as `addSlideToSection`: reading the high-water mark and
  // writing the code are separated by `await`, so two overlapping refiles onto
  // one block both take the same letter. The UNIQUE index arbitrates; retrying
  // against it is the only thing that actually works, because any pre-check is
  // itself racy. Found by the concurrent swarm, in this function and in
  // `createSectionRequests`, after it had already been fixed in a third.
  const ordinalRows = await db.select<Array<{ next: number }>>(
    `SELECT COALESCE(MAX(slide_ordinal), 0) + 1 AS next FROM slides WHERE section_request_id = ?`,
    [groupId],
  );
  const timestamp = nowTimestamp();
  let letter = 0;
  let newCode = "";
  for (let attempt = 0; ; attempt += 1) {
    letter = await nextSlideLetter(db, targetSampleId);
    newCode = slideCodeFor(target.sample_code, letter);
    try {
      await db.execute(
        `UPDATE slides SET section_request_id = ?, slide_ordinal = ?, slide_code = ? WHERE id = ?`,
        [groupId, Number(ordinalRows[0]?.next ?? 1), newCode, slideId],
      );
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/UNIQUE constraint failed:\s*slides\.slide_code/i.test(message) || attempt >= 4) {
        throw /UNIQUE constraint failed:\s*slides\.slide_code/i.test(message)
          ? new Error("Could not allocate a slide letter — try that again in a moment.")
          : error;
      }
    }
  }
  await recordSlidesIssued(db, targetSampleId, letter);
  // The letter the slide vacated stays burned on the OLD block — nothing else
  // may ever be called that.
  await recordSlidesIssued(db, slide.sample_id, await nextSlideLetter(db, slide.sample_id) - 1);

  const detail = JSON.stringify({
    slide_id: slideId,
    from_code: slide.slide_code,
    to_code: newCode,
    from_sample: slide.parent_code,
    to_sample: target.sample_code,
    reason: note,
  });
  await db.execute(
    `INSERT INTO sample_timeline_events
      (sample_id, user_id, event_type, summary, details, created_at)
     VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
             'slide_relabelled_out', ?, ?, ?)`,
    [
      slide.sample_id,
      `${displayCode(slide.slide_code)} was not from this block — refiled as ${displayCode(newCode)} under ${displayCode(target.sample_code)}`,
      detail,
      timestamp,
    ],
  );
  await db.execute(
    `INSERT INTO sample_timeline_events
      (sample_id, user_id, event_type, summary, details, created_at)
     VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
             'slide_relabelled_in', ?, ?, ?)`,
    [
      targetSampleId,
      `${displayCode(newCode)} arrived here — cut from this block but labelled ${displayCode(slide.slide_code)}`,
      detail,
      timestamp,
    ],
  );

  await syncSectionDuplicates(db, slide.section_request_id);
  await syncSectionDuplicates(db, groupId);
}

/** Record imaging for one assay slide and derive the parent section's image status. */
export async function setSlidePicturesTaken(slideId: number, complete: boolean): Promise<void> {
  const db = await getDb();
  const rows = await db.select<
    Array<{ section_request_id: number; purpose: SlidePurpose; current_stage: string }>
  >(
    `SELECT section_request_id, purpose, current_stage FROM slides WHERE id = ?`,
    [slideId],
  );
  const slide = rows[0];
  if (!slide || slide.purpose !== "stain") {
    throw new Error("Only stain or IHC slides can be marked as imaged.");
  }
  // A removed slide is broken or lost. Recording photographs of it says pictures
  // were taken of glass that no longer exists — and, because a removed slide has
  // left its rack, it produces an imaging stamp with no imaging stage behind it.
  // Reachable from any panel left open when the slide went (a stale drawer), so
  // the guard belongs here rather than in the view that happened to be showing.
  if (slide.current_stage === "removed") {
    throw new Error("That slide was removed — its imaging can no longer be changed.");
  }
  const timestamp = nowTimestamp();
  await db.execute(
    `UPDATE slides
        SET current_stage = ?, stage_pictures_taken_at = ?
      WHERE id = ?`,
    [complete ? "pictures_taken" : "ready_for_imaging", complete ? timestamp : null, slideId],
  );

  const progress = await db.select<Array<{ total: number; complete: number }>>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN stage_pictures_taken_at IS NOT NULL THEN 1 ELSE 0 END) AS complete
       FROM slides
      WHERE section_request_id = ? AND purpose = 'stain'
        AND current_stage != 'removed'`,
    [slide.section_request_id],
  );
  const total = progress[0]?.total ?? 0;
  const completed = progress[0]?.complete ?? 0;
  const allImaged = total > 0 && completed === total;
  await db.execute(
    `UPDATE section_requests
        SET current_stage = ?, stage_pictures_taken_at = ?
      WHERE id = ?`,
    [allImaged ? "pictures_taken" : "ready_for_imaging", allImaged ? timestamp : null, slide.section_request_id],
  );
}

/**
 * Retire a physical slide — mis-entered, or lost at the bench (#73/#83).
 *
 * NOTHING IS EVER DELETED. This is a posterity application: a slide that was
 * cut and then lost has to read as *cut, then removed*, never as though it had
 * never existed. So the row stays, keeps every timestamp it earned, and is
 * parked at `current_stage='removed'` with the reason recorded on the sample's
 * timeline. It leaves the board and its stack; the Logs view still shows it,
 * flagged, with the reason.
 *
 * Parking it on a STAGE rather than a new column is what makes this safe. No
 * list in `stages.ts` contains 'removed', so a removed slide routes to no board
 * queue and matches no rack query — a read that forgets about removal shows
 * nothing rather than leaking a dead slide. Board-facing reads that select
 * slides regardless of stage still need `current_stage != 'removed'` explicitly;
 * grep for that string to find the full set.
 *
 * The letter it consumed must NOT come back. Freezing the high-water mark
 * BEFORE the stage changes is what makes that true on databases that predate
 * `slides_issued`: there the mark reads 0 and the live count is still governing,
 * so removing C from A–D would otherwise leave count=3 and reissue "D" — a
 * duplicate of a slide that still exists. Recording the mark first pins the
 * sequence at 4, so the next slide is E.
 */
export async function removeSlide(id: number, reason: string): Promise<void> {
  const db = await getDb();
  const rows = await db.select<
    Array<{
      sample_id: number;
      section_request_id: number;
      slide_code: string;
      stack_id: number | null;
      current_stage: string;
    }>
  >(
    `SELECT sr.sample_id, sr.id AS section_request_id, sl.slide_code, sl.stack_id,
            sl.current_stage
       FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sl.id = ?`,
    [id],
  );
  const row = rows[0];
  // Never existed, or already removed — either way there is nothing to record.
  // The second half matters: a slide is soft-removed (#83), so the row is still
  // here and a repeated call would happily write a SECOND removal event for one
  // piece of glass. A stale panel or a double click does exactly that.
  if (!row || row.current_stage === "removed") return;
  await recordSlidesIssued(db, row.sample_id, await nextSlideLetter(db, row.sample_id) - 1);
  // stack_id = NULL is what takes it out of the rack it was sitting in. Every
  // rack read joins on stack_id, so this alone removes it from the board side
  // and lets an emptied rack close.
  await db.execute(
    `UPDATE slides SET current_stage = 'removed', stack_id = NULL WHERE id = ?`,
    [id],
  );
  // …and retire the rack HERE if that emptied it, rather than leaving each
  // caller to remember. `useActions.removeSlides` already compensated, so the
  // shipped UI was fine — but the compensation living at the call site is the
  // exact fragility this file warns about in `nextSlideLetter`, and the v2
  // fuzzer walked straight into it by calling this function directly: an open,
  // empty rack promising work that no longer exists. Idempotent, so the caller
  // doing it too is harmless.
  if (row.stack_id != null) await closeSlideStackIfEmpty(row.stack_id);
  await db.execute(
    `INSERT INTO sample_timeline_events
      (sample_id, user_id, event_type, summary, details, created_at)
     VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
             'slide_removed', ?, ?, ?)`,
    [
      row.sample_id,
      `Removed slide ${displayCode(row.slide_code)}`,
      // JSON rather than bare text so the Logs view can tie the reason back to
      // the exact slide. `sample_timeline_events` has no entity_id column, and
      // `details` already carries JSON elsewhere (see saveSectioningPlan), so
      // this needs no schema change.
      JSON.stringify({ slide_id: id, slide_code: row.slide_code, reason: reason.trim() }),
      nowTimestamp(),
    ],
  );
  if (row.section_request_id != null) {
    await syncSectionDuplicates(db, row.section_request_id);
  }
}

/**
 * Bring a cut group's planned count back in line with the slides it actually
 * holds, after a removal.
 *
 * Restricting `ensureSlidesForSectionRequest` to empty sections fixed removing
 * SOME slides but left removing ALL of them broken, because emptying a group
 * restores the very condition the initialiser fires on: the group came back at
 * its original size on the next open, with fresh letters each time, so reopening
 * the card burned the sample's letter sequence without bound (#83). `duplicates`
 * is also what the card and drawer print as "×N", so a stale value was showing a
 * plan the bench had already deviated from.
 *
 * Recomputed from the live rows rather than decremented, so it self-corrects on
 * databases that already drifted instead of preserving the error.
 */
async function syncSectionDuplicates(db: Database, sectionId: number): Promise<void> {
  await db.execute(
    `UPDATE section_requests
        SET duplicates = (SELECT COUNT(*) FROM slides
                           WHERE section_request_id = ? AND current_stage != 'removed')
      WHERE id = ?`,
    [sectionId, sectionId],
  );
}

/** Mark every assay slide in a section as imaged for bulk imaging completion. */
export async function completeSectionImaging(sectionId: number): Promise<void> {
  const db = await getDb();
  const timestamp = nowTimestamp();
  const rows = await db.select<Array<{ total: number }>>(
    `SELECT COUNT(*) AS total FROM slides
      WHERE section_request_id = ? AND purpose = 'stain' AND current_stage != 'removed'`,
    [sectionId],
  );
  if ((rows[0]?.total ?? 0) === 0) return;
  await db.execute(
    `UPDATE slides
        SET current_stage = 'pictures_taken',
            stage_pictures_taken_at = COALESCE(stage_pictures_taken_at, ?)
      WHERE section_request_id = ? AND purpose = 'stain'`,
    [timestamp, sectionId],
  );
  await db.execute(
    `UPDATE section_requests
        SET current_stage = 'pictures_taken',
            stage_pictures_taken_at = COALESCE(stage_pictures_taken_at, ?)
      WHERE id = ?`,
    [timestamp, sectionId],
  );
}

export async function listAssayCatalog(includeInactive = false): Promise<AssayCatalogEntry[]> {
  const db = await getDb();
  // slide_count = how many slides already carry this agent (by type + name), so
  // the UI can block deleting an agent that prior slide assignments depend on.
  return db.select<AssayCatalogEntry[]>(
    `SELECT c.*,
            (SELECT COUNT(*) FROM slides s
               WHERE s.assay_type = c.assay_type
                 AND s.assay_name = c.name COLLATE NOCASE
                 AND s.current_stage != 'removed') AS slide_count
       FROM assay_catalog c
      ${includeInactive ? "" : "WHERE c.is_active = 1"}
      ORDER BY c.assay_type, c.name COLLATE NOCASE`,
  );
}

export async function addAssay(input: { assay_type: "stain" | "ihc"; name: string }): Promise<number> {
  const db = await getDb();
  const res = await db.execute(
    `INSERT INTO assay_catalog (assay_type, name) VALUES (?, ?)`,
    [input.assay_type, input.name.trim()],
  );
  return res.lastInsertId ?? 0;
}

export async function updateAssay(id: number, name: string): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE assay_catalog SET name = ? WHERE id = ?`, [name.trim(), id]);
}

export async function setAssayActive(id: number, isActive: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE assay_catalog SET is_active = ? WHERE id = ?`, [isActive ? 1 : 0, id]);
}

/** Delete a catalog agent — blocked while any slide already carries it, so prior
 *  slide assignments (which store the agent by name) are never compromised. */
export async function deleteAssay(id: number): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Array<{ n: number }>>(
    `SELECT COUNT(*) AS n FROM slides s
       JOIN assay_catalog c ON c.id = ?
      WHERE s.assay_type = c.assay_type AND s.assay_name = c.name COLLATE NOCASE
        AND s.current_stage != 'removed'`,
    [id],
  );
  if ((rows[0]?.n ?? 0) > 0) {
    throw new Error("This agent is used on existing slides. Deactivate it instead to keep those assignments intact.");
  }
  await db.execute(`DELETE FROM assay_catalog WHERE id = ?`, [id]);
}

export async function updateSectionStage(id: number, stageKey: string): Promise<void> {
  const db = await getDb();
  const column = SECTION_STAGE_COLUMNS[stageKey];
  if (!column) throw new Error(`Unknown section stage: ${stageKey}`);
  const timestamp = nowTimestamp();

  // #95 — ONE rule for when a slide is cut: the moment its group leaves Needs
  // Sectioning, whichever stage it lands in.
  //
  // Two branches below used to stamp this individually (assignment_required and
  // stain_requested), which meant a group dragged from Needs Sectioning straight
  // to Staining-and-beyond or to Ready for Imaging was never recorded as cut at
  // all. Stating it as "past the queue" rather than enumerating destinations
  // means a future stage cannot be added and silently miss it.
  if ((SECTION_STAGE_ORDER[stageKey] ?? 0) > SECTION_STAGE_ORDER.needs_sectioning) {
    await db.execute(
      `UPDATE slides SET stage_cut_at = COALESCE(stage_cut_at, ?) WHERE section_request_id = ?`,
      [timestamp, id],
    );
  }

  if (stageKey === "assignment_required") {
    await db.execute(
      `UPDATE section_requests
          SET current_stage = 'assignment_required',
              stage_sectioned_at = COALESCE(stage_sectioned_at, ?),
              stage_assignment_required_at = COALESCE(stage_assignment_required_at, ?)
        WHERE id = ?`,
      [timestamp, timestamp, id],
    );
    // stage_cut_at is stamped by the one rule above, not here.
    await db.execute(
      `UPDATE slides SET current_stage = 'cut' WHERE section_request_id = ?`,
      [id],
    );
    return;
  }
  if (stageKey === "stain_requested") {
    const rows = await db.select<Array<{ unassigned: number }>>(
      `SELECT COUNT(*) AS unassigned
         FROM slides WHERE section_request_id = ? AND assignment_saved = 0
            AND current_stage != 'removed'`,
      [id],
    );
    if ((rows[0]?.unassigned ?? 0) > 0) {
      throw new Error("Click Save All to confirm every slide assignment before starting assay work.");
    }
    // (The physical cut for the no-assignment-stop path, #34/#38, is stamped by
    // the single rule at the top of this function.)
    const assayRows = await db.select<Array<{ total: number }>>(
      `SELECT COUNT(*) AS total FROM slides
        WHERE section_request_id = ? AND purpose = 'stain'
          AND current_stage != 'removed'`,
      [id],
    );
    if ((assayRows[0]?.total ?? 0) === 0) {
      await db.execute(
        `UPDATE section_requests
            SET current_stage = 'ready_for_imaging',
                stage_ready_for_imaging_at = COALESCE(stage_ready_for_imaging_at, ?)
          WHERE id = ?`,
        [timestamp, id],
      );
      return;
    }
    await db.execute(
      `UPDATE slides
          SET current_stage = CASE WHEN purpose = 'stain' THEN 'stain_requested' ELSE purpose END,
              stage_stain_requested_at = CASE
                WHEN purpose = 'stain' THEN COALESCE(stage_stain_requested_at, ?)
                ELSE stage_stain_requested_at
              END
        WHERE section_request_id = ?`,
      [timestamp, id],
    );
    await attachSectionStainSlidesToRacks(id);
  }
  if (stageKey === "stained") {
    await db.execute(
      `UPDATE slides
          SET current_stage = CASE WHEN purpose = 'stain' THEN 'stained' ELSE current_stage END,
              stage_stained_at = CASE
                WHEN purpose = 'stain' THEN COALESCE(stage_stained_at, ?)
                ELSE stage_stained_at
              END
        WHERE section_request_id = ?`,
      [timestamp, id],
    );
  } else if (stageKey === "ready_for_imaging") {
    await db.execute(
      `UPDATE slides
          SET current_stage = CASE WHEN purpose = 'stain' THEN 'ready_for_imaging' ELSE current_stage END,
              stage_ready_for_imaging_at = CASE
                WHEN purpose = 'stain' THEN COALESCE(stage_ready_for_imaging_at, ?)
                ELSE stage_ready_for_imaging_at
              END
        WHERE section_request_id = ?`,
      [timestamp, id],
    );
  } else if (stageKey === "pictures_taken") {
    await db.execute(
      `UPDATE slides
          SET current_stage = CASE WHEN purpose = 'stain' THEN 'pictures_taken' ELSE current_stage END,
              stage_pictures_taken_at = CASE
                WHEN purpose = 'stain' THEN COALESCE(stage_pictures_taken_at, ?)
                ELSE stage_pictures_taken_at
              END
        WHERE section_request_id = ?`,
      [timestamp, id],
    );
  } else if (stageKey === "analyzed") {
    await db.execute(
      `UPDATE slides
          SET current_stage = CASE WHEN purpose = 'stain' THEN 'analyzed' ELSE current_stage END,
              stage_analyzed_at = CASE
                WHEN purpose = 'stain' THEN COALESCE(stage_analyzed_at, ?)
                ELSE stage_analyzed_at
              END
        WHERE section_request_id = ?`,
      [timestamp, id],
    );
  }
  await db.execute(
    `UPDATE section_requests SET current_stage = ?, ${column} = COALESCE(${column}, ?) WHERE id = ?`,
    [stageKey, timestamp, id],
  );
}

export async function revertSectionToStage(id: number, stageKey: string): Promise<void> {
  const db = await getDb();
  const targetOrder = SECTION_STAGE_ORDER[stageKey];
  if (targetOrder === undefined) throw new Error(`Unknown section stage: ${stageKey}`);

  // Retracting the cut is refused once the glass has been worked on.
  //
  // Reverting to needs_sectioning clears stage_cut_at on every slide in the
  // group (below). If one of those slides has already been stained, that leaves
  // a slide asserting it was stained on a day it had not yet been cut — a
  // physical impossibility, and one the swarm produced by simply dragging a
  // group backwards, which is a thing people do on the board every day.
  //
  // The alternative fix — cascade the revert and clear the staining dates too —
  // was rejected: it destroys the record of work that genuinely happened, which
  // is the one thing this application exists not to do. Once a section is on a
  // slide and stained, the cut is a fact. Fix the slide (reassign it, or remove
  // it with a reason), not the history.
  if (stageKey === "needs_sectioning") {
    const worked = await db.select<Array<{ slide_code: string }>>(
      `SELECT slide_code FROM slides
        WHERE section_request_id = ? AND current_stage <> 'removed'
          AND (stage_stained_at IS NOT NULL OR stage_coverslipped_at IS NOT NULL
               OR stage_pictures_taken_at IS NOT NULL)
        ORDER BY slide_ordinal, id`,
      [id],
    );
    if (worked.length > 0) {
      const codes = worked.map((row) => displayCode(row.slide_code)).join(", ");
      throw new Error(
        `${codes} ${worked.length === 1 ? "has" : "have"} already been stained or imaged, so ` +
          `this cut cannot be retracted. Reassign or remove the slide instead.`,
      );
    }
  }

  const clear = SECTION_STAGES.filter((s) => SECTION_STAGE_ORDER[s.key] > targetOrder).map(
    (s) => s.column,
  );
  const setClause = ["current_stage = ?", ...clear.map((c) => `${c} = NULL`)].join(", ");
  await db.execute(`UPDATE section_requests SET ${setClause} WHERE id = ?`, [stageKey, id]);

  // Back in the queue means not cut (#95). The forward move stamps stage_cut_at
  // on every slide, so the backward one has to take it off, or a group dragged
  // out and back keeps a cut date for a cut that was retracted.
  if (stageKey === "needs_sectioning") {
    // The slides come OUT OF THEIR RACKS as well.
    //
    // Clearing the cut date alone was not enough, and the explorer found why:
    // the slide went back to "not cut" while still sitting in a live staining
    // rack, so the next tick of that rack's protocol stained it — a slide
    // stained on a day it had not yet been cut, which is the same corruption
    // the guard above exists to prevent, reached one step later.
    //
    // Going back to Needs Sectioning means the glass does not exist yet, so it
    // cannot be in a stainer. Everything the forward move (updateSectionStage →
    // 'stain_requested') did to these slides is undone: the rack, the stage, and
    // the request stamp.
    const vacated = await db.select<Array<{ stack_id: number }>>(
      `SELECT DISTINCT stack_id FROM slides
        WHERE section_request_id = ? AND stack_id IS NOT NULL`,
      [id],
    );
    await db.execute(
      `UPDATE slides
          SET stage_cut_at = NULL,
              stack_id = NULL,
              stage_stain_requested_at = NULL,
              current_stage = CASE WHEN purpose = 'stain' THEN 'assigned' ELSE purpose END
        WHERE section_request_id = ? AND current_stage <> 'removed'`,
      [id],
    );
    // A removed slide lets go of the rack and KEEPS EVERY STAMP IT EARNED.
    //
    // Clearing its cut date too was the older half of this bug and it survived
    // the first fix: a slide that was cut, stained, and then broken at the bench
    // would come back reading "stained, never cut". That is not a retraction, it
    // is the record of real work being rewritten — the one thing this
    // application exists not to do (#83). The guard above cannot catch it
    // either, because it only inspects LIVE slides, so a group whose only worked
    // slide has since been removed reverts happily.
    //
    // The rack still has to let go: a retired slide left pointing at a rack
    // makes the rack count glass that is gone.
    await db.execute(
      `UPDATE slides SET stack_id = NULL
        WHERE section_request_id = ? AND current_stage = 'removed'`,
      [id],
    );
    for (const row of vacated) await closeSlideStackIfEmpty(row.stack_id);
  }
}

export async function setSectionTimestamp(
  id: number,
  column: string,
  value: string | null,
): Promise<void> {
  if (!SECTION_COLUMN_SET.has(column)) throw new Error(`Illegal column: ${column}`);
  const db = await getDb();
  await db.execute(`UPDATE section_requests SET ${column} = ? WHERE id = ?`, [value, id]);
}

/**
 * Retire a whole cut group and every slide in it (#83).
 *
 * This used to DELETE the group, its slides and its checklist runs outright. It
 * is the same destruction `removeSlide` exists to prevent, reached by a
 * different button — "Delete this cut group" in the section drawer — so it has
 * to obey the same rule, or the two paths disagree about the same slides again.
 * Each slide goes through `removeSlide` so it gets its own timeline entry and
 * its letter stays burned; the group then follows.
 */
/**
 * Remove a whole block from the working board, with a reason (#96).
 *
 * The drawer's button used to be Archive, which is a reversible *hide* — the
 * right tool for "this project is finished", the wrong one for "this block
 * should never have been logged". Archiving now belongs to the Logs, where you
 * can see what you are hiding and unhide it; the board gets the destructive-
 * sounding action people actually reach for, made non-destructive.
 *
 * "Delete" here means what it means everywhere else in this app: the row stays,
 * flagged, with the reason attached. It reuses `removeSectionRequest` for each
 * live cut group, which reuses `removeSlide` for each slide — so a removed block
 * detaches its slides from their racks, keeps their letters burned, and records
 * one timeline event per slide, all without a new code path. The only new part
 * is the block's own stage and its own event.
 */
export async function removeSample(id: number, reason: string): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Array<{ sample_code: string }>>(
    `SELECT sample_code FROM samples WHERE id = ?`,
    [id],
  );
  const sample = rows[0];
  if (!sample) return;
  const groups = await db.select<Array<{ id: number }>>(
    `SELECT id FROM section_requests WHERE sample_id = ? AND current_stage != 'removed'`,
    [id],
  );
  for (const group of groups) await removeSectionRequest(group.id, reason);
  await db.execute(`UPDATE samples SET current_stage = 'removed' WHERE id = ?`, [id]);
  await db.execute(
    `INSERT INTO sample_timeline_events
      (sample_id, user_id, event_type, summary, details, created_at)
     VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
             'sample_removed', ?, ?, ?)`,
    [
      id,
      `Removed block ${displayCode(sample.sample_code)}`,
      JSON.stringify({ sample_id: id, sample_code: sample.sample_code, reason: reason.trim() }),
      nowTimestamp(),
    ],
  );
}

export async function removeSamples(ids: number[], reason: string): Promise<void> {
  for (const id of ids) await removeSample(id, reason);
}

export async function removeSectionRequest(id: number, reason: string): Promise<void> {
  const db = await getDb();
  const members = await db.select<Array<{ id: number }>>(
    `SELECT id FROM slides WHERE section_request_id = ? AND current_stage != 'removed'`,
    [id],
  );
  for (const member of members) await removeSlide(member.id, reason);
  await db.execute(
    `UPDATE section_requests SET current_stage = 'removed' WHERE id = ?`,
    [id],
  );
}

/**
 * Retire a cut group once its last live slide is gone (#83) — the same rule
 * `closeSlideStackIfEmpty` applies to racks.
 *
 * Without this, removing every extra from a group left a "×0" card sitting in
 * Needs Sectioning: a cut that claims to be pending but would produce nothing.
 *
 * Marked removed rather than DELETEd. That reverses the 0.7.3 behaviour, and
 * deliberately: the group is still the record of a cut that happened, so it
 * leaves the board but stays in the log alongside the slides it produced. Its
 * checklist runs are kept for the same reason — they are the evidence the
 * protocol steps were performed.
 */
export async function removeSectionRequestIfEmpty(id: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE section_requests
        SET current_stage = 'removed'
      WHERE id = ? AND current_stage != 'removed'
        AND NOT EXISTS (
          SELECT 1 FROM slides
           WHERE section_request_id = ? AND current_stage != 'removed'
        )`,
    [id, id],
  );
  return result.rowsAffected > 0;
}

export async function reinsertSlide(snapshot: Slide): Promise<void> {
  const db = await getDb();
  const columns = [
    "id", "section_request_id", "slide_ordinal", "slide_code", "purpose", "stain_name",
    "stack_id",
    "current_stage", "stage_cut_at", "stage_stain_requested_at", "stage_staining_started_at",
    "stage_stained_at", "stage_refrax_at", "stage_coverslipped_at", "stage_dried_at", "stage_ready_for_imaging_at",
    "stage_pictures_taken_at", "stage_analyzed_at", "location", "notes",
    "created_at", "slice_count", "control_agent", "assay_type", "assay_name",
    "assignment_saved",
  ];
  const values = columns.map(
    (column) => (snapshot as unknown as Record<string, unknown>)[column],
  );
  await db.execute(
    `INSERT INTO slides (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values,
  );
}

// Mutable slide columns a snapshot restore may overwrite (everything but id
// and created_at). Used to undo extra-slide assignment.
const SLIDE_RESTORE_COLUMNS = [
  "section_request_id", "slide_ordinal", "slide_code",
  "stack_id",
  "purpose", "stain_name", "slice_count", "control_agent", "assay_type", "assay_name",
  "assignment_saved", "current_stage", "stage_cut_at", "stage_stain_requested_at",
  "stage_staining_started_at", "stage_stained_at", "stage_refrax_at", "stage_coverslipped_at",
  "stage_dried_at", "stage_ready_for_imaging_at", "stage_pictures_taken_at",
  "stage_analyzed_at", "location", "notes",
] as const;

/** Restore a previously captured slide snapshot (for undo of assignment). */
export async function restoreSlide(snapshot: Slide): Promise<void> {
  const db = await getDb();
  const assignments = SLIDE_RESTORE_COLUMNS.map((c) => `${c} = ?`).join(", ");
  const values = SLIDE_RESTORE_COLUMNS.map((c) => (snapshot as unknown as Record<string, unknown>)[c]);
  await db.execute(`UPDATE slides SET ${assignments} WHERE id = ?`, [...values, snapshot.id]);
}

export async function restoreSectionRequest(snapshot: SectionRequest): Promise<void> {
  const db = await getDb();
  const assignments = SECTION_RESTORE_COLUMNS.map((c) => `${c} = ?`).join(", ");
  const values = SECTION_RESTORE_COLUMNS.map(
    (c) => (snapshot as unknown as Record<string, unknown>)[c],
  );
  await db.execute(`UPDATE section_requests SET ${assignments} WHERE id = ?`, [
    ...values,
    snapshot.id,
  ]);
}

export async function reinsertSectionRequest(snapshot: SectionRequest): Promise<void> {
  const db = await getDb();
  const cols = ["id", "sample_id", ...SECTION_RESTORE_COLUMNS, "created_at"];
  const placeholders = cols.map(() => "?").join(", ");
  const values = cols.map((c) => (snapshot as unknown as Record<string, unknown>)[c]);
  await db.execute(
    `INSERT INTO section_requests (${cols.join(", ")}) VALUES (${placeholders})`,
    values,
  );
}

/**
 * Move samples whose timed processing run has elapsed from `processing_started`
 * to `processed`. Short runs are 18h, long runs 52h. Returns how many moved.
 */
export async function autoAdvanceProcessingRuns(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<
    Array<{ id: number; processing_type: string; processing_started_at: string | null }>
  >(
    `SELECT id, processing_type, processing_started_at
       FROM samples WHERE current_stage = 'processing_started'`,
  );

  const now = new Date();
  let moved = 0;
  for (const row of rows) {
    const started = parseTimestamp(row.processing_started_at);
    if (!started) continue;
    const readyAt = new Date(
      started.getTime() + processingDurationHours(row.processing_type) * 3600_000,
    );
    if (now < readyAt) continue;

    const readyStr = formatLocalTimestamp(readyAt);

    await db.execute(
      `UPDATE samples
          SET current_stage = 'processed', stage_processed_at = COALESCE(stage_processed_at, ?)
        WHERE id = ?`,
      [readyStr, row.id],
    );
    moved += 1;
  }
  if (moved > 0) {
    await db.execute(
      `UPDATE processing_batches
          SET status = 'ready'
        WHERE status = 'processing'
          AND NOT EXISTS (
            SELECT 1
              FROM processing_batch_members pbm
              JOIN samples s ON s.id = pbm.sample_id
             WHERE pbm.batch_id = processing_batches.id
               AND s.current_stage = 'processing_started'
          )`,
    );
  }
  return moved;
}

// ---- Stain requests (viewer -> workstation, via the shared repo inbox) -------

/**
 * Insert a request ingested from the repo inbox into the permanent record.
 * Idempotent on `uuid` (the request-file id), so re-draining the same inbox
 * file — or importing a snapshot that already carries it — is a no-op.
 * Returns true when a new row was actually inserted.
 */
export async function insertStainRequest(input: {
  uuid: string;
  sample_code: string;
  slide_code: string;
  requested_assay: string;
  requester_name: string;
  note: string;
  created_at: string;
}): Promise<boolean> {
  const db = await getDb();
  const res = await db.execute(
    `INSERT INTO stain_requests
       (uuid, sample_code, slide_code, requested_assay, requester_name, note, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'requested', ?)
     ON CONFLICT(uuid) DO NOTHING`,
    [
      input.uuid,
      input.sample_code.trim(),
      input.slide_code.trim(),
      input.requested_assay.trim(),
      input.requester_name.trim(),
      input.note.trim(),
      input.created_at,
    ],
  );
  return (res.rowsAffected ?? 0) > 0;
}

/**
 * List stain requests. With no filter, returns the whole inbox (newest first)
 * for the workstation. Pass `requesterName` to show a viewer only its own
 * requests, or `status` to filter (e.g. only open ones).
 */
export async function listStainRequests(opts?: {
  status?: StainRequestStatus;
  requesterName?: string;
}): Promise<StainRequest[]> {
  const db = await getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts?.status) {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  if (opts?.requesterName) {
    clauses.push("requester_name = ? COLLATE NOCASE");
    params.push(opts.requesterName);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.select<StainRequest[]>(
    `SELECT * FROM stain_requests ${where}
      ORDER BY CASE status WHEN 'requested' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
               created_at DESC, id DESC`,
    params,
  );
}

/**
 * Auto-acknowledge open requests fulfilled by assigning a stain slide: when the
 * workstation assigns/creates a `stain` slide, any still-`requested` request for
 * the same sample + assay (and matching slide, if the request named one) flips
 * to `acknowledged` so the requester sees it's in progress. Closure to `done`
 * stays a deliberate workstation action. Matching is by name, case-insensitive.
 * Returns how many requests were acknowledged.
 */
export async function acknowledgeRequestsForSlide(slideId: number): Promise<number> {
  const db = await getDb();
  const rows = await db.select<
    Array<{ purpose: string; slide_code: string; assay: string; sample_code: string }>
  >(
    `SELECT sl.purpose, sl.slide_code,
            COALESCE(NULLIF(sl.assay_name, ''), sl.stain_name) AS assay,
            s.sample_code AS sample_code
       FROM slides sl
       JOIN section_requests sr ON sr.id = sl.section_request_id
       JOIN samples s ON s.id = sr.sample_id
      WHERE sl.id = ?`,
    [slideId],
  );
  const info = rows[0];
  if (!info || info.purpose !== "stain" || !info.assay.trim() || !info.sample_code) return 0;
  // stain_requests stores the human code as denormalized text, and the request
  // may have been raised against the other spelling of this sample (#87) — an
  // unmatched row silently stays "requested" forever.
  const codes = sampleCodeVariants(info.sample_code);
  const codePlaceholders = codes.map(() => "?").join(", ");
  const res = await db.execute(
    `UPDATE stain_requests
        SET status = 'acknowledged'
      WHERE status = 'requested'
        AND sample_code IN (${codePlaceholders}) COLLATE NOCASE
        AND requested_assay = ? COLLATE NOCASE
        AND (slide_code = '' OR slide_code = ? COLLATE NOCASE)`,
    [...codes, info.assay.trim(), info.slide_code],
  );
  return res.rowsAffected ?? 0;
}

/** Move a request through requested -> acknowledged -> done / rejected. */
/**
 * Mark an ingested request rejected, with the reason it could not be applied
 * (#71). The workstation deletes the inbox file as soon as it drains, so if the
 * apply fails and nothing is recorded here the request is simply gone — the
 * viewer sees it acknowledged-by-silence and the bench never learns of it.
 */
export async function rejectStainRequestByUuid(uuid: string, reason: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE stain_requests
        SET status = 'rejected',
            resolved_by = 'system',
            resolved_at = ?,
            note = CASE WHEN note = '' THEN ? ELSE note || ' | ' || ? END
      WHERE uuid = ? AND status = 'requested'`,
    [nowTimestamp(), reason, reason, uuid],
  );
}

export async function setStainRequestStatus(
  id: number,
  status: StainRequestStatus,
  resolvedBy: string,
): Promise<void> {
  const db = await getDb();
  const resolved = status === "done" || status === "rejected";
  await db.execute(
    `UPDATE stain_requests
        SET status = ?,
            resolved_by = CASE WHEN ? THEN ? ELSE '' END,
            resolved_at = CASE WHEN ? THEN ? ELSE NULL END
      WHERE id = ?`,
    [status, resolved, resolvedBy.trim(), resolved, nowTimestamp(), id],
  );
}
