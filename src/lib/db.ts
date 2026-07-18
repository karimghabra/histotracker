import Database from "@tauri-apps/plugin-sql";
import type {
  ChecklistItem,
  AssayCatalogEntry,
  NewSampleInput,
  ProcessingBatch,
  Project,
  LabUser,
  Sample,
  Slide,
  SlidePurpose,
  SampleTimelineEvent,
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
import { duplicateLabel, nowTimestamp, parseTimestamp, todayIso } from "./utils";

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
    dbPromise = Database.load(DB_URL).then(guardWrites);
  }
  return dbPromise;
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
  return `${projectCode.trim().toUpperCase()}-${String(n).padStart(4, "0")}`;
}

// ---- Samples ----------------------------------------------------------------

export async function addSample(input: NewSampleInput, projectCode: string): Promise<number> {
  const db = await getDb();
  const timestamp = nowTimestamp();
  const number = await nextSampleNumber(input.project_id);
  const code = `${projectCode.trim().toUpperCase()}-${String(number).padStart(4, "0")}`;

  const res = await db.execute(
    `INSERT INTO samples (
        project_id, project_sample_number, sample_code, sample_description, date_added,
        processing_type, fixative_agent, needs_decalcification, cut_notes, slide_notes,
        stains, overall_notes, current_stage, stage_received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`,
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
      input.overall_notes.trim(),
      timestamp,
    ],
  );
  return res.lastInsertId ?? 0;
}

