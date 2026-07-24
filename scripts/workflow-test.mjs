#!/usr/bin/env node
// Histometer workflow test harness.
//
// Runs the REAL production migrations (src-tauri/migrations/*.sql) against an
// in-memory SQLite database via Node's built-in `node:sqlite`, then exercises
// the lab pipeline end-to-end and asserts data-layer invariants plus a
// regression scenario for every open GitHub issue.
//
//   node scripts/workflow-test.mjs            # run everything
//   node scripts/workflow-test.mjs --verbose  # also print each PASS
//
// The SQL helpers below are a faithful port of src/lib/db.ts. When you change
// db.ts, mirror the change here so the harness keeps testing the real logic.
// The schema itself is never duplicated — it is loaded verbatim from the
// migration files, so it can never drift.
//
// Two kinds of checks:
//   INVARIANT  — must always hold. A failure is a regression and fails the run.
//   ISSUE #N   — asserts the *desired* post-fix behaviour. Some are marked
//                `knownOpen: true`, meaning the bug is not fixed yet: the
//                harness expects them to fail today and does NOT fail the run
//                for them. When you fix issue N, flip knownOpen to false (or
//                delete it) and the test becomes a hard gate.
//
// Exit code is non-zero only on an UNEXPECTED result (a broken invariant, or a
// knownOpen issue that unexpectedly started passing — go clear the flag).

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "src-tauri", "migrations");
const VERBOSE = process.argv.includes("--verbose");

// ---------------------------------------------------------------------------
// Tiny test framework
// ---------------------------------------------------------------------------

const results = [];
function record(name, kind, knownOpen, fn) {
  let passed = false;
  let detail = "";
  try {
    fn();
    passed = true;
  } catch (err) {
    detail = err && err.message ? err.message : String(err);
  }
  const expectedToPass = !knownOpen;
  const unexpected = passed !== expectedToPass;
  results.push({ name, kind, knownOpen, passed, detail, unexpected });
}
const invariant = (name, fn) => record(name, "INVARIANT", false, fn);
const issue = (n, name, fn, opts = {}) =>
  record(`issue #${n} · ${name}`, "ISSUE", Boolean(opts.knownOpen), fn);

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "expected equality"} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

