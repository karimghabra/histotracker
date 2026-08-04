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
  processingDurationHours,
} from "./stages";
import type { SectionRequest, StainRequest, StainRequestStatus } from "./types";
import {
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

export async function recordAuditEvent(
  action: string,
  entityType: string,
  summary: string,
  details = "",
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO audit_events (user_id, action, entity_type, summary, details)
     VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
             ?, ?, ?, ?)`,
    [action, entityType, summary, details],
  );
}

function guardWrites(db: Database): Database {
  const original = db.execute.bind(db);
  db.execute = ((query: string, bindValues?: unknown[]) => {
    if (viewerReadOnly) {
      return Promise.reject(
        new Error("This is a read-only viewer — changes are made on the workstation."),
      );
    }
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
        WHERE sr.sample_id = ? AND sl.purpose = 'stain' AND sl.assay_name <> ''`,
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

export async function addUser(input: { name: string; initials: string }): Promise<number> {
  const db = await getDb();
  const res = await db.execute(
    `INSERT INTO users (name, initials) VALUES (?, ?)`,
    [input.name.trim(), input.initials.trim().toUpperCase()],
  );
  return res.lastInsertId ?? 0;
}

export async function setUserActive(userId: number, isActive: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE users SET is_active = ? WHERE id = ?`, [isActive ? 1 : 0, userId]);
  if (!isActive) {
    await db.execute(
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
  await db.execute(
    `INSERT INTO app_settings (key, value) VALUES ('active_user_id', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [userId === null ? "" : String(userId)],
  );
}

export async function setProjectActive(projectId: number, isActive: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE projects SET is_active = ? WHERE id = ?`, [isActive ? 1 : 0, projectId]);
}

export async function updateProject(
  projectId: number,
  input: { code: string; name: string; team_lead: string; lead_user_id: number },
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE projects SET code = ?, name = ?, team_lead = ?, lead_user_id = ? WHERE id = ?`,
    [
      input.code.trim().toUpperCase(),
      input.name.trim(),
      input.team_lead.trim(),
      input.lead_user_id,
      projectId,
    ],
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

/**
 * Move a sample to a different project (#60). The sample is re-identified under
 * the target project — a fresh project_sample_number and a re-minted
 * `<NEWCODE>-NNNN` sample_code — and its slides' codes are updated to match the
 * new parent prefix so nothing shows a stale project code. Returns the codes for
 * a confirmation message.
 */
export async function changeSampleProject(
  sampleId: number,
  newProjectId: number,
): Promise<{ oldCode: string; newCode: string }> {
  const db = await getDb();
  const sampleRows = await db.select<Array<{ sample_code: string; project_id: number }>>(
    `SELECT sample_code, project_id FROM samples WHERE id = ?`,
    [sampleId],
  );
  const sample = sampleRows[0];
  if (!sample) throw new Error("Sample not found.");
  const oldCode = sample.sample_code;
  if (sample.project_id === newProjectId) return { oldCode, newCode: oldCode };

  const projRows = await db.select<Array<{ code: string }>>(
    `SELECT code FROM projects WHERE id = ?`,
    [newProjectId],
  );
  const newProjectCode = projRows[0]?.code;
  if (!newProjectCode) throw new Error("Target project not found.");

  const number = await nextSampleNumber(newProjectId);
  const newCode = formatSampleCode(newProjectCode, number);
  await db.execute(
    `UPDATE samples SET project_id = ?, project_sample_number = ?, sample_code = ? WHERE id = ?`,
    [newProjectId, number, newCode, sampleId],
  );
  // Re-prefix this sample's slide codes (EE-0001-A → XX-0003-A) so physical
  // labels and the board/logs stay consistent with the new parent code.
  await db.execute(
    `UPDATE slides SET slide_code = ? || SUBSTR(slide_code, ?)
       WHERE section_request_id IN (SELECT id FROM section_requests WHERE sample_id = ?)
         AND slide_code LIKE ?`,
    [newCode, oldCode.length + 1, sampleId, `${oldCode}-%`],
  );
  // Keep any outstanding stain requests addressable by the new codes too.
  await db.execute(`UPDATE stain_requests SET sample_code = ? WHERE sample_code = ?`, [newCode, oldCode]);
  return { oldCode, newCode };
}

export async function listOpenSamples(): Promise<Sample[]> {
  const db = await getDb();
  // The needs-stain flag is simply the block's OUTSTANDING stain requests
  // (`preselected_stains`, treated as a multiset): agents chosen at creation or
  // requested since, minus the ones already fulfilled by a cut (trimmed in
  // createSectionRequests). A duplicate request queues a second slide (#62/#66),
  // and re-requesting an already-produced agent flags the block again (#41).
  const rows = await db.select<Array<Sample>>(
    `SELECT s.*, p.code AS project_code, p.name AS project_name, p.team_lead AS team_lead
       FROM samples s
       JOIN projects p ON p.id = s.project_id
      WHERE p.is_active = 1 AND s.current_stage != 'analyzed' AND s.block_exhausted = 0
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
  // Every newly embedded block gets at least four slides with two extras
  // (issue #4); with no preselected stains that is simply four extras.
  const preselected = parsePreselectedStains(row.preselected_stains);
  const plan = buildAutoSectioningPlan(preselected);
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

export async function deleteSample(sampleId: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM samples WHERE id = ?`, [sampleId]);
}

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
            p.code AS project_code
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
  await db.execute(
    `UPDATE slides SET depth_label = ?, depth_note = ? WHERE id IN (${placeholders})`,
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
 * Replace a planned run's member samples (issue #32). Only planned runs are
 * editable; the new set must share the protocol, have completed preprocessing,
 * and not already be committed to a different open batch.
 */
export async function updatePlannedBatchMembers(
  batchId: number,
  sampleIds: number[],
): Promise<void> {
  if (sampleIds.length === 0) throw new Error("A planned run needs at least one sample.");
  const db = await getDb();
  const batchRows = await db.select<Array<{ status: string; processing_type: string }>>(
    `SELECT status, processing_type FROM processing_batches WHERE id = ?`,
    [batchId],
  );
  const batch = batchRows[0];
  if (!batch) throw new Error("That processing batch no longer exists.");
  if (batch.status !== "planned") throw new Error("Only a planned run's samples can be edited.");
  const placeholders = sampleIds.map(() => "?").join(", ");
  const samples = await db.select<Sample[]>(
    `SELECT * FROM samples WHERE id IN (${placeholders}) ORDER BY id`,
    sampleIds,
  );
  if (samples.length !== sampleIds.length) throw new Error("One or more samples no longer exist.");
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

export async function deleteProcessingBatch(batchId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM checklist_items
      WHERE checklist_run_id IN (
        SELECT id FROM checklist_runs WHERE scope_type = 'processing_batch' AND scope_id = ?
      )`,
    [batchId],
  );
  await db.execute(
    `DELETE FROM checklist_runs WHERE scope_type = 'processing_batch' AND scope_id = ?`,
    [batchId],
  );
  await db.execute(`DELETE FROM processing_batch_members WHERE batch_id = ?`, [batchId]);
  await db.execute(`DELETE FROM processing_batches WHERE id = ?`, [batchId]);
}

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
  if (sortOrder === 0) {
    await db.execute(
      `UPDATE slides SET stage_stained_at = ?
        WHERE section_request_id = ? AND purpose = 'stain' AND assay_type = ?`,
      [timestamp, sectionRequestId, assayType],
    );
    const sectionColumn = assayType === "ihc" ? "stage_ihc_at" : "stage_stained_at";
    await db.execute(`UPDATE section_requests SET ${sectionColumn} = ? WHERE id = ?`, [timestamp, sectionRequestId]);
  } else if (sortOrder === 1) {
    await db.execute(
      `UPDATE slides SET stage_refrax_at = ?, stage_coverslipped_at = ?
        WHERE section_request_id = ? AND purpose = 'stain' AND assay_type = ?`,
      [timestamp, timestamp, sectionRequestId, assayType],
    );
    await db.execute(
      `UPDATE section_requests SET stage_refrax_at = ?, stage_coverslipped_at = ? WHERE id = ?`,
      [timestamp, timestamp, sectionRequestId],
    );
  } else if (sortOrder === 2) {
    await db.execute(
      `UPDATE slides SET stage_dried_at = ?
        WHERE section_request_id = ? AND purpose = 'stain' AND assay_type = ?`,
      [timestamp, sectionRequestId, assayType],
    );
    await db.execute(`UPDATE section_requests SET stage_dried_at = ? WHERE id = ?`, [timestamp, sectionRequestId]);
  }

  const assayTypes = await db.select<Array<{ assay_type: "stain" | "ihc" }>>(
    `SELECT DISTINCT assay_type FROM slides
      WHERE section_request_id = ? AND purpose = 'stain' AND assay_type IN ('stain', 'ihc')`,
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
  // NEVER a live COUNT. A count is lowered by any delete, and there are several
  // delete paths (deleteSlide, deleteSlidesForStack, deleteSectionRequest, and
  // ON DELETE CASCADE) — requiring each of them to compensate is exactly the
  // per-call-site fragility that let #73 ship broken. Both terms below only ever
  // rise: the persisted mark, and the highest letter still visible in the
  // sample's slide codes (a safety net for rows written before the mark existed,
  // or by any future path that forgets to record).
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
          `INSERT INTO slides
            (section_request_id, slide_ordinal, slide_code, purpose, stain_name,
             assay_type, assay_name, assignment_saved, slice_count, control_agent, current_stage, stage_cut_at)
           VALUES (?, ?, ?, 'stain', ?, ?, ?, 1, 2, 'IgG', 'assigned', ?)`,
          [sectionId, ordinal, slideCodeFor(parentCode, nextOrdinal), g.assay_name, g.assay_type, g.assay_name, timestamp],
        );
      } else {
        // Extras are a deliberate, saved disposition chosen at cut time — no
        // separate assignment step needed (issues #34, #38). They still stay out
        // of the Extras inventory until the section leaves Needs Sectioning
        // (issue #12), via listExtraSlides' stage filter.
        await db.execute(
          `INSERT INTO slides
            (section_request_id, slide_ordinal, slide_code, purpose, assignment_saved, current_stage, stage_cut_at)
           VALUES (?, ?, ?, 'extra', 1, 'extra', ?)`,
          [sectionId, ordinal, slideCodeFor(parentCode, nextOrdinal), timestamp],
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
  const cut: Array<{ assay_type: string; assay_name: string }> = [];
  for (const g of groups) {
    if (g.assay_type && g.assay_name) {
      for (let i = 0; i < Math.max(1, g.duplicates); i += 1) {
        cut.push({ assay_type: g.assay_type, assay_name: g.assay_name });
      }
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

/** Remove up to one entry per `toRemove` item from an outstanding-requests list
 *  (case-insensitive match on type+name), returning what stays outstanding. */
function removeFromRequests(
  current: Array<{ assay_type: string; assay_name: string }>,
  toRemove: Array<{ assay_type: string; assay_name: string }>,
): Array<{ assay_type: string; assay_name: string }> {
  const remaining = [...current];
  for (const r of toRemove) {
    const idx = remaining.findIndex(
      (a) => a.assay_type === r.assay_type && a.assay_name.toLowerCase() === r.assay_name.toLowerCase(),
    );
    if (idx >= 0) remaining.splice(idx, 1);
  }
  return remaining;
}


/**
 * The auto-generated sectioning plan for an embedded sample with preselected
 * stains (issue #4): one preassigned cut group per stain, plus enough extras to
 * reach ≥4 slides with ≥2 extras — extras = max(2, 4 − stainCount).
 */
export function buildAutoSectioningPlan(
  preselected: Array<{ assay_type: string; assay_name: string }>,
): Array<{ duplicates: number; stains?: string; assay_type?: string; assay_name?: string }> {
  const stains = preselected.map((a) => ({
    duplicates: 1,
    stains: a.assay_name,
    assay_type: a.assay_type,
    assay_name: a.assay_name,
  }));
  const extras = Math.max(2, 4 - preselected.length);
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
      LEFT JOIN slides sl ON sl.section_request_id = sr.id
      WHERE p.is_active = 1 AND sr.current_stage != 'analyzed'
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
    Array<{ duplicates: number; sample_id: number; sample_code: string; existing_count: number }>
  >(
    `SELECT sr.duplicates, sr.sample_id, s.sample_code, COUNT(sl.id) AS existing_count
       FROM section_requests sr
       JOIN samples s ON s.id = sr.sample_id
       LEFT JOIN slides sl ON sl.section_request_id = sr.id
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
  const cutAt = nowTimestamp();
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
    `SELECT * FROM slides WHERE section_request_id = ? ORDER BY slide_ordinal`,
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
      ORDER BY id ASC LIMIT 1`,
    [assayType, assayName],
  );
  return rows[0] ?? null;
}

export async function getSlideStack(id: number): Promise<SlideStack | null> {
  const db = await getDb();
  const rows = await db.select<SlideStack[]>(`SELECT * FROM slide_stacks WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

export async function deleteSlideStack(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM checklist_items
      WHERE checklist_run_id IN (
        SELECT id FROM checklist_runs WHERE scope_type = 'slide_stack' AND scope_id = ?
      )`,
    [id],
  );
  await db.execute(
    `DELETE FROM checklist_runs WHERE scope_type = 'slide_stack' AND scope_id = ?`,
    [id],
  );
  await db.execute(`DELETE FROM slide_stacks WHERE id = ?`, [id]);
}

export async function deleteSlideStackIfEmpty(id: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `DELETE FROM slide_stacks
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM slides WHERE stack_id = ?)`,
    [id, id],
  );
  if (result.rowsAffected > 0) {
    await db.execute(
      `DELETE FROM checklist_items
        WHERE checklist_run_id IN (
          SELECT id FROM checklist_runs WHERE scope_type = 'slide_stack' AND scope_id = ?
        )`,
      [id],
    );
    await db.execute(
      `DELETE FROM checklist_runs WHERE scope_type = 'slide_stack' AND scope_id = ?`,
      [id],
    );
  }
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
      WHERE section_request_id = ? AND purpose = 'stain'`,
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
            COALESCE(GROUP_CONCAT(DISTINCT NULLIF(sl.assay_name, '')), '') AS agent_names
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
    await deleteSlideStack(stackId); // rack consumed
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
    await deleteSlideStack(source.id);
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
  if (sortOrder === 0) {
    await db.execute(
      `UPDATE slides SET stage_stained_at = ?
        WHERE stack_id = ? AND purpose = 'stain' AND assay_type = ?`,
      [timestamp, stackId, assayType],
    );
    const stackColumn = assayType === "ihc" ? "stage_ihc_at" : "stage_stained_at";
    await db.execute(`UPDATE slide_stacks SET ${stackColumn} = ? WHERE id = ?`, [timestamp, stackId]);
  } else if (sortOrder === 1) {
    await db.execute(
      `UPDATE slides SET stage_refrax_at = ?, stage_coverslipped_at = ?
        WHERE stack_id = ? AND purpose = 'stain' AND assay_type = ?`,
      [timestamp, timestamp, stackId, assayType],
    );
    await db.execute(
      `UPDATE slide_stacks SET stage_refrax_at = ?, stage_coverslipped_at = ? WHERE id = ?`,
      [timestamp, timestamp, stackId],
    );
  } else if (sortOrder === 2) {
    await db.execute(
      `UPDATE slides SET stage_dried_at = ?
        WHERE stack_id = ? AND purpose = 'stain' AND assay_type = ?`,
      [timestamp, stackId, assayType],
    );
    await db.execute(`UPDATE slide_stacks SET stage_dried_at = ? WHERE id = ?`, [timestamp, stackId]);
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

export async function deleteSlidesForStack(stackId: number): Promise<void> {
  const db = await getDb();
  // Collect the affected cut groups BEFORE the delete — afterwards there is no
  // row left to tell us which ones to resync (#83).
  const affected = await db.select<Array<{ section_request_id: number }>>(
    `SELECT DISTINCT section_request_id FROM slides
      WHERE stack_id = ? AND section_request_id IS NOT NULL`,
    [stackId],
  );
  await db.execute(`DELETE FROM slides WHERE stack_id = ?`, [stackId]);
  for (const row of affected) {
    await syncSectionDuplicates(db, row.section_request_id);
    // ...and drop the group if that emptied it. Wiring this into removeSlides
    // alone left the two removal paths disagreeing: deleting a rack's slides one
    // by one removed the group, while "Delete slide stack" — the same slides,
    // the same drawer — left a "×0" card behind. Doing it here means every
    // caller inherits the rule instead of each having to remember it.
    await deleteSectionRequestIfEmpty(row.section_request_id);
  }
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
  target: "extra" | "block";
  slideId: number | null;
  stackId: number | null;
  createdStackId: number | null;
}> {
  const db = await getDb();
  const assayName = input.assayName.trim();
  // Pull from an available extra first — that fulfils the request immediately
  // (the extra becomes this stain and enters Staining), so nothing is added to
  // the outstanding multiset. Only when no extra is free does the request rest
  // on the block as an outstanding cut request.
  const extras = await db.select<Array<{ id: number }>>(
    `SELECT sl.id FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sr.sample_id = ? AND sl.purpose = 'extra' AND sl.current_stage = 'extra'
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
      `UPDATE slides
          SET stack_id = ?, purpose = 'stain', assay_type = ?, assay_name = ?, stain_name = ?,
              assignment_saved = 1, slice_count = 2, control_agent = 'IgG',
              current_stage = 'stain_requested',
              stage_stain_requested_at = COALESCE(stage_stain_requested_at, ?)
        WHERE id = ?`,
      [stackId, input.assayType, assayName, assayName, timestamp, extras[0].id],
    );
    return {
      target: "extra",
      slideId: extras[0].id,
      stackId,
      createdStackId: openRack ? null : stackId,
    };
  }
  // No free extra: the request would flag the BLOCK for a fresh cut. An
  // exhausted block has no tissue left to cut, so that flag could never be
  // satisfied and the block would sit lit up forever — refuse it (issue #70).
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

/** Record imaging for one assay slide and derive the parent section's image status. */
export async function setSlidePicturesTaken(slideId: number, complete: boolean): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Array<{ section_request_id: number; purpose: SlidePurpose }>>(
    `SELECT section_request_id, purpose FROM slides WHERE id = ?`,
    [slideId],
  );
  const slide = rows[0];
  if (!slide || slide.purpose !== "stain") {
    throw new Error("Only stain or IHC slides can be marked as imaged.");
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
      WHERE section_request_id = ? AND purpose = 'stain'`,
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
 * Remove a physical slide — mis-entered, or lost at the bench (#73/#83).
 *
 * The letter it consumed must NOT come back. Freezing the high-water mark
 * BEFORE the row disappears is what makes that true on databases that predate
 * `slides_issued`: there the mark reads 0 and the live count is still governing,
 * so deleting C from A–D would otherwise leave count=3 and reissue "D" — a
 * duplicate of a slide that still exists. Recording the mark first pins the
 * sequence at 4, so the next slide is E.
 */
export async function deleteSlide(id: number): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Array<{ sample_id: number; section_request_id: number }>>(
    `SELECT sr.sample_id, sr.id AS section_request_id FROM slides sl
       JOIN section_requests sr ON sr.id = sl.section_request_id
      WHERE sl.id = ?`,
    [id],
  );
  const sampleId = rows[0]?.sample_id;
  if (sampleId != null) {
    await recordSlidesIssued(db, sampleId, await nextSlideLetter(db, sampleId) - 1);
  }
  await db.execute(`DELETE FROM slides WHERE id = ?`, [id]);
  if (rows[0]?.section_request_id != null) {
    await syncSectionDuplicates(db, rows[0].section_request_id);
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
        SET duplicates = (SELECT COUNT(*) FROM slides WHERE section_request_id = ?)
      WHERE id = ?`,
    [sectionId, sectionId],
  );
}

/** Mark every assay slide in a section as imaged for bulk imaging completion. */
export async function completeSectionImaging(sectionId: number): Promise<void> {
  const db = await getDb();
  const timestamp = nowTimestamp();
  const rows = await db.select<Array<{ total: number }>>(
    `SELECT COUNT(*) AS total FROM slides WHERE section_request_id = ? AND purpose = 'stain'`,
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
                 AND s.assay_name = c.name COLLATE NOCASE) AS slide_count
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
      WHERE s.assay_type = c.assay_type AND s.assay_name = c.name COLLATE NOCASE`,
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
  if (stageKey === "assignment_required") {
    await db.execute(
      `UPDATE section_requests
          SET current_stage = 'assignment_required',
              stage_sectioned_at = COALESCE(stage_sectioned_at, ?),
              stage_assignment_required_at = COALESCE(stage_assignment_required_at, ?)
        WHERE id = ?`,
      [timestamp, timestamp, id],
    );
    await db.execute(
      `UPDATE slides
          SET current_stage = 'cut', stage_cut_at = COALESCE(stage_cut_at, ?)
        WHERE section_request_id = ?`,
      [timestamp, id],
    );
    return;
  }
  if (stageKey === "stain_requested") {
    const rows = await db.select<Array<{ unassigned: number }>>(
      `SELECT COUNT(*) AS unassigned
         FROM slides WHERE section_request_id = ? AND assignment_saved = 0`,
      [id],
    );
    if ((rows[0]?.unassigned ?? 0) > 0) {
      throw new Error("Click Save All to confirm every slide assignment before starting assay work.");
    }
    // Coming straight from Needs Sectioning (no assignment stop, #34/#38): record
    // the physical cut on every slide now.
    await db.execute(
      `UPDATE slides SET stage_cut_at = COALESCE(stage_cut_at, ?) WHERE section_request_id = ?`,
      [timestamp, id],
    );
    const assayRows = await db.select<Array<{ total: number }>>(
      `SELECT COUNT(*) AS total FROM slides
        WHERE section_request_id = ? AND purpose = 'stain'`,
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
  const clear = SECTION_STAGES.filter((s) => SECTION_STAGE_ORDER[s.key] > targetOrder).map(
    (s) => s.column,
  );
  const setClause = ["current_stage = ?", ...clear.map((c) => `${c} = NULL`)].join(", ");
  await db.execute(`UPDATE section_requests SET ${setClause} WHERE id = ?`, [stageKey, id]);
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

export async function deleteSectionRequest(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM checklist_items
      WHERE checklist_run_id IN (
        SELECT id FROM checklist_runs WHERE scope_type = 'section_request' AND scope_id = ?
      )`,
    [id],
  );
  await db.execute(
    `DELETE FROM checklist_runs WHERE scope_type = 'section_request' AND scope_id = ?`,
    [id],
  );
  await db.execute(`DELETE FROM slides WHERE section_request_id = ?`, [id]);
  await db.execute(`DELETE FROM section_requests WHERE id = ?`, [id]);
}

/**
 * Drop a cut group once its last slide is gone (#83) — the same rule
 * `deleteSlideStackIfEmpty` already applies to racks.
 *
 * Without this, removing every extra from a group left a "×0" card sitting in
 * Needs Sectioning: a cut that claims to be pending but would produce nothing.
 * Undo restores a whole DB image, so this is reversible along with the removal
 * that triggered it.
 */
export async function deleteSectionRequestIfEmpty(id: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `DELETE FROM section_requests
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM slides WHERE section_request_id = ?)`,
    [id, id],
  );
  if (result.rowsAffected > 0) {
    await db.execute(
      `DELETE FROM checklist_items
        WHERE checklist_run_id IN (
          SELECT id FROM checklist_runs WHERE scope_type = 'section_request' AND scope_id = ?
        )`,
      [id],
    );
    await db.execute(
      `DELETE FROM checklist_runs WHERE scope_type = 'section_request' AND scope_id = ?`,
      [id],
    );
  }
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