export async function listOpenSamples(): Promise<Sample[]> {
  const db = await getDb();
  return db.select<Sample[]>(
    `SELECT s.*, p.code AS project_code, p.name AS project_name, p.team_lead AS team_lead,
            COALESCE((
              SELECT GROUP_CONCAT(depth_um || 'µm', ' ')
                FROM (
                  SELECT DISTINCT sr.depth_um
                    FROM section_requests sr
                   WHERE sr.sample_id = s.id AND sr.stage_sectioned_at IS NOT NULL
                   ORDER BY sr.depth_um
                )
            ), '') AS sectioned_depths
       FROM samples s
       JOIN projects p ON p.id = s.project_id
      WHERE p.is_active = 1 AND s.current_stage != 'analyzed' AND s.block_exhausted = 0
      ORDER BY s.is_priority DESC, s.prioritized_at DESC, s.date_added ASC, s.id ASC`,
  );
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
  "slide_notes", "stains", "overall_notes", "sectioning_plan", "current_stage",
  "stage_received_at", "decalc_completed_at", "fixative_placed_at", "fixative_removed_at",
  "ethanol_placed_at", "processing_started_at", "stage_processed_at", "stage_needs_embedding_at",
  "stage_embedded_at", "stage_needs_sectioning_at", "stage_sectioned_at", "stage_stain_requested_at",
  "stage_stained_at", "stage_deparaffinized_at", "stage_ihc_at", "stage_pictures_taken_at",
  "stage_analyzed_at", "stage_picked_up_at", "max_cut_depth_um", "block_exhausted",
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
  plan: Array<{ depth_um: number; duplicates: number }>,
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
        .map((row) => `${row.depth_um}µm ×${row.duplicates}`)
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
      ORDER BY p.code, s.project_sample_number, sr.depth_um, sr.id`,
  );
}

export async function listAllSlides(): Promise<Slide[]> {
  const db = await getDb();
  return db.select<Slide[]>(
    `SELECT sl.*, sr.depth_um AS depth_um, s.sample_code AS parent_code,
            p.code AS project_code
       FROM slides sl
       JOIN section_requests sr ON sr.id = sl.section_request_id
       JOIN samples s ON s.id = sr.sample_id
       JOIN projects p ON p.id = s.project_id
      ORDER BY p.code, s.project_sample_number, sr.depth_um, sl.slide_ordinal`,
  );
}

export async function setBlockExhausted(sampleId: number, exhausted: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE samples SET block_exhausted = ? WHERE id = ?`, [
    exhausted ? 1 : 0,
    sampleId,
  ]);
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

  // The processor runs one batch at a time (issue #5). "Busy" is judged from
  // actual sample state — a run is only in the processor while its samples sit
  // at 'processing_started' with a window that hasn't ended — NOT from the
  // batch's status column, which can go stale/orphaned and otherwise wedge the
  // processor so no new run can start. A run planned to begin after the current
  // one finishes is allowed. Timestamps are "YYYY-MM-DD HH:MM", so lexical
  // comparison is chronological.
  const activeRun = await db.select<Array<{ id: number }>>(
    `SELECT pb.id
       FROM processing_batches pb
       JOIN processing_batch_members pbm ON pbm.batch_id = pb.id
       JOIN samples s ON s.id = pbm.sample_id
      WHERE s.current_stage = 'processing_started'
        AND (pb.ready_at IS NULL OR pb.ready_at > ?)
      LIMIT 1`,
    [input.startedAt],
  );
  if (activeRun.length > 0) {
    throw new Error(
      "The processor already has a run in progress. Move it to Processor Pickup, or plan this run to start after it finishes.",
    );
  }

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
      WHERE s.current_stage IN ('processing_started', 'processed')
      GROUP BY pb.id
      ORDER BY pb.started_at ASC, pb.id ASC`,
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
      checklistComplete("section_request", sectionRequestId, `${row.assay_type}_workflow_v3`),
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
  "depth_um", "depth_index", "duplicates", "stains", "notes", "current_stage",
  ...SECTION_STAGES.map((s) => s.column),
] as const;

const SECTION_COLUMN_SET = new Set(Object.values(SECTION_STAGE_COLUMNS));

/** Create section-request cards from selected plan groups, and bump the block's max cut depth. */
export async function createSectionRequests(
  sampleId: number,
  groups: Array<{ depth_um: number; duplicates: number; stains?: string }>,
): Promise<number[]> {
  if (groups.length === 0) return [];
  const db = await getDb();
  // A block can only be cut once it has reached Embedded Inventory (issue #7).
  const sampleRows = await db.select<Array<{ current_stage: string }>>(
    `SELECT current_stage FROM samples WHERE id = ?`,
    [sampleId],
  );
  const stage = sampleRows[0]?.current_stage;
  if (!stage || (STAGE_ORDER[stage] ?? -1) < STAGE_ORDER.embedded) {
    throw new Error("This block must be embedded before it can be sent to sectioning.");
  }
  const timestamp = nowTimestamp();
  const ids: number[] = [];
  const existingDepths = await db.select<Array<{ depth_um: number; depth_index: number }>>(
    `SELECT depth_um, MIN(depth_index) AS depth_index
       FROM section_requests WHERE sample_id = ? AND depth_index IS NOT NULL
      GROUP BY depth_um ORDER BY depth_index`,
    [sampleId],
  );
  const depthIndexes = new Map(existingDepths.map((row) => [row.depth_um, row.depth_index]));
  const existingSlideOrdinals = await db.select<Array<{ depth_um: number; max_ordinal: number }>>(
    `SELECT sr.depth_um, COALESCE(MAX(sl.depth_duplicate_ordinal), 0) AS max_ordinal
       FROM section_requests sr LEFT JOIN slides sl ON sl.section_request_id = sr.id
      WHERE sr.sample_id = ? GROUP BY sr.depth_um`,
    [sampleId],
  );
  const nextSlideOrdinal = new Map(
    existingSlideOrdinals.map((row) => [row.depth_um, row.max_ordinal + 1]),
  );
  let nextDepthIndex = Math.max(0, ...existingDepths.map((row) => row.depth_index)) + 1;
  for (const g of groups) {
    let depthIndex = depthIndexes.get(g.depth_um);
    if (depthIndex === undefined) {
      depthIndex = nextDepthIndex;
      nextDepthIndex += 1;
      depthIndexes.set(g.depth_um, depthIndex);
    }
    const res = await db.execute(
      `INSERT INTO section_requests
        (sample_id, depth_um, depth_index, duplicates, stains, current_stage, stage_needs_sectioning_at)
       VALUES (?, ?, ?, ?, ?, 'needs_sectioning', ?)`,
      [sampleId, g.depth_um, depthIndex, Math.max(1, g.duplicates), g.stains ?? "", timestamp],
    );
    if (res.lastInsertId != null) {
      const sectionId = res.lastInsertId;
      ids.push(sectionId);
      const sampleRows = await db.select<Array<{ sample_code: string }>>(
        `SELECT sample_code FROM samples WHERE id = ?`,
        [sampleId],
      );
      const parentCode = sampleRows[0]?.sample_code ?? `BLOCK-${sampleId}`;
      for (let ordinal = 1; ordinal <= Math.max(1, g.duplicates); ordinal += 1) {
        const depthOrdinal = (nextSlideOrdinal.get(g.depth_um) ?? 1) + ordinal - 1;
        const slideCode = `${parentCode}-D${String(depthIndex).padStart(2, "0")}-${duplicateLabel(depthOrdinal)}`;
        await db.execute(
          `INSERT INTO slides
            (section_request_id, slide_ordinal, depth_duplicate_ordinal, slide_code, purpose, current_stage)
           VALUES (?, ?, ?, ?, 'extra', 'extra')`,
          [sectionId, ordinal, depthOrdinal, slideCode],
        );
      }
      nextSlideOrdinal.set(
        g.depth_um,
        (nextSlideOrdinal.get(g.depth_um) ?? 1) + Math.max(1, g.duplicates),
      );
    }
  }
  const deepest = Math.max(...groups.map((g) => g.depth_um));
  await db.execute(
    `UPDATE samples SET max_cut_depth_um = MAX(COALESCE(max_cut_depth_um, 0), ?) WHERE id = ?`,
    [deepest, sampleId],
  );
  return ids;
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
      GROUP BY sr.id
      HAVING NOT (
        sr.current_stage = 'ready_for_imaging'
        AND COALESCE(SUM(CASE WHEN sl.purpose = 'stain' THEN 1 ELSE 0 END), 0) = 0
      )
      ORDER BY s.is_priority DESC, s.prioritized_at DESC, sr.depth_um ASC, sr.id ASC`,
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
  const db = await getDb();
  const rows = await db.select<
    Array<{ duplicates: number; sample_code: string; depth_index: number; existing_count: number; max_depth_ordinal: number }>
  >(
    `SELECT sr.duplicates, sr.depth_index, s.sample_code, COUNT(sl.id) AS existing_count,
            COALESCE((
              SELECT MAX(sl2.depth_duplicate_ordinal)
                FROM slides sl2 JOIN section_requests sr2 ON sr2.id = sl2.section_request_id
               WHERE sr2.sample_id = sr.sample_id AND sr2.depth_index = sr.depth_index
            ), 0) AS max_depth_ordinal
       FROM section_requests sr
       JOIN samples s ON s.id = sr.sample_id
       LEFT JOIN slides sl ON sl.section_request_id = sr.id
      WHERE sr.id = ?
      GROUP BY sr.id`,
    [id],
  );
  const row = rows[0];
  if (!row) return;
  for (let ordinal = row.existing_count + 1; ordinal <= Math.max(1, row.duplicates); ordinal += 1) {
    const depthOrdinal = row.max_depth_ordinal + ordinal - row.existing_count;
    const slideCode = `${row.sample_code}-D${String(row.depth_index ?? 1).padStart(2, "0")}-${duplicateLabel(depthOrdinal)}`;
    await db.execute(
      `INSERT INTO slides
        (section_request_id, slide_ordinal, depth_duplicate_ordinal, slide_code, purpose, current_stage)
       VALUES (?, ?, ?, ?, 'extra', 'extra')`,
      [id, ordinal, depthOrdinal, slideCode],
    );
  }
}