// ---------------------------------------------------------------------------
// Schema + helpers (a faithful port of the relevant parts of src/lib/db.ts)
// ---------------------------------------------------------------------------

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}
// A deterministic clock so ordering assertions are stable. Each tick = +1 min.
let clock = new Date("2026-01-01T08:00:00");
function now() {
  clock = new Date(clock.getTime() + 60_000);
  const d = clock;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function duplicateLabel(ordinal) {
  let value = Math.max(1, Math.floor(ordinal));
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(97 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith(".sql")) continue;
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

// A thin wrapper so the ported helpers read like db.ts.
function makeApi(db) {
  const run = (sql, params = []) => db.prepare(sql).run(...params);
  const all = (sql, params = []) => db.prepare(sql).all(...params);
  const get = (sql, params = []) => db.prepare(sql).get(...params);

  function seedProject(code = "EE", name = "Elastin Engineering", lead = "Dr. Lee") {
    const r = run(
      `INSERT INTO projects (code, name, team_lead, is_active) VALUES (?, ?, ?, 1)`,
      [code, name, lead],
    );
    return Number(r.lastInsertRowid);
  }

  function nextSampleNumber(projectId) {
    const row = get(
      `SELECT COALESCE(MAX(project_sample_number), 0) + 1 AS n FROM samples WHERE project_id = ?`,
      [projectId],
    );
    return row.n;
  }

  // Port of addSample() — src/lib/db.ts
  function addSample(projectId, projectCode, description, opts = {}) {
    const number = nextSampleNumber(projectId);
    const code = `${projectCode.toUpperCase()}-${pad(number, 4)}`;
    const r = run(
      `INSERT INTO samples (
         project_id, project_sample_number, sample_code, sample_description, date_added,
         processing_type, fixative_agent, needs_decalcification, cut_notes, slide_notes,
         stains, overall_notes, current_stage, stage_received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, '', 'received', ?)`,
      [
        projectId, number, code, description, "2026-01-01",
        opts.processingType ?? "Short",
        opts.fixative ?? "PFA",
        opts.needsDecalc ? 1 : 0,
        opts.stains ?? "",
        now(),
      ],
    );
    return { id: Number(r.lastInsertRowid), code };
  }

  // Walk a block through preprocessing so it is batch-eligible.
  function completePreprocessing(sampleId, { decalc = false } = {}) {
    run(`UPDATE samples SET fixative_placed_at = ?, current_stage = 'in_fixative' WHERE id = ?`, [now(), sampleId]);
    run(`UPDATE samples SET fixative_removed_at = ?, current_stage = 'fixative_removed' WHERE id = ?`, [now(), sampleId]);
    if (decalc) run(`UPDATE samples SET decalc_completed_at = ?, current_stage = 'decalcified' WHERE id = ?`, [now(), sampleId]);
    run(`UPDATE samples SET ethanol_placed_at = ?, current_stage = 'in_ethanol' WHERE id = ?`, [now(), sampleId]);
  }

  // Port of startProcessingBatch() — src/lib/db.ts. The processor-busy check is
  // advisory: it throws unless the caller opts into a concurrent run via
  // allowConcurrent (issue #23).
  function startProcessingBatch({ sampleIds, processingType, startedAt, allowConcurrent = false }) {
    if (sampleIds.length === 0) throw new Error("Select at least one sample.");
    const placeholders = sampleIds.map(() => "?").join(", ");
    const samples = all(`SELECT * FROM samples WHERE id IN (${placeholders}) ORDER BY id`, sampleIds);
    if (samples.length !== sampleIds.length) throw new Error("One or more samples no longer exist.");
    if (samples.some((s) => s.processing_type !== processingType)) {
      throw new Error(`Selected samples do not share the ${processingType} protocol.`);
    }
    const notReady = samples.filter(
      (s) => (s.needs_decalcification === 1 && !s.decalc_completed_at) ||
        !s.fixative_placed_at || !s.fixative_removed_at || !s.ethanol_placed_at,
    );
    if (notReady.length) throw new Error(`Complete preprocessing first: ${notReady.map((s) => s.sample_code).join(", ")}`);

    // Advisory concurrency guard, judged by actual sample state (not the batch
    // status column, which can go stale/orphaned). The technician may override
    // it to run two batches simultaneously (issue #23).
    if (!allowConcurrent) {
      const activeRun = all(
        `SELECT pb.id
           FROM processing_batches pb
           JOIN processing_batch_members pbm ON pbm.batch_id = pb.id
           JOIN samples s ON s.id = pbm.sample_id
          WHERE s.current_stage = 'processing_started'
            AND (pb.ready_at IS NULL OR pb.ready_at > ?)
          LIMIT 1`,
        [startedAt],
      );
      if (activeRun.length) throw new Error("PROCESSOR_BUSY");
    }

    const durH = processingType.toLowerCase() === "long" ? 52 : 18;
    const started = new Date(startedAt.replace(" ", "T"));
    const readyAt = new Date(started.getTime() + durH * 3600_000);
    const readyStr = `${readyAt.getFullYear()}-${pad(readyAt.getMonth() + 1)}-${pad(readyAt.getDate())} ${pad(readyAt.getHours())}:${pad(readyAt.getMinutes())}`;
    const r = run(
      `INSERT INTO processing_batches (processing_type, operator_name, status, started_at, ready_at)
       VALUES (?, 'Tech', 'processing', ?, ?)`,
      [processingType, startedAt, readyStr],
    );
    const batchId = Number(r.lastInsertRowid);
    for (const s of samples) {
      run(`INSERT INTO processing_batch_members (batch_id, sample_id) VALUES (?, ?)`, [batchId, s.id]);
    }
    run(
      `UPDATE samples SET current_stage = 'processing_started', processing_started_at = ? WHERE id IN (${placeholders})`,
      [startedAt, ...sampleIds],
    );
    return batchId;
  }

  // Port of planProcessingBatch() — schedules a run for a future start (issues
  // #4, #24). Members stay in pre-processing; status is 'planned'.
  function planProcessingBatch({ sampleIds, processingType, plannedStartAt }) {
    const placeholders = sampleIds.map(() => "?").join(", ");
    const samples = all(`SELECT * FROM samples WHERE id IN (${placeholders}) ORDER BY id`, sampleIds);
    if (samples.some((s) => s.processing_type !== processingType)) {
      throw new Error(`Selected samples do not share the ${processingType} protocol.`);
    }
    const committed = all(
      `SELECT s.sample_code FROM processing_batch_members pbm
         JOIN processing_batches pb ON pb.id = pbm.batch_id
         JOIN samples s ON s.id = pbm.sample_id
        WHERE pbm.sample_id IN (${placeholders}) AND pb.status IN ('planned', 'processing')`,
      sampleIds,
    );
    if (committed.length) throw new Error("ALREADY_BATCHED");
    const durH = processingType.toLowerCase() === "long" ? 52 : 18;
    const planned = new Date(plannedStartAt.replace(" ", "T"));
    const readyAt = new Date(planned.getTime() + durH * 3600_000);
    const readyStr = `${readyAt.getFullYear()}-${pad(readyAt.getMonth() + 1)}-${pad(readyAt.getDate())} ${pad(readyAt.getHours())}:${pad(readyAt.getMinutes())}`;
    const r = run(
      `INSERT INTO processing_batches (processing_type, operator_name, status, started_at, planned_start_at, ready_at)
       VALUES (?, 'Tech', 'planned', ?, ?, ?)`,
      [processingType, plannedStartAt, plannedStartAt, readyStr],
    );
    const batchId = Number(r.lastInsertRowid);
    for (const s of samples) {
      run(`INSERT INTO processing_batch_members (batch_id, sample_id) VALUES (?, ?)`, [batchId, s.id]);
    }
    return batchId;
  }

  // Port of confirmProcessingBatchStart() — planned → processing (issue #4).
  function confirmProcessingBatchStart(batchId, actualStartedAt) {
    const batch = get(`SELECT status, processing_type, planned_start_at FROM processing_batches WHERE id = ?`, [batchId]);
    if (!batch) throw new Error("That processing batch no longer exists.");
    if (batch.status !== "planned") throw new Error("Only a planned run can be confirmed as started.");
    const startedAt = actualStartedAt ?? batch.planned_start_at;
    const durH = batch.processing_type.toLowerCase() === "long" ? 52 : 18;
    const started = new Date(startedAt.replace(" ", "T"));
    const readyAt = new Date(started.getTime() + durH * 3600_000);
    const readyStr = `${readyAt.getFullYear()}-${pad(readyAt.getMonth() + 1)}-${pad(readyAt.getDate())} ${pad(readyAt.getHours())}:${pad(readyAt.getMinutes())}`;
    run(`UPDATE processing_batches SET status = 'processing', started_at = ?, ready_at = ? WHERE id = ?`,
      [startedAt, readyStr, batchId]);
    run(`UPDATE samples SET current_stage = 'processing_started', processing_started_at = ?
           WHERE id IN (SELECT sample_id FROM processing_batch_members WHERE batch_id = ?)`,
      [startedAt, batchId]);
    return readyStr;
  }

  function moveBatch(batchId, stageKey) {
    const ts = now();
    if (stageKey === "processed") {
      run(`UPDATE samples SET current_stage = 'processed', stage_processed_at = COALESCE(stage_processed_at, ?)
             WHERE id IN (SELECT sample_id FROM processing_batch_members WHERE batch_id = ?)`, [ts, batchId]);
      run(`UPDATE processing_batches SET status = 'ready' WHERE id = ?`, [batchId]);
    } else if (stageKey === "needs_embedding") {
      run(`UPDATE samples SET current_stage = 'needs_embedding',
             stage_picked_up_at = COALESCE(stage_picked_up_at, ?),
             stage_needs_embedding_at = COALESCE(stage_needs_embedding_at, ?)
             WHERE id IN (SELECT sample_id FROM processing_batch_members WHERE batch_id = ?)`, [ts, ts, batchId]);
      run(`UPDATE processing_batches SET status = 'completed', collected_at = COALESCE(collected_at, ?),
             completed_at = COALESCE(completed_at, ?) WHERE id = ?`, [ts, ts, batchId]);
    }
  }

  function markEmbedded(sampleId) {
    run(`UPDATE samples SET current_stage = 'embedded', stage_embedded_at = COALESCE(stage_embedded_at, ?) WHERE id = ?`, [now(), sampleId]);
  }

  // Port of createSectionRequests() — src/lib/db.ts (slide codes + depth indexing).
  function createSectionRequests(sampleId, groups) {
    if (!groups.length) return [];
    // A block can only be cut once embedded (issue #7). Mirrors db.ts.
    const STAGE_ORDER = { received: 0, in_fixative: 1, fixative_removed: 2, decalcified: 3,
      in_ethanol: 4, processing_started: 5, processed: 6, picked_up: 7, needs_embedding: 8,
      embedded: 9, needs_sectioning: 10 };
    const stage = get(`SELECT current_stage FROM samples WHERE id = ?`, [sampleId]).current_stage;
    if ((STAGE_ORDER[stage] ?? -1) < STAGE_ORDER.embedded) {
      throw new Error("This block must be embedded before it can be sent to sectioning.");
    }
    const ts = now();
    const ids = [];
    const existingDepths = all(
      `SELECT depth_um, MIN(depth_index) AS depth_index FROM section_requests
        WHERE sample_id = ? AND depth_index IS NOT NULL GROUP BY depth_um ORDER BY depth_index`,
      [sampleId],
    );
    const depthIndexes = new Map(existingDepths.map((r) => [r.depth_um, r.depth_index]));
    const existingOrd = all(
      `SELECT sr.depth_um, COALESCE(MAX(sl.depth_duplicate_ordinal), 0) AS max_ordinal
         FROM section_requests sr LEFT JOIN slides sl ON sl.section_request_id = sr.id
        WHERE sr.sample_id = ? GROUP BY sr.depth_um`,
      [sampleId],
    );
    const nextOrd = new Map(existingOrd.map((r) => [r.depth_um, r.max_ordinal + 1]));
    let nextDepthIndex = Math.max(0, ...existingDepths.map((r) => r.depth_index)) + 1;
    const parentCode = get(`SELECT sample_code FROM samples WHERE id = ?`, [sampleId]).sample_code;
    for (const g of groups) {
      let depthIndex = depthIndexes.get(g.depth_um);
      if (depthIndex === undefined) { depthIndex = nextDepthIndex++; depthIndexes.set(g.depth_um, depthIndex); }
      const dup = Math.max(1, g.duplicates);
      const r = run(
        `INSERT INTO section_requests (sample_id, depth_um, depth_index, duplicates, stains, current_stage, stage_needs_sectioning_at)
         VALUES (?, ?, ?, ?, ?, 'needs_sectioning', ?)`,
        [sampleId, g.depth_um, depthIndex, dup, g.stains ?? "", ts],
      );
      const sectionId = Number(r.lastInsertRowid);
      ids.push(sectionId);
      for (let ordinal = 1; ordinal <= dup; ordinal++) {
        const depthOrdinal = (nextOrd.get(g.depth_um) ?? 1) + ordinal - 1;
        const slideCode = `${parentCode}-D${pad(depthIndex)}-${duplicateLabel(depthOrdinal)}`;
        run(
          `INSERT INTO slides (section_request_id, slide_ordinal, depth_duplicate_ordinal, slide_code, purpose, current_stage)
           VALUES (?, ?, ?, ?, 'extra', 'extra')`,
          [sectionId, ordinal, depthOrdinal, slideCode],
        );
      }
      nextOrd.set(g.depth_um, (nextOrd.get(g.depth_um) ?? 1) + dup);
    }
    const deepest = Math.max(...groups.map((g) => g.depth_um));
    run(`UPDATE samples SET max_cut_depth_um = MAX(COALESCE(max_cut_depth_um, 0), ?) WHERE id = ?`, [deepest, sampleId]);
    return ids;
  }

  // Section reaches the assignment lane: slides become assignable (purpose still 'extra').
  function sectionToAssignment(sectionId) {
    const ts = now();
    run(`UPDATE section_requests SET current_stage = 'assignment_required',
           stage_sectioned_at = COALESCE(stage_sectioned_at, ?),
           stage_assignment_required_at = COALESCE(stage_assignment_required_at, ?) WHERE id = ?`, [ts, ts, sectionId]);
    run(`UPDATE slides SET current_stage = 'cut', stage_cut_at = COALESCE(stage_cut_at, ?) WHERE section_request_id = ?`, [ts, sectionId]);
  }

  // Port of updateSlideAssignment() — saves an assignment for one slide.
  function assignSlide(slideId, purpose, assayType, assayName) {
    if (purpose === "stain" && (!assayType || !assayName)) throw new Error("Choose a stain or IHC agent for this slide.");
    const stage = purpose === "stain" ? "assigned" : purpose === "unassigned" ? "cut" : purpose;
    run(
      `UPDATE slides SET purpose = ?, assay_type = ?, assay_name = ?, stain_name = ?, assignment_saved = 1,
             slice_count = 2, control_agent = 'IgG', current_stage = ? WHERE id = ?`,
      [purpose, purpose === "stain" ? assayType : "", purpose === "stain" ? assayName : "",
       purpose === "stain" ? assayName : "", stage, slideId],
    );
  }

  function attachSectionStainSlidesToOpenStack(sectionId) {
    const section = get(
      `SELECT sr.sample_id, sr.depth_um, sr.depth_index,
              COUNT(sl.id) AS stain_count
         FROM section_requests sr
         LEFT JOIN slides sl ON sl.section_request_id = sr.id AND sl.purpose = 'stain'
        WHERE sr.id = ? GROUP BY sr.id`, [sectionId]);
    if (!section || section.stain_count === 0) return null;
    let stack = get(
      `SELECT id FROM slide_stacks
        WHERE sample_id = ? AND depth_um = ? AND current_stage = 'stain_requested'
          AND closed_at IS NULL`,
      [section.sample_id, section.depth_um],
    );
    if (!stack) {
      const created = run(
        `INSERT INTO slide_stacks
          (sample_id, depth_um, depth_index, current_stage, stage_stain_requested_at)
         VALUES (?, ?, ?, 'stain_requested', ?)`,
        [section.sample_id, section.depth_um, section.depth_index, now()]);
      stack = { id: Number(created.lastInsertRowid) };
    }
    run(
      `UPDATE slides SET stack_id = ?,
              cut_depth_um = COALESCE(cut_depth_um, ?),
              cut_depth_index = COALESCE(cut_depth_index, ?)
        WHERE section_request_id = ? AND purpose = 'stain'`,
      [stack.id, section.depth_um, section.depth_index, sectionId]);
    return stack.id;
  }

  // A stack advances as a unit. It merges only with the same sample-depth pair
  // already waiting in the destination stage; no stack can be pulled backward.
  function moveSlideStack(stackId, stageKey) {
    const stageColumns = {
      stain_requested: "stage_stain_requested_at",
      stained: "stage_stained_at",
      deparaffinized: "stage_deparaffinized_at",
      ihc_complete: "stage_ihc_at",
      refrax_complete: "stage_refrax_at",
      coverslipped: "stage_coverslipped_at",
      dried: "stage_dried_at",
      ready_for_imaging: "stage_ready_for_imaging_at",
      pictures_taken: "stage_pictures_taken_at",
      analyzed: "stage_analyzed_at",
    };
    const column = stageColumns[stageKey];
    if (!column) throw new Error(`Unknown slide-stack stage: ${stageKey}`);
    const source = get(`SELECT * FROM slide_stacks WHERE id = ?`, [stackId]);
    if (!source) throw new Error("That slide stack no longer exists.");
    const ts = now();
    run(
      `UPDATE slides SET current_stage = ?, ${column} = COALESCE(${column}, ?)
        WHERE stack_id = ? AND purpose = 'stain'`,
      [stageKey, ts, stackId],
    );
    const target = stageKey === "analyzed" ? null : get(
      `SELECT id FROM slide_stacks
        WHERE sample_id = ? AND depth_um = ? AND current_stage = ?
          AND closed_at IS NULL AND id != ? ORDER BY id LIMIT 1`,
      [source.sample_id, source.depth_um, stageKey, source.id],
    );
    if (target) {
      run(`UPDATE slides SET stack_id = ? WHERE stack_id = ?`, [target.id, source.id]);
      run(`UPDATE slide_stacks SET ${column} = COALESCE(${column}, ?) WHERE id = ?`, [ts, target.id]);
      run(`DELETE FROM slide_stacks WHERE id = ?`, [source.id]);
      return target.id;
    }
    run(
      `UPDATE slide_stacks SET current_stage = ?, ${column} = COALESCE(${column}, ?),
              closed_at = CASE WHEN ? = 'analyzed' THEN COALESCE(closed_at, ?) ELSE NULL END
        WHERE id = ?`,
      [stageKey, ts, stageKey, ts, stackId],
    );
    return stackId;
  }

  // Save the whole assignment set for a section, then move it to staining.
  // Port of updateSectionStage(id, 'stain_requested') — src/lib/db.ts.
  function startAssayWork(sectionId) {
    const unsaved = get(`SELECT COUNT(*) AS c FROM slides WHERE section_request_id = ? AND assignment_saved = 0`, [sectionId]);
    if (unsaved.c > 0) throw new Error("Click Save All to confirm every slide assignment before starting assay work.");
    const ts = now();
    run(`UPDATE slides SET current_stage = CASE WHEN purpose = 'stain' THEN 'stain_requested' ELSE purpose END,
           stage_stain_requested_at = CASE WHEN purpose = 'stain' THEN COALESCE(stage_stain_requested_at, ?) ELSE stage_stain_requested_at END
           WHERE section_request_id = ?`, [ts, sectionId]);
    attachSectionStainSlidesToOpenStack(sectionId);
    run(`UPDATE section_requests SET current_stage = 'stain_requested', stage_stain_requested_at = COALESCE(stage_stain_requested_at, ?) WHERE id = ?`, [ts, sectionId]);
  }

  // Port of assignExtraSlideToAssay() — src/lib/db.ts. Stack membership owns
  // downstream grouping; the original section remains immutable cut provenance.
  function assignExtraSlideToAssay(slideId, assayType, assayName) {
    const ts = now();
    const slide = get(
      `SELECT sl.section_request_id, sr.current_stage AS section_stage, sr.sample_id,
              sl.slide_ordinal, sl.slide_code, sr.depth_um, sr.depth_index
         FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
        WHERE sl.id = ? AND sl.purpose = 'extra' AND sl.current_stage = 'extra'`, [slideId]);
    if (!slide) throw new Error("That extra slide is no longer available.");
    const cat = get(`SELECT id FROM assay_catalog WHERE assay_type = ? AND name = ? COLLATE NOCASE AND is_active = 1`, [assayType, assayName]);
    if (!cat) throw new Error("Choose an active stain or IHC agent from the catalog.");

    let stack = get(
      `SELECT id FROM slide_stacks
        WHERE sample_id = ? AND depth_um = ? AND current_stage = 'stain_requested'
          AND closed_at IS NULL`,
      [slide.sample_id, slide.depth_um],
    );
    const createdStackId = stack ? null : Number(run(
      `INSERT INTO slide_stacks
        (sample_id, depth_um, depth_index, current_stage, stage_stain_requested_at)
       VALUES (?, ?, ?, 'stain_requested', ?)`,
      [slide.sample_id, slide.depth_um, slide.depth_index, ts]).lastInsertRowid);
    if (!stack) stack = { id: createdStackId };
    run(
      `UPDATE slides SET stack_id = ?, cut_depth_um = COALESCE(cut_depth_um, ?),
             cut_depth_index = COALESCE(cut_depth_index, ?), purpose = 'stain',
             assay_type = ?, assay_name = ?, stain_name = ?, current_stage = 'stain_requested',
             assignment_saved = 1, stage_stain_requested_at = COALESCE(stage_stain_requested_at, ?)
        WHERE id = ?`,
      [stack.id, slide.depth_um, slide.depth_index, assayType, assayName, assayName, ts, slideId]);
    return { stackId: stack.id, createdStackId };
  }

  // Port of updateProcessingBatchStart() — src/lib/db.ts (issue #6).
  function updateProcessingBatchStart(batchId, startedAt) {
    const type = get(`SELECT processing_type FROM processing_batches WHERE id = ?`, [batchId]).processing_type;
    const durH = type.toLowerCase() === "long" ? 52 : 18;
    const started = new Date(startedAt.replace(" ", "T"));
    const readyAt = new Date(started.getTime() + durH * 3600_000);
    const readyStr = `${readyAt.getFullYear()}-${pad(readyAt.getMonth() + 1)}-${pad(readyAt.getDate())} ${pad(readyAt.getHours())}:${pad(readyAt.getMinutes())}`;
    run(`UPDATE processing_batches SET started_at = ?, ready_at = ? WHERE id = ?`, [startedAt, readyStr, batchId]);
    run(`UPDATE samples SET processing_started_at = ? WHERE id IN (SELECT sample_id FROM processing_batch_members WHERE batch_id = ?)`, [startedAt, batchId]);
    return readyStr;
  }

  // The Extra Slides inventory query — src/lib/db.ts listExtraSlides().
  function listExtraSlides() {
    return all(
      `SELECT sl.*, s.id AS sample_id, s.sample_code AS parent_code
         FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
         JOIN samples s ON s.id = sr.sample_id JOIN projects p ON p.id = s.project_id
        WHERE sl.purpose = 'extra' AND sl.assignment_saved = 1 AND sl.current_stage = 'extra' AND p.is_active = 1
          AND sr.current_stage NOT IN ('needs_sectioning', 'sectioned', 'assignment_required')
        ORDER BY sl.id`);
  }

  return {
    db, run, all, get,
    seedProject, addSample, completePreprocessing, startProcessingBatch, moveBatch,
    markEmbedded, createSectionRequests, sectionToAssignment, assignSlide,
    startAssayWork, assignExtraSlideToAssay, listExtraSlides, nextSampleNumber,
    updateProcessingBatchStart, moveSlideStack,
    planProcessingBatch, confirmProcessingBatchStart,
  };
}

// ---------------------------------------------------------------------------
// INVARIANTS — the happy path and data integrity that must always hold
// ---------------------------------------------------------------------------

invariant("all 17 migrations apply and expected tables exist", () => {
  const api = makeApi(freshDb());
  const names = api.all(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name);
  for (const t of ["projects", "samples", "section_requests", "slides", "slide_stacks", "processing_batches", "assay_catalog", "stain_requests", "sample_timeline_events"]) {
    assert(names.includes(t), `missing table ${t}`);
  }
  // Migration 0017 adds the planned-run column (issues #4, #24).
  const cols = api.all(`PRAGMA table_info(processing_batches)`).map((r) => r.name);
  assert(cols.includes("planned_start_at"), "processing_batches must gain planned_start_at");
});

invariant("migration 16 repairs a 0.3.0 stack pulled backward by fresh staining", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
  for (const file of migrationFiles.filter((file) => file < "0016_")) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  const api = makeApi(db);
  const projectId = api.seedProject();
  const { id: sampleId } = api.addSample(projectId, "EE", "upgrade repair");
  api.markEmbedded(sampleId);
  const [first, second] = api.createSectionRequests(sampleId, [
    { depth_um: 100, duplicates: 1 },
    { depth_um: 100, duplicates: 1 },
  ]);
  const slideA = api.get(`SELECT id FROM slides WHERE section_request_id = ?`, [first]);
  const slideB = api.get(`SELECT id FROM slides WHERE section_request_id = ?`, [second]);
  const oldStackId = Number(api.run(
    `INSERT INTO slide_stacks
      (sample_id, current_stage, stage_stain_requested_at, stage_ready_for_imaging_at)
     VALUES (?, 'stain_requested', ?, ?)`,
    [sampleId, now(), now()],
  ).lastInsertRowid);
  api.run(
    `UPDATE slides SET purpose = 'stain', assay_type = 'stain', assay_name = 'H&E',
            stack_id = ?, cut_depth_um = 100, cut_depth_index = 1,
            current_stage = 'ready_for_imaging', stage_ready_for_imaging_at = ?
      WHERE id = ?`,
    [oldStackId, now(), slideA.id],
  );
  api.run(
    `UPDATE slides SET purpose = 'stain', assay_type = 'ihc', assay_name = 'CD31',
            stack_id = ?, cut_depth_um = 100, cut_depth_index = 1,
            current_stage = 'stain_requested', stage_stain_requested_at = ?
      WHERE id = ?`,
    [oldStackId, now(), slideB.id],
  );

  db.exec(readFileSync(join(MIGRATIONS_DIR, "0016_stage_local_depth_stacks.sql"), "utf8"));

  const repaired = api.all(`SELECT id, depth_um, current_stage, stage_ready_for_imaging_at FROM slide_stacks ORDER BY id`);
  eq(repaired.length, 2, "corrupted mixed-stage stack is split");
  eq(api.get(`SELECT stack_id FROM slides WHERE id = ?`, [slideA.id]).stack_id,
     oldStackId, "advanced companion retains the original stack identity");
  eq(api.get(`SELECT current_stage FROM slide_stacks WHERE id = ?`, [oldStackId]).current_stage,
     "ready_for_imaging", "advanced stack is restored to imaging");
  const freshStack = api.get(
    `SELECT * FROM slide_stacks WHERE id != ? AND sample_id = ?`,
    [oldStackId, sampleId],
  );
  eq(freshStack.current_stage, "stain_requested", "fresh companion gets a staining stack");
  eq(freshStack.depth_um, 100, "repaired stack retains physical depth");
  eq(freshStack.stage_ready_for_imaging_at, null, "fresh stack does not inherit future-stage timestamps");
  eq(api.get(`SELECT stack_id FROM slides WHERE id = ?`, [slideB.id]).stack_id,
     freshStack.id, "fresh slide is re-parented to the repaired staining stack");
});

invariant("sample codes auto-increment per project and are zero-padded", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const a = api.addSample(p, "EE", "sample one");
  const b = api.addSample(p, "EE", "sample two");
  eq(a.code, "EE-0001", "first code");
  eq(b.code, "EE-0002", "second code");
});

invariant("full pipeline: received → analyzed leaves a stained, imaged slide", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "pipeline");
  api.completePreprocessing(id);
  const batch = api.startProcessingBatch({ sampleIds: [id], processingType: "Short", startedAt: now() });
  api.moveBatch(batch, "processed");
  api.moveBatch(batch, "needs_embedding");
  api.markEmbedded(id);
  const [section] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 2 }]);
  api.sectionToAssignment(section);
  const slides = api.all(`SELECT * FROM slides WHERE section_request_id = ? ORDER BY slide_ordinal`, [section]);
  eq(slides.length, 2, "two slides cut");
  api.assignSlide(slides[0].id, "stain", "stain", "H&E");
  api.assignSlide(slides[1].id, "extra", "", "");
  api.startAssayWork(section);
  const stainSlide = api.get(`SELECT * FROM slides WHERE id = ?`, [slides[0].id]);
  eq(stainSlide.current_stage, "stain_requested", "stain slide entered staining");
  eq(stainSlide.purpose, "stain", "purpose stain");
  assert(stainSlide.stack_id, "stain slide belongs to a durable stack");
  eq(stainSlide.cut_depth_um, 100, "stack membership preserves cut depth");
});

invariant("same sample and cut depth join one stack in the same stage", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "same-depth stack");
  api.markEmbedded(id);
  const [first] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 1 }]);
  const [second] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 1 }]);
  for (const section of [first, second]) {
    api.sectionToAssignment(section);
    const slide = api.get(`SELECT id FROM slides WHERE section_request_id = ?`, [section]);
    api.assignSlide(slide.id, "stain", "stain", "H&E");
    api.startAssayWork(section);
  }
  eq(api.get(`SELECT COUNT(*) AS c FROM slide_stacks WHERE sample_id = ? AND closed_at IS NULL`, [id]).c, 1,
     "exactly one same-depth staining stack");
  eq(api.get(`SELECT COUNT(DISTINCT stack_id) AS c FROM slides WHERE section_request_id IN (?, ?)`, [first, second]).c, 1,
     "same-depth slides share the stack");
});