export async function listSlidesForSectionRequest(id: number): Promise<Slide[]> {
  await ensureSlidesForSectionRequest(id);
  const db = await getDb();
  return db.select<Slide[]>(
    `SELECT * FROM slides WHERE section_request_id = ? ORDER BY slide_ordinal`,
    [id],
  );
}

export async function listExtraSlides(): Promise<Slide[]> {
  const db = await getDb();
  return db.select<Slide[]>(
    `SELECT sl.*, sr.depth_um, sr.depth_index, s.id AS sample_id, s.sample_code AS parent_code,
            s.sample_description, s.is_priority, p.code AS project_code, p.name AS project_name
       FROM slides sl
       JOIN section_requests sr ON sr.id = sl.section_request_id
       JOIN samples s ON s.id = sr.sample_id
       JOIN projects p ON p.id = s.project_id
      WHERE sl.purpose = 'extra' AND sl.assignment_saved = 1
        AND sl.current_stage = 'extra' AND p.is_active = 1
      ORDER BY s.is_priority DESC, p.code COLLATE NOCASE, s.project_sample_number,
               sr.depth_index, sl.depth_duplicate_ordinal, sl.id`,
  );
}

export interface ExtraSlideAssignResult {
  formerSectionId: number;
  targetSectionId: number;
  createdSectionId: number | null;
  formerSectionDeleted: boolean;
}

/**
 * Send an extra slide into stain/IHC work. Rather than always minting a new
 * cut group (which stranded companions until the imaging stage — issue #9),
 * the slide joins the block's existing open assay section when there is one:
 *   - already in an open assay section  -> convert it in place;
 *   - another open assay section exists  -> re-parent onto it;
 *   - none                              -> create a new section.
 * If re-parenting empties the slide's former cut group, that group is removed
 * so no orphaned, slide-less section is left behind (issue #10). The returned
 * metadata lets the caller register an undo command.
 */