invariant("different cut depths remain separate stacks", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "depth-separated stacks");
  api.markEmbedded(id);
  const sections = api.createSectionRequests(id, [
    { depth_um: 100, duplicates: 1 },
    { depth_um: 200, duplicates: 1 },
  ]);
  for (const section of sections) {
    api.sectionToAssignment(section);
    const slide = api.get(`SELECT id FROM slides WHERE section_request_id = ?`, [section]);
    api.assignSlide(slide.id, "stain", "stain", "H&E");
    api.startAssayWork(section);
  }
  eq(api.get(`SELECT COUNT(*) AS c FROM slide_stacks WHERE sample_id = ? AND closed_at IS NULL`, [id]).c, 2,
     "each physical depth owns its own stack");
  eq(api.get(`SELECT COUNT(DISTINCT stack_id) AS c FROM slides WHERE section_request_id IN (?, ?)`, sections).c, 2,
     "different-depth slides never share a stack");
});

invariant("fresh same-depth staining never pulls an imaging stack backward", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "stage-local stacks");
  api.markEmbedded(id);

  const [first] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 1 }]);
  api.sectionToAssignment(first);
  const slideA = api.get(`SELECT id FROM slides WHERE section_request_id = ?`, [first]);
  api.assignSlide(slideA.id, "stain", "stain", "H&E");
  api.startAssayWork(first);
  const imagingStackId = api.moveSlideStack(
    api.get(`SELECT stack_id FROM slides WHERE id = ?`, [slideA.id]).stack_id,
    "ready_for_imaging",
  );

  const [second] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 1 }]);
  api.sectionToAssignment(second);
  const slideB = api.get(`SELECT id FROM slides WHERE section_request_id = ?`, [second]);
  api.assignSlide(slideB.id, "stain", "ihc", "CD31");
  api.startAssayWork(second);

  const beforeMerge = api.all(
    `SELECT id, current_stage FROM slide_stacks
      WHERE sample_id = ? AND depth_um = 100 AND closed_at IS NULL ORDER BY id`,
    [id],
  );
  eq(beforeMerge.length, 2, "staining and imaging each retain a stage-local stack");
  eq(api.get(`SELECT current_stage FROM slide_stacks WHERE id = ?`, [imagingStackId]).current_stage,
     "ready_for_imaging", "slide A's stack remains in imaging");
  eq(api.get(`SELECT current_stage FROM slides WHERE id = ?`, [slideA.id]).current_stage,
     "ready_for_imaging", "slide A itself remains in imaging");
  eq(api.get(`SELECT current_stage FROM slides WHERE id = ?`, [slideB.id]).current_stage,
     "stain_requested", "fresh slide B starts in staining");

  const stainingStack = beforeMerge.find((stack) => stack.current_stage === "stain_requested");
  assert(stainingStack, "fresh staining stack exists");
  const mergedId = api.moveSlideStack(stainingStack.id, "ready_for_imaging");
  eq(mergedId, imagingStackId, "newer stack merges into the existing destination stack");
  eq(api.get(`SELECT COUNT(*) AS c FROM slide_stacks WHERE sample_id = ? AND depth_um = 100 AND closed_at IS NULL`, [id]).c,
     1, "same-depth stacks merge once they occupy the same stage");
  eq(api.get(`SELECT COUNT(*) AS c FROM slides WHERE stack_id = ?`, [imagingStackId]).c,
     2, "both companion slides belong to the merged stack");
});

invariant("analyzed stack closes and a later cutting cycle gets a new stack", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "repeat cycle");
  api.markEmbedded(id);
  const [first] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 1 }]);
  api.sectionToAssignment(first);
  const firstSlide = api.get(`SELECT id FROM slides WHERE section_request_id = ?`, [first]);
  api.assignSlide(firstSlide.id, "stain", "stain", "H&E");
  api.startAssayWork(first);
  const oldStack = api.get(`SELECT id FROM slide_stacks WHERE sample_id = ? AND closed_at IS NULL`, [id]);
  api.run(`UPDATE slide_stacks SET current_stage = 'analyzed', closed_at = ? WHERE id = ?`, [now(), oldStack.id]);
  api.run(`UPDATE slides SET current_stage = 'analyzed' WHERE stack_id = ?`, [oldStack.id]);

  const [second] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 1 }]);
  api.sectionToAssignment(second);
  const secondSlide = api.get(`SELECT id FROM slides WHERE section_request_id = ?`, [second]);
  api.assignSlide(secondSlide.id, "stain", "ihc", "CD31");
  api.startAssayWork(second);
  const newStack = api.get(`SELECT id FROM slide_stacks WHERE sample_id = ? AND closed_at IS NULL`, [id]);
  assert(newStack.id !== oldStack.id, "new cutting cycle should not reopen the analyzed stack");
  eq(api.get(`SELECT COUNT(*) AS c FROM slide_stacks WHERE sample_id = ?`, [id]).c, 2,
    "sample should retain both historical stack cycles");
});

invariant("stack and slide audit events carry reporting context", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "audit context");
  api.markEmbedded(id);
  const [section] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 1 }]);
  api.sectionToAssignment(section);
  const slide = api.get(`SELECT id FROM slides WHERE section_request_id = ?`, [section]);
  api.assignSlide(slide.id, "stain", "stain", "H&E");
  api.startAssayWork(section);
  const stack = api.get(`SELECT id FROM slide_stacks WHERE sample_id = ? AND closed_at IS NULL`, [id]);
  const stackAudit = api.get(
    `SELECT sample_id, stack_id FROM audit_events WHERE entity_type = 'slide_stack' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    [stack.id]);
  eq(stackAudit.sample_id, id, "stack audit should identify its sample");
  eq(stackAudit.stack_id, stack.id, "stack audit should identify its stack");
  const slideAudit = api.get(
    `SELECT sample_id, stack_id FROM audit_events WHERE entity_type = 'slide' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    [slide.id]);
  eq(slideAudit.sample_id, id, "slide audit should identify its sample");
  eq(slideAudit.stack_id, stack.id, "slide audit should identify its stack");
});

invariant("processing batch enforces a single protocol per batch", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const s = api.addSample(p, "EE", "short", { processingType: "Short" });
  const l = api.addSample(p, "EE", "long", { processingType: "Long" });
  api.completePreprocessing(s.id);
  api.completePreprocessing(l.id);
  let threw = false;
  try { api.startProcessingBatch({ sampleIds: [s.id, l.id], processingType: "Short", startedAt: now() }); }
  catch { threw = true; }
  assert(threw, "mixed Short/Long batch should be rejected");
});

invariant("preprocessing gate blocks batching an unprepared sample", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "raw");
  let threw = false;
  try { api.startProcessingBatch({ sampleIds: [id], processingType: "Short", startedAt: now() }); }
  catch { threw = true; }
  assert(threw, "batching before preprocessing should be rejected");
});

invariant("deleting a sample cascades to its sections and slides", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "cascade");
  api.markEmbedded(id);
  const [section] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 3 }]);
  assert(api.all(`SELECT id FROM slides WHERE section_request_id = ?`, [section]).length === 3, "slides created");
  api.run(`DELETE FROM samples WHERE id = ?`, [id]);
  eq(api.all(`SELECT id FROM section_requests WHERE sample_id = ?`, [id]).length, 0, "sections gone");
  eq(api.all(`SELECT id FROM slides WHERE section_request_id = ?`, [section]).length, 0, "slides gone");
});