export async function assignExtraSlideToAssay(input: {
  slideId: number;
  assayType: "stain" | "ihc";
  assayName: string;
}): Promise<ExtraSlideAssignResult> {
  const db = await getDb();
  const timestamp = nowTimestamp();
  const assayName = input.assayName.trim();
  const rows = await db.select<Array<{
    section_request_id: number;
    section_stage: string;
    sample_id: number;
    slide_ordinal: number;
    slide_code: string;
    depth_um: number;
    depth_index: number;
  }>>(
    `SELECT sl.section_request_id, sr.current_stage AS section_stage, sr.sample_id,
            sl.slide_ordinal, sl.slide_code, sr.depth_um, sr.depth_index
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

  const formerSectionId = slide.section_request_id;
  let targetSectionId: number;
  let createdSectionId: number | null = null;
  let slideOrdinal = 1;

  if (slide.section_stage === "stain_requested") {
    // The slide already sits in an open assay section for this block — convert
    // it in place, keeping its ordinal, so companions stay on one card.
    targetSectionId = formerSectionId;
    slideOrdinal = slide.slide_ordinal;
  } else {
    const existing = await db.select<Array<{ id: number; next_ordinal: number }>>(
      `SELECT sr.id, COALESCE(MAX(sl.slide_ordinal), 0) + 1 AS next_ordinal
         FROM section_requests sr LEFT JOIN slides sl ON sl.section_request_id = sr.id
        WHERE sr.sample_id = ? AND sr.id != ? AND sr.current_stage = 'stain_requested'
        GROUP BY sr.id
        ORDER BY sr.id DESC LIMIT 1`,
      [slide.sample_id, formerSectionId],
    );
    if (existing.length > 0) {
      targetSectionId = existing[0].id;
      slideOrdinal = existing[0].next_ordinal;
    } else {
      const request = await db.execute(
        `INSERT INTO section_requests
          (sample_id, depth_um, depth_index, duplicates, stains, current_stage,
           stage_sectioned_at, stage_assignment_required_at, stage_stain_requested_at)
         VALUES (?, ?, ?, 1, ?, 'stain_requested', ?, ?, ?)`,
        [slide.sample_id, slide.depth_um, slide.depth_index, assayName, timestamp, timestamp, timestamp],
      );
      if (!request.lastInsertId) throw new Error("Could not create assay work for that slide.");
      targetSectionId = request.lastInsertId;
      createdSectionId = targetSectionId;
    }
  }

  await db.execute(
    `UPDATE slides
        SET section_request_id = ?, slide_ordinal = ?,
            purpose = 'stain', assay_type = ?, assay_name = ?, stain_name = ?,
            current_stage = 'stain_requested', assignment_saved = 1,
            stage_stain_requested_at = COALESCE(stage_stain_requested_at, ?)
      WHERE id = ?`,
    [targetSectionId, slideOrdinal, input.assayType, assayName, assayName, timestamp, input.slideId],
  );

  let formerSectionDeleted = false;
  if (targetSectionId !== formerSectionId) {
    const remaining = await db.select<Array<{ c: number }>>(
      `SELECT COUNT(*) AS c FROM slides WHERE section_request_id = ?`,
      [formerSectionId],
    );
    if ((remaining[0]?.c ?? 0) === 0) {
      await deleteSectionRequest(formerSectionId);
      formerSectionDeleted = true;
    }
  }

  await db.execute(
    `INSERT INTO sample_timeline_events
      (sample_id, user_id, event_type, summary, created_at)
     VALUES (?, CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
             'extra_slide_assigned', ?, ?)`,
    [slide.sample_id, `${slide.slide_code} assigned to ${input.assayType === "ihc" ? "IHC" : "stain"}: ${assayName}`, timestamp],
  );

  return { formerSectionId, targetSectionId, createdSectionId, formerSectionDeleted };
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

export async function listAssayCatalog(): Promise<AssayCatalogEntry[]> {
  const db = await getDb();
  return db.select<AssayCatalogEntry[]>(
    `SELECT * FROM assay_catalog WHERE is_active = 1 ORDER BY assay_type, name COLLATE NOCASE`,
  );
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

export async function reinsertSlide(snapshot: Slide): Promise<void> {
  const db = await getDb();
  const columns = [
    "id", "section_request_id", "slide_ordinal", "slide_code", "purpose", "stain_name",
    "depth_duplicate_ordinal",
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
  "section_request_id", "slide_ordinal", "depth_duplicate_ordinal", "slide_code",
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
  const res = await db.execute(
    `UPDATE stain_requests
        SET status = 'acknowledged'
      WHERE status = 'requested'
        AND sample_code = ? COLLATE NOCASE
        AND requested_assay = ? COLLATE NOCASE
        AND (slide_code = '' OR slide_code = ? COLLATE NOCASE)`,
    [info.sample_code, info.assay.trim(), info.slide_code],
  );
  return res.rowsAffected ?? 0;
}

/** Move a request through requested -> acknowledged -> done / rejected. */
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