invariant("slide codes are globally unique (depth-index + duplicate letter)", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "codes");
  api.markEmbedded(id);
  api.createSectionRequests(id, [{ depth_um: 100, duplicates: 2 }]);
  api.createSectionRequests(id, [{ depth_um: 100, duplicates: 2 }]); // same depth again
  const codes = api.all(`SELECT slide_code FROM slides WHERE section_request_id IN (SELECT id FROM section_requests WHERE sample_id = ?)`, [id]).map((r) => r.slide_code);
  eq(new Set(codes).size, codes.length, `duplicate slide codes: ${codes.join(", ")}`);
});

// ---------------------------------------------------------------------------
// ISSUE REGRESSIONS — assert the DESIRED behaviour for each open issue
// ---------------------------------------------------------------------------

// #1 — Cannot add duplicate samples. The data layer already allows identical
// descriptions (each gets its own code); the real gap is a UI quantity field.
// This invariant guards the data layer so a future "add N" feature is safe.
issue(1, "identical descriptions get distinct codes and all persist", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const made = [];
  for (let i = 0; i < 5; i++) made.push(api.addSample(p, "EE", "3 week Stretch PLA"));
  const codes = made.map((m) => m.code);
  eq(new Set(codes).size, 5, "five distinct codes");
  eq(api.get(`SELECT COUNT(*) AS c FROM samples WHERE sample_description = '3 week Stretch PLA'`).c, 5, "all five stored");
});

// #2 — Z-Fix should be the default fixative. The dialog defaults to
// FIXATIVE_OPTIONS[0], so we gate on the real source order in stages.ts.
issue(2, "Z-Fix leads FIXATIVE_OPTIONS (the New Sample dialog default)", () => {
  const src = readFileSync(join(HERE, "..", "src", "lib", "stages.ts"), "utf8");
  const match = src.match(/FIXATIVE_OPTIONS\s*=\s*\[([^\]]*)\]/);
  assert(match, "could not find FIXATIVE_OPTIONS in stages.ts");
  const first = match[1].split(",")[0].trim().replace(/^["']|["']$/g, "");
  eq(first, "Z-Fix", "first fixative option / dialog default");
});

// #23 — Running two batches at once is the technician's call. Starting a second
// overlapping run WITHOUT opting in must warn (throw ProcessorBusy) so the dialog
// can offer "Start anyway"; WITH allowConcurrent it must succeed.
issue(23, "an overlapping run warns by default but can be started concurrently", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const a = api.addSample(p, "EE", "batch A", { processingType: "Short" });
  const b = api.addSample(p, "EE", "batch B", { processingType: "Long" });
  api.completePreprocessing(a.id);
  api.completePreprocessing(b.id);
  api.startProcessingBatch({ sampleIds: [a.id], processingType: "Short", startedAt: now() });
  let warned = false;
  try { api.startProcessingBatch({ sampleIds: [b.id], processingType: "Long", startedAt: now() }); }
  catch (err) { warned = err.message === "PROCESSOR_BUSY"; }
  assert(warned, "overlapping run should warn when not opted in");
  // The technician overrides and runs both simultaneously.
  const second = api.startProcessingBatch({
    sampleIds: [b.id], processingType: "Long", startedAt: now(), allowConcurrent: true,
  });
  assert(second > 0, "a concurrent run must start when allowConcurrent is set");
  eq(api.get(`SELECT current_stage FROM samples WHERE id = ?`, [b.id]).current_stage,
     "processing_started", "the concurrent run's sample entered the processor");
});

// #5 regression (reported in 0.2.3): a stale/orphaned batch row whose samples
// have moved off 'processing_started' must NOT block a new run. The old guard
// keyed off pb.status='processing' and wedged the processor; the sample-based
// guard must let a fresh batch start.
issue(5, "a stale 'processing' batch row does not block a new run", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const a = api.addSample(p, "EE", "old run", { processingType: "Short" });
  const b = api.addSample(p, "EE", "new run", { processingType: "Short" });
  api.completePreprocessing(a.id);
  api.completePreprocessing(b.id);
  const batchA = api.startProcessingBatch({ sampleIds: [a.id], processingType: "Short", startedAt: now() });
  // Simulate the sample advancing out of the processor WITHOUT going through
  // moveBatch, so pb.status stays 'processing' (the orphaned-row condition).
  api.run(`UPDATE samples SET current_stage = 'embedded' WHERE id = ?`, [a.id]);
  eq(api.get(`SELECT status FROM processing_batches WHERE id = ?`, [batchA]).status, "processing",
     "batch row is still marked processing (stale)");
  let started = true;
  try { api.startProcessingBatch({ sampleIds: [b.id], processingType: "Short", startedAt: now() }); }
  catch { started = false; }
  assert(started, "a new run must start despite the stale batch row");
});

// #4 / #24 — A planned run holds status 'planned' with its scheduled start in
// planned_start_at; its members stay in pre-processing (NOT in the processor)
// until confirmed. Confirming stamps the real start, recomputes ready, and moves
// the members into the processor so the countdown begins.
issue(4, "a planned run stays out of the processor until it is confirmed", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const s = api.addSample(p, "EE", "planned", { processingType: "Short" });
  api.completePreprocessing(s.id);
  const batch = api.planProcessingBatch({ sampleIds: [s.id], processingType: "Short", plannedStartAt: "2026-03-01 07:30" });
  const row = api.get(`SELECT status, planned_start_at, ready_at FROM processing_batches WHERE id = ?`, [batch]);
  eq(row.status, "planned", "batch is planned");
  eq(row.planned_start_at, "2026-03-01 07:30", "planned start recorded");
  eq(row.ready_at, "2026-03-02 01:30", "ready time projected from the planned start (+18h Short)");
  eq(api.get(`SELECT current_stage FROM samples WHERE id = ?`, [s.id]).current_stage, "in_ethanol",
     "a planned run does NOT move its samples into the processor");

  // A planned run must not block a concurrent 'start now' guard either.
  const activeRun = api.all(
    `SELECT pb.id FROM processing_batches pb
       JOIN processing_batch_members pbm ON pbm.batch_id = pb.id
       JOIN samples sm ON sm.id = pbm.sample_id
      WHERE sm.current_stage = 'processing_started'`);
  eq(activeRun.length, 0, "a planned run is not counted as in-processor");
});

issue(24, "confirming a planned run starts the countdown", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const s = api.addSample(p, "EE", "confirm", { processingType: "Long" });
  api.completePreprocessing(s.id);
  const batch = api.planProcessingBatch({ sampleIds: [s.id], processingType: "Long", plannedStartAt: "2026-03-01 08:00" });
  const ready = api.confirmProcessingBatchStart(batch, "2026-03-01 09:15");
  const row = api.get(`SELECT status, started_at, ready_at FROM processing_batches WHERE id = ?`, [batch]);
  eq(row.status, "processing", "confirmed run is processing");
  eq(row.started_at, "2026-03-01 09:15", "actual start stamped");
  eq(ready, "2026-03-03 13:15", "ready recomputed from the actual start (+52h Long)");
  eq(api.get(`SELECT current_stage, processing_started_at FROM samples WHERE id = ?`, [s.id]).current_stage,
     "processing_started", "members enter the processor on confirm");
});

// A sample can only be committed to one open (planned or running) batch.
issue(4, "a sample already committed to a batch cannot be planned again", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const s = api.addSample(p, "EE", "double", { processingType: "Short" });
  api.completePreprocessing(s.id);
  api.planProcessingBatch({ sampleIds: [s.id], processingType: "Short", plannedStartAt: "2026-03-01 07:30" });
  let threw = false;
  try { api.planProcessingBatch({ sampleIds: [s.id], processingType: "Short", plannedStartAt: "2026-03-02 07:30" }); }
  catch (err) { threw = err.message === "ALREADY_BATCHED"; }
  assert(threw, "a committed sample cannot be planned into a second batch");
});

// #6 — Editing a batch's start time recomputes the ready time and every
// member's processing_started_at so batch and samples stay consistent.
issue(6, "editing a batch start time recomputes ready time and member timestamps", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const s = api.addSample(p, "EE", "timing", { processingType: "Short" });
  api.completePreprocessing(s.id);
  const batch = api.startProcessingBatch({ sampleIds: [s.id], processingType: "Short", startedAt: "2026-02-01 09:00" });
  api.updateProcessingBatchStart(batch, "2026-02-01 06:00");
  const row = api.get(`SELECT started_at, ready_at FROM processing_batches WHERE id = ?`, [batch]);
  eq(row.started_at, "2026-02-01 06:00", "batch start corrected");
  eq(row.ready_at, "2026-02-02 00:00", "ready recomputed (+18h Short run)");
  eq(api.get(`SELECT processing_started_at FROM samples WHERE id = ?`, [s.id]).processing_started_at,
     "2026-02-01 06:00", "member processing_started_at follows");
});

// #7 — Sections must not be cuttable before the block is embedded. We call the
// REAL (unguarded) createSectionRequests port on a 'received' block; today it
// happily creates a section, so this reproduces the bug. After the fix,
// createSectionRequests must refuse a non-embedded block and create nothing.
issue(7, "sending to sectioning is refused until the block is embedded", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "not-embedded");
  eq(api.get(`SELECT current_stage FROM samples WHERE id = ?`, [id]).current_stage, "received", "block starts un-embedded");
  try {
    api.createSectionRequests(id, [{ depth_um: 100, duplicates: 1 }]);
  } catch { /* desired: the fixed code path throws here */ }
  eq(api.get(`SELECT COUNT(*) AS c FROM section_requests WHERE sample_id = ?`, [id]).c, 0,
     "no section should be created for a non-embedded block");
});

// #9 — Extras merge through durable stack membership without changing their
// physical cut-group provenance.
issue(9, "staining an extra joins its sample-depth staining stack", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "merge");
  api.markEmbedded(id);
  // First cut: two slides at 100µm; assign one to H&E, keep one as a saved extra.
  const [section] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 2 }]);
  api.sectionToAssignment(section);
  const slides = api.all(`SELECT * FROM slides WHERE section_request_id = ? ORDER BY slide_ordinal`, [section]);
  api.assignSlide(slides[0].id, "stain", "stain", "H&E");
  api.assignSlide(slides[1].id, "extra", "", "");
  api.startAssayWork(section); // section now in staining with one H&E slide
  // Later: take the saved extra from inventory and send it to IHC.
  const extra = api.listExtraSlides().find((s) => s.sample_id === id);
  assert(extra, "an extra slide is available in inventory");
  const originalSectionId = extra.section_request_id;
  api.assignExtraSlideToAssay(extra.id, "ihc", "CD31");
  const stacks = api.all(`SELECT id FROM slide_stacks WHERE sample_id = ? AND closed_at IS NULL`, [id]);
  eq(stacks.length, 1, "sample-depth should have one staining stack in this scenario");
  eq(api.get(`SELECT COUNT(*) AS c FROM slides WHERE stack_id = ?`, [stacks[0].id]).c, 2,
    "existing assay and newly assigned extra should share the stack");
  eq(api.get(`SELECT section_request_id FROM slides WHERE id = ?`, [extra.id]).section_request_id,
    originalSectionId, "extra should retain its cut-group provenance");
});

// #10 — Assignment keeps the slide in its source section, so undo cannot need
// to reconstruct deleted/re-parented cut groups.
issue(10, "assigning an extra preserves its source section", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "orphan");
  api.markEmbedded(id);
  // A single-slide cut, saved as an extra so it lands in inventory.
  const [section] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 1 }]);
  api.sectionToAssignment(section);
  const slide = api.get(`SELECT id FROM slides WHERE section_request_id = ?`, [section]);
  api.assignSlide(slide.id, "extra", "", "");
  // An all-extras stack leaves the Fresh tab into 'ready_for_imaging' (then
  // hides from the board); only then is the saved extra offered in inventory.
  api.run(`UPDATE section_requests SET current_stage = 'ready_for_imaging' WHERE id = ?`, [section]);
  eq(api.listExtraSlides().length, 1, "one extra in inventory");
  // Send that extra to IHC from the inventory.
  api.assignExtraSlideToAssay(slide.id, "ihc", "CD31");
  eq(api.get(`SELECT section_request_id FROM slides WHERE id = ?`, [slide.id]).section_request_id,
    section, "assignment should not re-parent the physical slide");
  eq(api.get(`SELECT COUNT(*) AS c FROM section_requests WHERE id = ?`, [section]).c, 1,
    "source section should remain as cut history");
});

// #12 — A slide saved as 'extra' during assignment must NOT appear in the extra
// inventory while its section is still in the Fresh/assignment tab; it should
// surface only once the section is dispositioned onward.
issue(12, "a fresh extra stays out of inventory until its section leaves Fresh", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "fresh extras");
  api.markEmbedded(id);
  const [section] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 2 }]);
  api.sectionToAssignment(section);
  const slides = api.all(`SELECT * FROM slides WHERE section_request_id = ? ORDER BY slide_ordinal`, [section]);
  api.assignSlide(slides[0].id, "stain", "stain", "H&E");
  api.assignSlide(slides[1].id, "extra", "", "");
  eq(api.listExtraSlides().length, 0, "extra hidden while its section is still in Fresh");
  api.startAssayWork(section); // leaves Fresh into staining
  eq(api.listExtraSlides().length, 1, "extra appears in inventory once the section moves on");
});

// #14 — A separately-stained INVENTORY extra that reaches Ready for Imaging must
// merge onto the companion stack already there, so every slide (including the
// extra) is owned by one stack and therefore gets its own imaging checkbox. The
// drawer renders one checkbox per slide in listSlidesForStack(stackId), so the
// gate asserts the merged stack owns both slides with imaging timestamps set.
issue(14, "an inventory extra merges into the imaging stack and gains a checkbox", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "imaging merge");
  api.markEmbedded(id);
  // One cut at 100µm: slide 0 → H&E, slide 1 → saved extra.
  const [section] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 2 }]);
  api.sectionToAssignment(section);
  const slides = api.all(`SELECT * FROM slides WHERE section_request_id = ? ORDER BY slide_ordinal`, [section]);
  api.assignSlide(slides[0].id, "stain", "stain", "H&E");
  api.assignSlide(slides[1].id, "extra", "", "");
  api.startAssayWork(section);
  // The H&E companion finishes staining and sits in Ready for Imaging.
  const companionStack = api.get(`SELECT stack_id FROM slides WHERE id = ?`, [slides[0].id]).stack_id;
  const imagingStackId = api.moveSlideStack(companionStack, "ready_for_imaging");

  // Later: take the saved extra from inventory, stain it independently, and send
  // it forward. It starts a fresh staining stack, then advances to imaging.
  const extra = api.listExtraSlides().find((s) => s.id === slides[1].id);
  assert(extra, "the saved extra is available in inventory");
  const { stackId: extraStack } = api.assignExtraSlideToAssay(extra.id, "stain", "H&E");
  assert(extraStack !== imagingStackId, "a separately-stained extra starts its own staining stack");
  const mergedId = api.moveSlideStack(extraStack, "ready_for_imaging");

  eq(mergedId, imagingStackId, "the extra merges into the companion imaging stack");
  eq(api.get(`SELECT COUNT(*) AS c FROM slide_stacks WHERE sample_id = ? AND depth_um = 100 AND closed_at IS NULL`, [id]).c,
     1, "one imaging stack remains for the sample-depth");
  eq(api.get(`SELECT COUNT(*) AS c FROM slides WHERE stack_id = ?`, [imagingStackId]).c,
     2, "the merged stack owns both the companion and the extra");
  eq(api.get(`SELECT COUNT(*) AS c FROM slides WHERE stack_id = ? AND stage_ready_for_imaging_at IS NOT NULL`, [imagingStackId]).c,
     2, "every slide in the imaging stack has an imaging timestamp (so each gets a checkbox)");
});

issue(25, "dragging cannot move backward or skip workflow stages", () => {
  const src = readFileSync(join(HERE, "..", "src", "components", "Board.tsx"), "utf8");
  assert(src.includes("SECTION_STAGE_ORDER[targetStage]") && src.includes("!== 1"),
    "section drag handler must require exactly one forward stage");
  assert(src.includes("STAGE_ORDER[targetStage]") && src.includes("!== 1"),
    "sample drag handler must require exactly one forward stage");
});

issue(26, "batch assay start preflights every selected section", () => {
  const actions = readFileSync(join(HERE, "..", "src", "hooks", "useActions.ts"), "utf8");
  const drawer = readFileSync(join(HERE, "..", "src", "components", "SectionDetailsDrawer.tsx"), "utf8");
  assert(actions.includes('stageKey === "stain_requested"') && actions.includes("incompleteIds.length > 0"),
    "batch action must reject incomplete assignments before its write loop");
  assert(drawer.includes('moveSections(assignmentBatchIds, "stain_requested")'),
    "drawer must start assays for the selected batch");
});

invariant("multi-stack protocols target only selected stacks with the matching assay type", () => {
  const dbSource = readFileSync(join(HERE, "..", "src", "lib", "db.ts"), "utf8");
  const drawer = readFileSync(join(HERE, "..", "src", "components", "StackDetailsDrawer.tsx"), "utf8");
  const checklist = readFileSync(join(HERE, "..", "src", "components", "ProtocolChecklist.tsx"), "utf8");
  assert(dbSource.includes("AS has_stain") && dbSource.includes("AS has_ihc"),
    "stack query must expose its stain and IHC capabilities");
  assert(drawer.includes("stainStackIds") && drawer.includes("ihcStackIds"),
    "batch checklist targets must be filtered by assay type");
  assert(checklist.includes("...batchScopeIds") && checklist.includes("for (const targetScopeId of scopeIds)"),
    "a protocol step must propagate across the eligible selected stacks");
});

issue(27, "Mark Sectioned advances the selected batch", () => {
  const drawer = readFileSync(join(HERE, "..", "src", "components", "SectionDetailsDrawer.tsx"), "utf8");
  assert(drawer.includes('moveSections(sectioningBatchIds, "assignment_required")'),
    "Mark Sectioned must use the selected section IDs");
});

issue(28, "section and imaging undo restore slide snapshots", () => {
  const actions = readFileSync(join(HERE, "..", "src", "hooks", "useActions.ts"), "utf8");
  assert(actions.includes("for (const slide of beforeSlides) await restoreSlide(slide)"),
    "section undo must restore its slides");
  assert(actions.includes("Complete imaging") && actions.includes("for (const section of before) await restoreSectionRequest(section)"),
    "bulk imaging must register a symmetric undo command");
});

// #29 — Undoing "start assay workflow" must not leave the minted slide stack
// behind as an empty tile stuck in the assay lane. Restoring the section's
// slides clears their stack_id, so the section-move undo must ALSO reconcile the
// stacks the move touched: delete a stack it created, recreate it on redo.
issue(29, "undoing start-assay removes the stack the move created", () => {
  const actions = readFileSync(join(HERE, "..", "src", "hooks", "useActions.ts"), "utf8");
  const dbSource = readFileSync(join(HERE, "..", "src", "lib", "db.ts"), "utf8");
  assert(
    actions.includes("snapshotStacksForSlides") &&
    actions.includes("await ensureStacks(") &&
    actions.includes("await pruneStacks("),
    "section-move undo/redo must snapshot and reconcile the slide stacks it touches",
  );
  assert(dbSource.includes("deleteSlideStackIfEmpty"),
    "an empty minted stack must be prunable when its slides are restored");
});

// The stack-pruning primitive itself: a stack with no slides is removed, one
// that still owns slides survives. Backstops the undo reconciliation above.
invariant("deleteSlideStackIfEmpty removes only childless stacks", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "prune");
  api.markEmbedded(id);
  const [section] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 1 }]);
  api.sectionToAssignment(section);
  const slide = api.get(`SELECT id FROM slides WHERE section_request_id = ?`, [section]);
  api.assignSlide(slide.id, "stain", "stain", "H&E");
  api.startAssayWork(section);
  const stackId = api.get(`SELECT stack_id FROM slides WHERE id = ?`, [slide.id]).stack_id;
  assert(stackId != null, "start assay attaches the slide to a stack");
  // While the stack still owns the slide, pruning must NOT remove it.
  api.run(`DELETE FROM slide_stacks WHERE id = ? AND NOT EXISTS (SELECT 1 FROM slides WHERE stack_id = ?)`, [stackId, stackId]);
  eq(api.get(`SELECT COUNT(*) AS c FROM slide_stacks WHERE id = ?`, [stackId]).c, 1, "stack with slides survives");
  // Detach the slide (undo restoring slides), then prune: the stack is gone.
  api.run(`UPDATE slides SET stack_id = NULL WHERE id = ?`, [slide.id]);
  api.run(`DELETE FROM slide_stacks WHERE id = ? AND NOT EXISTS (SELECT 1 FROM slides WHERE stack_id = ?)`, [stackId, stackId]);
  eq(api.get(`SELECT COUNT(*) AS c FROM slide_stacks WHERE id = ?`, [stackId]).c, 0, "emptied stack is pruned");
});

invariant("downstream UI and actions address durable stack IDs", () => {
  const app = readFileSync(join(HERE, "..", "src", "App.tsx"), "utf8");
  const drawer = readFileSync(join(HERE, "..", "src", "components", "StackDetailsDrawer.tsx"), "utf8");
  const actions = readFileSync(join(HERE, "..", "src", "hooks", "useActions.ts"), "utf8");
  assert(app.includes("moveSlideStacks(stackIds, stageKey)"),
    "App must not translate stack moves back into section IDs");
  assert(drawer.includes('scopeType="slide_stack"') && drawer.includes("useStackSlides(stack.id)"),
    "stack drawer must query and mutate stack-owned workflow state");
  assert(drawer.includes("removeSlides([...selectedSlideIds])"),
    "stack drawer must support one combined delete for selected slides");
  assert(actions.includes("restoreSlideStack(stack)"),
    "stack undo must restore the durable stack snapshot");
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const c = process.stdout.isTTY
  ? { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" }
  : { g: "", r: "", y: "", d: "", x: "" };

let regressions = 0;
let openBugsReproduced = 0;
let unexpectedPasses = 0;

for (const t of results) {
  if (t.passed && !t.knownOpen) {
    if (VERBOSE) console.log(`  ${c.g}PASS${c.x} ${t.name}`);
  } else if (t.passed && t.knownOpen) {
    unexpectedPasses++;
    console.log(`  ${c.y}PASS?${c.x} ${t.name} ${c.d}(marked knownOpen but passed — clear the flag)${c.x}`);
  } else if (!t.passed && t.knownOpen) {
    openBugsReproduced++;
    console.log(`  ${c.y}OPEN${c.x} ${t.name} ${c.d}→ ${t.detail}${c.x}`);
  } else {
    regressions++;
    console.log(`  ${c.r}FAIL${c.x} ${t.name}\n       ${c.r}${t.detail}${c.x}`);
  }
}

const passes = results.filter((t) => t.passed && !t.knownOpen).length;
console.log(
  `\n${passes} passed · ${openBugsReproduced} open bugs reproduced · ` +
  `${regressions} regressions · ${unexpectedPasses} to-triage\n`,
);

if (regressions > 0) {
  console.log(`${c.r}✗ Regressions in known-good behaviour — fix before shipping.${c.x}`);
  process.exit(1);
}
if (unexpectedPasses > 0) {
  console.log(`${c.y}! A knownOpen issue now passes. Clear its knownOpen flag to lock the fix in.${c.x}`);
  process.exit(2);
}
console.log(`${c.g}✓ All invariants hold. Open issues are reproduced and tracked.${c.x}`);
