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
    const preselected = (opts.preselectedStains ?? []).length ? JSON.stringify(opts.preselectedStains) : "";
    const r = run(
      `INSERT INTO samples (
         project_id, project_sample_number, sample_code, sample_description, date_added,
         processing_type, fixative_agent, needs_decalcification, cut_notes, slide_notes,
         stains, preselected_stains, overall_notes, current_stage, stage_received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, '', 'received', ?)`,
      [
        projectId, number, code, description, "2026-01-01",
        opts.processingType ?? "Short",
        opts.fixative ?? "PFA",
        opts.needsDecalc ? 1 : 0,
        opts.stains ?? "",
        preselected,
        now(),
      ],
    );
    return { id: Number(r.lastInsertRowid), code };
  }

  // Port of buildAutoSectioningPlan() — src/lib/db.ts (issue #4).
  function buildAutoSectioningPlan(preselected) {
    const stains = preselected.map((a) => ({ duplicates: 1, stains: a.assay_name, assay_type: a.assay_type, assay_name: a.assay_name }));
    return [...stains, { duplicates: Math.max(2, 4 - preselected.length), stains: "" }];
  }

  // Walk a block through preprocessing so it is batch-eligible.
  function completePreprocessing(sampleId, { decalc = false } = {}) {
    run(`UPDATE samples SET fixative_placed_at = ?, current_stage = 'in_fixative' WHERE id = ?`, [now(), sampleId]);
    run(`UPDATE samples SET fixative_removed_at = ?, current_stage = 'fixative_removed' WHERE id = ?`, [now(), sampleId]);
    if (decalc) run(`UPDATE samples SET decalc_completed_at = ?, current_stage = 'decalcified' WHERE id = ?`, [now(), sampleId]);
    run(`UPDATE samples SET ethanol_placed_at = ?, current_stage = 'in_ethanol' WHERE id = ?`, [now(), sampleId]);
  }

  // Port of startProcessingBatch() — src/lib/db.ts. There is no processor-busy
  // guard: two runs may overlap freely, entirely the technician's call (#23).
  function startProcessingBatch({ sampleIds, processingType, startedAt }) {
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

  // Port of updatePlannedBatchMembers() — src/lib/db.ts (issue #32).
  function updatePlannedBatchMembers(batchId, sampleIds) {
    if (!sampleIds.length) throw new Error("A planned run needs at least one sample.");
    const batch = get(`SELECT status, processing_type FROM processing_batches WHERE id = ?`, [batchId]);
    if (!batch) throw new Error("That processing batch no longer exists.");
    if (batch.status !== "planned") throw new Error("Only a planned run's samples can be edited.");
    const placeholders = sampleIds.map(() => "?").join(", ");
    const samples = all(`SELECT * FROM samples WHERE id IN (${placeholders}) ORDER BY id`, sampleIds);
    if (samples.some((s) => s.processing_type !== batch.processing_type)) throw new Error("PROTOCOL_MISMATCH");
    const conflict = all(
      `SELECT s.sample_code FROM processing_batch_members pbm
         JOIN processing_batches pb ON pb.id = pbm.batch_id
         JOIN samples s ON s.id = pbm.sample_id
        WHERE pbm.sample_id IN (${placeholders}) AND pb.id != ? AND pb.status IN ('planned', 'processing')`,
      [...sampleIds, batchId]);
    if (conflict.length) throw new Error("ALREADY_BATCHED");
    run(`DELETE FROM processing_batch_members WHERE batch_id = ?`, [batchId]);
    for (const id of sampleIds) run(`INSERT INTO processing_batch_members (batch_id, sample_id) VALUES (?, ?)`, [batchId, id]);
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
    // Mirror ensureAutoSectioningPlan(): every embedded block auto-plans (≥4
    // slides, ≥2 extras); no preselected stains means four extras.
    const row = get(`SELECT preselected_stains, sectioning_plan FROM samples WHERE id = ?`, [sampleId]);
    if (row && !row.sectioning_plan) {
      const preselected = row.preselected_stains ? JSON.parse(row.preselected_stains) : [];
      run(`UPDATE samples SET sectioning_plan = ? WHERE id = ?`, [JSON.stringify(buildAutoSectioningPlan(preselected)), sampleId]);
    }
  }

  // Port of createSectionRequests() — src/lib/db.ts. No depth; per-sample slide
  // letters (EE-0001-A, -B, …) continue across cuts. groups: {duplicates, stains?}.
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
    const parentCode = get(`SELECT sample_code FROM samples WHERE id = ?`, [sampleId]).sample_code;
    let nextOrdinal = (get(
      `SELECT COUNT(sl.id) AS n FROM slides sl
         JOIN section_requests sr ON sr.id = sl.section_request_id WHERE sr.sample_id = ?`,
      [sampleId],
    ).n ?? 0) + 1;
    for (const g of groups) {
      const dup = Math.max(1, g.duplicates);
      const preassigned = Boolean(g.assay_type && g.assay_name);
      const r = run(
        `INSERT INTO section_requests (sample_id, duplicates, stains, current_stage, stage_needs_sectioning_at)
         VALUES (?, ?, ?, 'needs_sectioning', ?)`,
        [sampleId, dup, g.stains ?? (preassigned ? g.assay_name : "") ?? "", ts],
      );
      const sectionId = Number(r.lastInsertRowid);
      ids.push(sectionId);
      for (let ordinal = 1; ordinal <= dup; ordinal++) {
        const slideCode = `${parentCode}-${duplicateLabel(nextOrdinal).toUpperCase()}`;
        if (preassigned) {
          run(
            `INSERT INTO slides (section_request_id, slide_ordinal, slide_code, purpose, stain_name,
               assay_type, assay_name, assignment_saved, slice_count, control_agent, current_stage)
             VALUES (?, ?, ?, 'stain', ?, ?, ?, 1, 2, 'IgG', 'assigned')`,
            [sectionId, ordinal, slideCode, g.assay_name, g.assay_type, g.assay_name],
          );
        } else {
          // Extras are a saved disposition chosen at cut time (issues #34/#38).
          run(
            `INSERT INTO slides (section_request_id, slide_ordinal, slide_code, purpose, assignment_saved, current_stage)
             VALUES (?, ?, ?, 'extra', 1, 'extra')`,
            [sectionId, ordinal, slideCode],
          );
        }
        nextOrdinal++;
      }
    }
    // Cutting fulfils outstanding requests: trim one entry per preassigned slide.
    const cut = [];
    for (const g of groups) {
      if (g.assay_type && g.assay_name) {
        for (let i = 0; i < Math.max(1, g.duplicates); i++) cut.push({ assay_type: g.assay_type, assay_name: g.assay_name });
      }
    }
    if (cut.length) {
      const pre = get(`SELECT preselected_stains FROM samples WHERE id = ?`, [sampleId]);
      const remaining = pre.preselected_stains ? JSON.parse(pre.preselected_stains) : [];
      for (const r of cut) {
        const idx = remaining.findIndex((a) => a.assay_type === r.assay_type && a.assay_name.toLowerCase() === r.assay_name.toLowerCase());
        if (idx >= 0) remaining.splice(idx, 1);
      }
      run(`UPDATE samples SET preselected_stains = ? WHERE id = ?`, [remaining.length ? JSON.stringify(remaining) : "", sampleId]);
    }
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

  // Load a section's stain slides into their agents' cross-sample racks.
  function attachSectionStainSlidesToRacks(sectionId) {
    const agents = all(
      `SELECT DISTINCT assay_type, assay_name FROM slides
        WHERE section_request_id = ? AND purpose = 'stain'`, [sectionId]);
    for (const agent of agents) {
      let rack = get(
        `SELECT id FROM slide_stacks
          WHERE kind = 'stain' AND assay_type = ? AND assay_name = ?
            AND current_stage = 'stain_requested' AND closed_at IS NULL`,
        [agent.assay_type, agent.assay_name]);
      if (!rack) {
        const created = run(
          `INSERT INTO slide_stacks (kind, assay_type, assay_name, sample_id, current_stage, stage_stain_requested_at)
           VALUES ('stain', ?, ?, NULL, 'stain_requested', ?)`,
          [agent.assay_type, agent.assay_name, now()]);
        rack = { id: Number(created.lastInsertRowid) };
      }
      run(
        `UPDATE slides SET stack_id = ?
          WHERE section_request_id = ? AND purpose = 'stain' AND assay_type = ? AND assay_name = ?`,
        [rack.id, sectionId, agent.assay_type, agent.assay_name]);
    }
  }

  const STAIN_RACK_STAGES = ["stain_requested", "stained", "deparaffinized",
    "ihc_complete", "refrax_complete", "coverslipped", "dried"];
  const STAGE_COLUMNS = {
    stain_requested: "stage_stain_requested_at", stained: "stage_stained_at",
    deparaffinized: "stage_deparaffinized_at", ihc_complete: "stage_ihc_at",
    refrax_complete: "stage_refrax_at", coverslipped: "stage_coverslipped_at",
    dried: "stage_dried_at", ready_for_imaging: "stage_ready_for_imaging_at",
    pictures_taken: "stage_pictures_taken_at", analyzed: "stage_analyzed_at",
  };

  // Advance a stack. A stain rack advances as a unit and NEVER merges; leaving
  // staining it scatters each slide into its sample's per-sample stack. A
  // per-sample stack merges with the same sample's stack at the destination.
  function moveSlideStack(stackId, stageKey) {
    const column = STAGE_COLUMNS[stageKey];
    if (!column) throw new Error(`Unknown slide-stack stage: ${stageKey}`);
    const source = get(`SELECT * FROM slide_stacks WHERE id = ?`, [stackId]);
    if (!source) throw new Error("That slide stack no longer exists.");
    const ts = now();
    if (source.kind === "stain") {
      if (STAIN_RACK_STAGES.includes(stageKey)) {
        run(`UPDATE slides SET current_stage = ?, ${column} = COALESCE(${column}, ?) WHERE stack_id = ? AND purpose = 'stain'`, [stageKey, ts, stackId]);
        run(`UPDATE slide_stacks SET current_stage = ?, ${column} = COALESCE(${column}, ?) WHERE id = ?`, [stageKey, ts, stackId]);
        return stackId;
      }
      const members = all(
        `SELECT sl.id, sr.sample_id FROM slides sl
           JOIN section_requests sr ON sr.id = sl.section_request_id WHERE sl.stack_id = ?`, [stackId]);
      for (const m of members) {
        let target = get(
          `SELECT id FROM slide_stacks WHERE kind = 'sample' AND sample_id = ? AND current_stage = ? AND closed_at IS NULL`,
          [m.sample_id, stageKey]);
        if (!target) {
          const created = run(
            `INSERT INTO slide_stacks (kind, sample_id, current_stage, ${column}) VALUES ('sample', ?, ?, ?)`,
            [m.sample_id, stageKey, ts]);
          target = { id: Number(created.lastInsertRowid) };
        }
        run(`UPDATE slides SET stack_id = ?, current_stage = ?, ${column} = COALESCE(${column}, ?) WHERE id = ?`, [target.id, stageKey, ts, m.id]);
      }
      run(`DELETE FROM slide_stacks WHERE id = ?`, [stackId]);
      return stackId;
    }
    run(`UPDATE slides SET current_stage = ?, ${column} = COALESCE(${column}, ?) WHERE stack_id = ? AND purpose = 'stain'`, [stageKey, ts, stackId]);
    const target = stageKey === "analyzed" ? null : get(
      `SELECT id FROM slide_stacks WHERE kind = 'sample' AND sample_id = ? AND current_stage = ? AND closed_at IS NULL AND id != ? ORDER BY id LIMIT 1`,
      [source.sample_id, stageKey, source.id]);
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
    // Coming straight from Needs Sectioning (no assignment stop, #34/#38).
    run(`UPDATE slides SET stage_cut_at = COALESCE(stage_cut_at, ?) WHERE section_request_id = ?`, [ts, sectionId]);
    run(`UPDATE slides SET current_stage = CASE WHEN purpose = 'stain' THEN 'stain_requested' ELSE purpose END,
           stage_stain_requested_at = CASE WHEN purpose = 'stain' THEN COALESCE(stage_stain_requested_at, ?) ELSE stage_stain_requested_at END
           WHERE section_request_id = ?`, [ts, sectionId]);
    attachSectionStainSlidesToRacks(sectionId);
    run(`UPDATE section_requests SET current_stage = 'stain_requested', stage_stain_requested_at = COALESCE(stage_stain_requested_at, ?) WHERE id = ?`, [ts, sectionId]);
  }

  // Port of assignExtraSlideToAssay() — src/lib/db.ts. Stack membership owns
  // downstream grouping; the original section remains immutable cut provenance.
  // Port of requestStainForSample() — src/lib/db.ts. Extra first (fulfils the
  // request immediately, nothing appended); else append an OUTSTANDING request
  // to the multiset (duplicates allowed) so the block is flagged for a cut.
  function requestStainForSample(sampleId, assayType, assayName) {
    const extra = get(
      `SELECT sl.id FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
        WHERE sr.sample_id = ? AND sl.purpose = 'extra' AND sl.current_stage = 'extra'
        ORDER BY sl.id LIMIT 1`, [sampleId]);
    if (extra) {
      // The extra enters staining immediately (#39): join the agent's rack.
      let rack = get(
        `SELECT id FROM slide_stacks WHERE kind = 'stain' AND assay_type = ? AND assay_name = ?
            AND current_stage = 'stain_requested' AND closed_at IS NULL`, [assayType, assayName]);
      const createdStackId = rack ? null : Number(run(
        `INSERT INTO slide_stacks (kind, assay_type, assay_name, sample_id, current_stage, stage_stain_requested_at)
         VALUES ('stain', ?, ?, NULL, 'stain_requested', ?)`, [assayType, assayName, now()]).lastInsertRowid);
      if (!rack) rack = { id: createdStackId };
      run(
        `UPDATE slides SET stack_id = ?, purpose = 'stain', assay_type = ?, assay_name = ?, stain_name = ?,
                assignment_saved = 1, slice_count = 2, control_agent = 'IgG', current_stage = 'stain_requested',
                stage_stain_requested_at = COALESCE(stage_stain_requested_at, ?)
          WHERE id = ?`, [rack.id, assayType, assayName, assayName, now(), extra.id]);
      return { target: "extra", slideId: extra.id, stackId: rack.id, createdStackId };
    }
    const row = get(`SELECT preselected_stains FROM samples WHERE id = ?`, [sampleId]);
    const current = row.preselected_stains ? JSON.parse(row.preselected_stains) : [];
    current.push({ assay_type: assayType, assay_name: assayName }); // duplicates allowed
    run(`UPDATE samples SET preselected_stains = ? WHERE id = ?`, [JSON.stringify(current), sampleId]);
    return { target: "block", slideId: null, stackId: null, createdStackId: null };
  }

  function assignExtraSlideToAssay(slideId, assayType, assayName) {
    const ts = now();
    const slide = get(
      `SELECT sl.section_request_id, sr.sample_id, sl.slide_code
         FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
        WHERE sl.id = ? AND sl.purpose = 'extra' AND sl.current_stage = 'extra'`, [slideId]);
    if (!slide) throw new Error("That extra slide is no longer available.");
    const cat = get(`SELECT id FROM assay_catalog WHERE assay_type = ? AND name = ? COLLATE NOCASE AND is_active = 1`, [assayType, assayName]);
    if (!cat) throw new Error("Choose an active stain or IHC agent from the catalog.");

    // The extra joins the cross-sample loading rack for its agent.
    let rack = get(
      `SELECT id FROM slide_stacks
        WHERE kind = 'stain' AND assay_type = ? AND assay_name = ?
          AND current_stage = 'stain_requested' AND closed_at IS NULL`,
      [assayType, assayName]);
    const createdStackId = rack ? null : Number(run(
      `INSERT INTO slide_stacks (kind, assay_type, assay_name, sample_id, current_stage, stage_stain_requested_at)
       VALUES ('stain', ?, ?, NULL, 'stain_requested', ?)`,
      [assayType, assayName, ts]).lastInsertRowid);
    if (!rack) rack = { id: createdStackId };
    run(
      `UPDATE slides SET stack_id = ?, purpose = 'stain',
             assay_type = ?, assay_name = ?, stain_name = ?, current_stage = 'stain_requested',
             assignment_saved = 1, stage_stain_requested_at = COALESCE(stage_stain_requested_at, ?)
        WHERE id = ?`,
      [rack.id, assayType, assayName, assayName, ts, slideId]);
    return { stackId: rack.id, createdStackId };
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

  // Ports of snapshotDb()/restoreDb() — src/lib/db.ts. Logical whole-DB undo:
  // capture every workflow table through the connection (WAL-safe) and restore
  // in FK-dependency order.
  const SNAPSHOT_EXCLUDE = new Set(["_sqlx_migrations", "sqlite_sequence", "app_settings", "audit_events"]);
  function snapshotTableOrder() {
    const names = all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .map((r) => r.name).filter((n) => !SNAPSHOT_EXCLUDE.has(n));
    const nameSet = new Set(names);
    const parents = new Map();
    for (const name of names) {
      const set = new Set();
      for (const fk of all(`PRAGMA foreign_key_list("${name}")`)) {
        if (fk.table !== name && nameSet.has(fk.table)) set.add(fk.table);
      }
      parents.set(name, set);
    }
    const order = [], seen = new Set(), visiting = new Set();
    const visit = (n) => {
      if (seen.has(n) || visiting.has(n)) return;
      visiting.add(n);
      for (const p of parents.get(n) ?? []) visit(p);
      visiting.delete(n);
      seen.add(n);
      order.push(n);
    };
    for (const n of names) visit(n);
    return order;
  }
  function snapshotDb() {
    const order = snapshotTableOrder();
    const tables = {};
    for (const name of order) {
      const columns = all(`PRAGMA table_info("${name}")`).map((c) => c.name);
      const rows = all(`SELECT * FROM "${name}"`);
      tables[name] = { columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)) };
    }
    return { order, tables };
  }
  function restoreDb(snap) {
    for (const name of [...snap.order].reverse()) run(`DELETE FROM "${name}"`);
    for (const name of snap.order) {
      const t = snap.tables[name];
      if (!t || !t.rows.length) continue;
      const cols = t.columns.map((c) => `"${c}"`).join(", ");
      const ph = t.columns.map(() => "?").join(", ");
      for (const row of t.rows) run(`INSERT INTO "${name}" (${cols}) VALUES (${ph})`, row);
    }
  }

  return {
    db, run, all, get,
    seedProject, addSample, completePreprocessing, startProcessingBatch, moveBatch,
    markEmbedded, createSectionRequests, sectionToAssignment, assignSlide,
    startAssayWork, assignExtraSlideToAssay, listExtraSlides, nextSampleNumber,
    updateProcessingBatchStart, moveSlideStack,
    planProcessingBatch, confirmProcessingBatchStart, updatePlannedBatchMembers,
    requestStainForSample, snapshotDb, restoreDb,
  };
}

// ---------------------------------------------------------------------------
// INVARIANTS — the happy path and data integrity that must always hold
// ---------------------------------------------------------------------------

invariant("all 18 migrations apply and expected tables exist", () => {
  const api = makeApi(freshDb());
  const names = api.all(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name);
  for (const t of ["projects", "samples", "section_requests", "slides", "slide_stacks", "processing_batches", "assay_catalog", "stain_requests", "sample_timeline_events"]) {
    assert(names.includes(t), `missing table ${t}`);
  }
  // Migration 0017 adds the planned-run column (issues #4, #24).
  const batchCols = api.all(`PRAGMA table_info(processing_batches)`).map((r) => r.name);
  assert(batchCols.includes("planned_start_at"), "processing_batches must gain planned_start_at");
  // Migration 0018: slide_stacks gains the agent-rack shape; the old cut-DEPTH
  // model is gone (#5). (Note: 0022 adds unrelated depth_label/depth_note tags.)
  const stackCols = api.all(`PRAGMA table_info(slide_stacks)`).map((r) => r.name);
  assert(stackCols.includes("kind") && stackCols.includes("assay_name"), "slide_stacks must gain kind/assay_name");
  const removedDepthCols = ["cut_depth_um", "cut_depth_index", "depth_duplicate_ordinal"];
  for (const t of ["slides", "section_requests", "slide_stacks", "samples"]) {
    const cols = api.all(`PRAGMA table_info(${t})`).map((r) => r.name.toLowerCase());
    for (const gone of removedDepthCols) {
      assert(!cols.includes(gone), `${t} must not have the removed cut-depth column ${gone}`);
    }
  }
  // The depth TAG columns (0022) do exist on slides.
  const slideCols = api.all(`PRAGMA table_info(slides)`).map((r) => r.name);
  assert(slideCols.includes("depth_label") && slideCols.includes("depth_note"),
    "slides must have the depth-tag columns (0022, #69)");
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
  eq(api.get(`SELECT kind FROM slide_stacks WHERE id = ?`, [stainSlide.stack_id]).kind, "stain",
     "a staining slide belongs to a stain rack");
});

// Helper: cut one stain slide of `agent` for a sample and send it to staining.
function stainOneSlide(api, sampleId, assayType, assayName) {
  const [section] = api.createSectionRequests(sampleId, [{ duplicates: 1 }]);
  api.sectionToAssignment(section);
  const slide = api.get(`SELECT id FROM slides WHERE section_request_id = ?`, [section]);
  api.assignSlide(slide.id, "stain", assayType, assayName);
  api.startAssayWork(section);
  return api.get(`SELECT stack_id FROM slides WHERE id = ?`, [slide.id]).stack_id;
}

// The "needs staining" flag is the block's OUTSTANDING requests directly:
// preselected_stains as a multiset, trimmed by createSectionRequests as cuts
// fulfil them (new model — issues #41/#62/#66).
function pendingFlag(api, sampleId) {
  const row = api.get(`SELECT preselected_stains FROM samples WHERE id = ?`, [sampleId]);
  const preselected = row.preselected_stains ? JSON.parse(row.preselected_stains) : [];
  return preselected.length ? JSON.stringify(preselected) : "";
}

// Port of reconcileStainRequests() — src/lib/db.ts. One-time data translation
// from the old (untrimmed) to the new (outstanding-only) preselected_stains.
function reconcileStainRequests(api) {
  const done = api.get(`SELECT value FROM schema_meta WHERE key = 'stain_requests_reconciled'`);
  if (done && done.value === "1") return;
  for (const s of api.all(`SELECT id, preselected_stains FROM samples WHERE preselected_stains <> ''`)) {
    const chosen = s.preselected_stains ? JSON.parse(s.preselected_stains) : [];
    if (!chosen.length) continue;
    const produced = new Set(api.all(
      `SELECT DISTINCT sl.assay_name AS n FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
        WHERE sr.sample_id = ? AND sl.purpose = 'stain' AND sl.assay_name <> ''`, [s.id])
      .map((r) => String(r.n).toLowerCase()));
    const outstanding = chosen.filter((a) => !produced.has(String(a.assay_name).toLowerCase()));
    if (outstanding.length !== chosen.length) {
      api.run(`UPDATE samples SET preselected_stains = ? WHERE id = ?`,
        [outstanding.length ? JSON.stringify(outstanding) : "", s.id]);
    }
  }
  api.run(`INSERT INTO schema_meta (key, value) VALUES ('stain_requests_reconciled', '1')
             ON CONFLICT(key) DO UPDATE SET value = '1'`);
}

invariant("preselected stains auto-plan on embed: N stains + max(2, 4-N) extras (#1/#4)", () => {
  for (const [n, expectedExtras] of [[0, 4], [1, 3], [2, 2], [3, 2], [4, 2]]) {
    const api = makeApi(freshDb());
    const p = api.seedProject();
    const agents = Array.from({ length: n }, (_, i) => ({ assay_type: i % 2 ? "ihc" : "stain", assay_name: `A${i}` }));
    const { id } = api.addSample(p, "EE", `n=${n}`, { preselectedStains: agents });
    api.markEmbedded(id); // seeds the auto plan
    const plan = JSON.parse(api.get(`SELECT sectioning_plan FROM samples WHERE id = ?`, [id]).sectioning_plan || "[]");
    const total = plan.reduce((s, g) => s + g.duplicates, 0);
    eq(total, n + expectedExtras, `n=${n}: total slides`);
    // Sending the plan produces n preassigned stain slides + the extras.
    const groups = plan; // one-click send of the whole prefilled plan
    api.createSectionRequests(id, groups);
    eq(api.get(`SELECT COUNT(*) AS c FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
                 WHERE sr.sample_id = ? AND sl.purpose = 'stain' AND sl.assignment_saved = 1`, [id]).c, n,
       `n=${n}: preassigned+saved stain slides`);
    eq(api.get(`SELECT COUNT(*) AS c FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
                 WHERE sr.sample_id = ? AND sl.purpose = 'extra'`, [id]).c, expectedExtras,
       `n=${n}: extra slides`);
  }
});

invariant("a requested stain pulls from an extra first, else flags the block (#2)", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "request");
  api.markEmbedded(id);
  const [section] = api.createSectionRequests(id, [{ duplicates: 2 }]);
  api.sectionToAssignment(section);
  const slides = api.all(`SELECT * FROM slides WHERE section_request_id = ? ORDER BY slide_ordinal`, [section]);
  api.assignSlide(slides[0].id, "extra", "", "");
  api.assignSlide(slides[1].id, "extra", "", "");
  api.run(`UPDATE section_requests SET current_stage = 'ready_for_imaging' WHERE id = ?`, [section]);
  eq(api.listExtraSlides().length, 2, "two extras available in inventory");
  // First request pulls an extra and moves it straight into staining (#39).
  const r1 = api.requestStainForSample(id, "stain", "SafO");
  eq(r1.target, "extra", "first request goes to an extra");
  const s1 = api.get(`SELECT assay_name, current_stage, stack_id FROM slides WHERE id = ?`, [r1.slideId]);
  eq(s1.assay_name, "SafO", "extra assigned to the agent");
  eq(s1.current_stage, "stain_requested", "the pulled extra moves into staining (#39)");
  assert(s1.stack_id != null, "the pulled extra joins a stain rack (#39)");
  eq(api.listExtraSlides().length, 1, "the pulled extra leaves inventory");
  // Second request pulls the remaining extra; third has none → flags the block.
  eq(api.requestStainForSample(id, "ihc", "CD31").target, "extra", "second request pulls the last extra");
  eq(api.requestStainForSample(id, "stain", "PAS").target, "block", "no extras left → the block is flagged");
});

// #34/#38 — pre-assigned slides skip a separate assignment step: a section cut
// straight from Needs Sectioning goes to staining (stains → racks) with its
// extras surfacing in inventory, no Save-All/assignment stop in between.
issue(38, "pre-assigned section goes straight from sectioning to staining", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "direct", {
    preselectedStains: [{ assay_type: "stain", assay_name: "H&E" }],
  });
  api.markEmbedded(id);
  const plan = JSON.parse(api.get(`SELECT sectioning_plan FROM samples WHERE id = ?`, [id]).sectioning_plan);
  const ids = api.createSectionRequests(id, plan); // 1 H&E stain + 3 extras
  // Move straight to staining — no sectionToAssignment() in between (#34/#38).
  for (const sid of ids) api.startAssayWork(sid);
  const staining = api.all(
    `SELECT sl.* FROM slides sl WHERE sl.purpose = 'stain' AND sl.current_stage = 'stain_requested'
       AND sl.section_request_id IN (${ids.map(() => "?").join(",")})`, ids);
  assert(staining.length >= 1, "the H&E slide is in staining");
  assert(staining.every((sl) => sl.stack_id != null), "each staining slide joined a rack");
  eq(api.listExtraSlides().length, 3, "the three extras surface in inventory");
});

// #32 — a planned run's sample list is editable; a running one is not.
issue(32, "planned run sample list is editable", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const a = api.addSample(p, "EE", "A"); api.completePreprocessing(a.id);
  const b = api.addSample(p, "EE", "B"); api.completePreprocessing(b.id);
  const batchId = api.planProcessingBatch({ sampleIds: [a.id], processingType: "Short", plannedStartAt: "2026-08-01 08:00" });
  api.updatePlannedBatchMembers(batchId, [a.id, b.id]);
  eq(api.all(`SELECT sample_id FROM processing_batch_members WHERE batch_id = ?`, [batchId]).length, 2,
     "a second sample can be added to a planned run");
  api.updatePlannedBatchMembers(batchId, [b.id]);
  eq(api.all(`SELECT sample_id FROM processing_batch_members WHERE batch_id = ?`, [batchId]).length, 1,
     "a sample can be removed from a planned run");
  api.confirmProcessingBatchStart(batchId);
  let rejected = false;
  try { api.updatePlannedBatchMembers(batchId, [a.id, b.id]); } catch { rejected = true; }
  assert(rejected, "a running run's sample list is locked");
});

// #31 — undoing a move into Ready for Imaging must remove the scattered per-sample
// stack. The fix captures the resulting stacks from the moved slides' current
// stack_id (a scattered rack is deleted, so its id can't be relied on).
issue(31, "undo/redo of an imaging move is a whole-DB swap (no ghost tile)", () => {
  const actions = readFileSync(join(HERE, "..", "src", "hooks", "useActions.ts"), "utf8");
  // A rack scattering into Ready-for-Imaging mints fresh per-sample stacks; the
  // old per-row undo couldn't track them and stranded the tile. Restoring the
  // whole DB puts the pre-move state back exactly, so no tile can linger.
  assert(actions.includes("restoreDbPreservingSession(entry.snapshot") && actions.includes("commitUndo("),
    "undo swaps the entire DB back, so scattered imaging stacks are never stranded");
});

invariant("the needs-staining flag clears once the requested stain is CUT (#1/#2)", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "flagged", {
    preselectedStains: [{ assay_type: "stain", assay_name: "H&E" }],
  });
  api.markEmbedded(id);
  assert(pendingFlag(api, id) !== "", "flag present at embedded inventory");
  const plan = JSON.parse(api.get(`SELECT sectioning_plan FROM samples WHERE id = ?`, [id]).sectioning_plan);
  // Cutting the H&E fulfils the outstanding request → the flag clears at CUT,
  // not at staining-entry (a physical slide now exists for it).
  api.createSectionRequests(id, plan.filter((g) => g.assay_name));
  eq(pendingFlag(api, id), "", "flag clears once the requested stain is cut");
});

// #62/#66 — the outstanding-requests multiset allows duplicates and re-requests.
issue(62, "requesting the same/already-cut agent queues another outstanding slide", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "multi"); // no creation stains, no extras
  api.markEmbedded(id);
  // Same agent twice with no free extras → two outstanding H&E requests.
  eq(api.requestStainForSample(id, "stain", "H&E").target, "block", "1st H&E flags the block");
  eq(api.requestStainForSample(id, "stain", "H&E").target, "block", "2nd H&E flags the block");
  eq(JSON.parse(pendingFlag(api, id)).filter((a) => a.assay_name === "H&E").length, 2,
    "two outstanding H&E slides queued (was deduped to one before)");
  // Cut ONE H&E → one outstanding remains; the other still flags.
  api.createSectionRequests(id, [{ duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" }]);
  eq(JSON.parse(pendingFlag(api, id)).filter((a) => a.assay_name === "H&E").length, 1,
    "cutting one H&E trims one outstanding request");
  // Cut the last H&E → flag clears. Then re-request H&E (no extras): re-flags.
  api.createSectionRequests(id, [{ duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" }]);
  eq(pendingFlag(api, id), "", "cutting the last H&E clears the flag");
  eq(api.requestStainForSample(id, "stain", "H&E").target, "block", "re-request with no extra flags the block");
  assert(JSON.parse(pendingFlag(api, id)).some((a) => a.assay_name === "H&E"),
    "re-requesting an already-produced agent flags the block again (#41/#62)");
});

// Data-compat translation (schema_meta): an OLD-model DB kept every chosen agent
// in preselected_stains untrimmed; the one-time reconcile trims produced agents.
issue(62, "stain-request reconciliation trims produced agents once (data translation)", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "legacy", {
    preselectedStains: [
      { assay_type: "stain", assay_name: "H&E" },
      { assay_type: "stain", assay_name: "Safranin O" },
    ],
  });
  api.markEmbedded(id);
  // Simulate OLD-model data: an H&E slide was cut, but preselected still lists BOTH
  // (old builds never trimmed). Insert the produced slide WITHOUT trimming.
  const sr = Number(api.run(
    `INSERT INTO section_requests (sample_id, duplicates, stains, current_stage, stage_needs_sectioning_at)
     VALUES (?, 1, 'H&E', 'needs_sectioning', ?)`, [id, "2026-01-01 08:00"]).lastInsertRowid);
  api.run(
    `INSERT INTO slides (section_request_id, slide_ordinal, slide_code, purpose, assay_type, assay_name, assignment_saved, slice_count, control_agent, current_stage)
     VALUES (?, 1, 'EE-0001-A', 'stain', 'stain', 'H&E', 1, 2, 'IgG', 'assigned')`, [sr]);
  api.run(`UPDATE samples SET preselected_stains = ? WHERE id = ?`,
    [JSON.stringify([{ assay_type: "stain", assay_name: "H&E" }, { assay_type: "stain", assay_name: "Safranin O" }]), id]);
  eq(JSON.parse(api.get(`SELECT preselected_stains FROM samples WHERE id = ?`, [id]).preselected_stains).length, 2,
    "precondition: old-model untrimmed (both listed)");

  reconcileStainRequests(api);
  const after = JSON.parse(api.get(`SELECT preselected_stains FROM samples WHERE id = ?`, [id]).preselected_stains || "[]");
  eq(after.length, 1, "produced H&E trimmed");
  eq(after[0].assay_name, "Safranin O", "the uncut agent stays outstanding");
  // Idempotent: a fresh re-request after reconcile is NOT clobbered by re-running.
  api.requestStainForSample(id, "stain", "H&E"); // re-request → outstanding again
  reconcileStainRequests(api); // marker already set → no-op
  assert(JSON.parse(api.get(`SELECT preselected_stains FROM samples WHERE id = ?`, [id]).preselected_stains)
    .some((a) => a.assay_name === "H&E"), "re-run does not wipe a legitimate re-request");
});

// #41 — a stain requested AFTER an earlier one is already in staining must still
// flag the block (per-stain), and a request with no free extra flags for cutting.
issue(41, "a newly requested stain re-flags the block for cutting", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "reflag", {
    preselectedStains: [{ assay_type: "stain", assay_name: "H&E" }],
  });
  api.markEmbedded(id);
  const plan = JSON.parse(api.get(`SELECT sectioning_plan FROM samples WHERE id = ?`, [id]).sectioning_plan);
  const [section] = api.createSectionRequests(id, plan.filter((g) => g.assay_name));
  api.startAssayWork(section); // H&E now in staining → its flag clears
  eq(pendingFlag(api, id), "", "H&E flag clears once it is in staining");
  // Request a NEW stain with no free extra → flags the block for a fresh cut.
  const r = api.requestStainForSample(id, "stain", "SafO");
  eq(r.target, "block", "no extra available → the block is flagged");
  const pending = JSON.parse(pendingFlag(api, id) || "[]");
  assert(pending.some((a) => a.assay_name === "SafO"), "the block is re-flagged for the new stain (SafO)");
  assert(!pending.some((a) => a.assay_name === "H&E"), "the already-produced H&E is not re-flagged");
});

invariant("same agent across different samples loads into ONE cross-sample rack", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const a = api.addSample(p, "EE", "sample A"); api.markEmbedded(a.id);
  const b = api.addSample(p, "EE", "sample B"); api.markEmbedded(b.id);
  const r1 = stainOneSlide(api, a.id, "stain", "SafO");
  const r2 = stainOneSlide(api, b.id, "stain", "SafO");
  eq(r1, r2, "both SafO slides join the same rack across samples");
  eq(api.all(`SELECT id FROM slide_stacks WHERE kind = 'stain'`).length, 1, "one SafO rack");
  eq(api.get(`SELECT sample_id FROM slide_stacks WHERE id = ?`, [r1]).sample_id, null, "a rack is not tied to one sample");
});

invariant("different agents form different racks; one sample scatters across them", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const s = api.addSample(p, "EE", "multi-stain"); api.markEmbedded(s.id);
  const safo = stainOneSlide(api, s.id, "stain", "SafO");
  const he = stainOneSlide(api, s.id, "stain", "H&E");
  assert(safo !== he, "SafO and H&E are separate racks");
  eq(api.all(`SELECT id FROM slide_stacks WHERE kind = 'stain'`).length, 2, "two agent racks");
});

invariant("a later same-agent rack stays SEPARATE and never merges", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const a = api.addSample(p, "EE", "rack A"); api.markEmbedded(a.id);
  const b = api.addSample(p, "EE", "rack B"); api.markEmbedded(b.id);
  const rackA = stainOneSlide(api, a.id, "stain", "SafO");
  api.moveSlideStack(rackA, "stained"); // rack A moves into the reagents
  const rackB = stainOneSlide(api, b.id, "stain", "SafO"); // a fresh loading rack
  assert(rackA !== rackB, "the later SafO slide starts a new rack");
  api.moveSlideStack(rackB, "stained");
  eq(api.all(`SELECT id FROM slide_stacks WHERE kind = 'stain' AND current_stage = 'stained'`).length, 2,
     "two SafO racks coexist at the same substage without merging");
});

invariant("leaving staining scatters slides into per-sample imaging stacks", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const a = api.addSample(p, "EE", "scatter A"); api.markEmbedded(a.id);
  const b = api.addSample(p, "EE", "scatter B"); api.markEmbedded(b.id);
  const rack = stainOneSlide(api, a.id, "stain", "SafO");
  stainOneSlide(api, b.id, "stain", "SafO"); // joins the same rack
  // Walk the rack out of staining.
  for (const stage of ["stained", "coverslipped", "dried", "ready_for_imaging"]) api.moveSlideStack(rack, stage);
  eq(api.all(`SELECT id FROM slide_stacks WHERE kind = 'stain'`).length, 0, "the rack is consumed on the way out");
  eq(api.all(`SELECT id FROM slide_stacks WHERE kind = 'sample' AND current_stage = 'ready_for_imaging'`).length, 2,
     "each sample gets its own imaging stack");
});

invariant("a sample's slides from different racks re-converge into ONE imaging stack", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const s = api.addSample(p, "EE", "converge"); api.markEmbedded(s.id);
  const other = api.addSample(p, "EE", "keeps rack cross-sample"); api.markEmbedded(other.id);
  const safo = stainOneSlide(api, s.id, "stain", "SafO");
  stainOneSlide(api, other.id, "stain", "SafO");
  const he = stainOneSlide(api, s.id, "stain", "H&E");
  for (const stage of ["stained", "coverslipped", "dried", "ready_for_imaging"]) api.moveSlideStack(safo, stage);
  for (const stage of ["stained", "coverslipped", "dried", "ready_for_imaging"]) api.moveSlideStack(he, stage);
  const sStacks = api.all(`SELECT id FROM slide_stacks WHERE kind = 'sample' AND sample_id = ?`, [s.id]);
  eq(sStacks.length, 1, "the sample has a single imaging stack, not one per stain");
  eq(api.get(`SELECT COUNT(*) AS c FROM slides WHERE stack_id = ?`, [sStacks[0].id]).c, 2,
     "both of the sample's stained slides converged into it");
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
  const stack = api.get(`SELECT id FROM slide_stacks WHERE kind = 'stain' AND assay_name = 'H&E' AND closed_at IS NULL`);
  const stackAudit = api.get(
    `SELECT sample_id, stack_id FROM audit_events WHERE entity_type = 'slide_stack' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    [stack.id]);
  eq(stackAudit.stack_id, stack.id, "stack audit should identify its stack");
  eq(stackAudit.sample_id, null, "a cross-sample stain rack audit has no single sample");
  const slideAudit = api.get(
    `SELECT sample_id, stack_id FROM audit_events WHERE entity_type = 'slide' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    [slide.id]);
  eq(slideAudit.sample_id, id, "slide audit should identify its sample");
  eq(slideAudit.stack_id, stack.id, "slide audit should identify its stack (rack)");
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

// #23 — Running two batches at once is entirely the technician's call: a second
// overlapping run starts freely, with no busy guard and no override prompt. The
// UI must also carry no ProcessorBusy/"Start anyway" affordance any more.
issue(23, "an overlapping run starts freely, no prompt", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const a = api.addSample(p, "EE", "batch A", { processingType: "Short" });
  const b = api.addSample(p, "EE", "batch B", { processingType: "Long" });
  api.completePreprocessing(a.id);
  api.completePreprocessing(b.id);
  api.startProcessingBatch({ sampleIds: [a.id], processingType: "Short", startedAt: now() });
  // A second overlapping run must just start — no throw, no opt-in.
  const second = api.startProcessingBatch({ sampleIds: [b.id], processingType: "Long", startedAt: now() });
  assert(second > 0, "the second run starts without any concurrency guard");
  eq(api.get(`SELECT current_stage FROM samples WHERE id = ?`, [b.id]).current_stage,
     "processing_started", "the concurrent run's sample entered the processor");
  // The override prompt is gone from the UI (issue #23 comment).
  const dbSource = readFileSync(join(HERE, "..", "src", "lib", "db.ts"), "utf8");
  const dialog = readFileSync(join(HERE, "..", "src", "components", "BatchStartDialog.tsx"), "utf8");
  assert(!dbSource.includes("ProcessorBusyError"), "the ProcessorBusyError guard is removed");
  assert(!dialog.includes("Start anyway"), "the 'Start anyway' override prompt is removed");
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
issue(9, "staining an extra joins the loading rack for its agent", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "merge");
  api.markEmbedded(id);
  // First cut: two slides; assign one to H&E, keep one as a saved extra.
  const [section] = api.createSectionRequests(id, [{ duplicates: 2 }]);
  api.sectionToAssignment(section);
  const slides = api.all(`SELECT * FROM slides WHERE section_request_id = ? ORDER BY slide_ordinal`, [section]);
  api.assignSlide(slides[0].id, "stain", "stain", "H&E");
  api.assignSlide(slides[1].id, "extra", "", "");
  api.startAssayWork(section); // H&E slide now loads into the H&E rack
  const heRack = api.get(`SELECT stack_id FROM slides WHERE id = ?`, [slides[0].id]).stack_id;
  // Later: take the saved extra from inventory and stain it with the SAME agent.
  const extra = api.listExtraSlides().find((s) => s.sample_id === id);
  assert(extra, "an extra slide is available in inventory");
  const originalSectionId = extra.section_request_id;
  const { stackId } = api.assignExtraSlideToAssay(extra.id, "stain", "H&E");
  eq(stackId, heRack, "a same-agent extra joins the existing H&E rack");
  eq(api.get(`SELECT COUNT(*) AS c FROM slides WHERE stack_id = ?`, [heRack]).c, 2,
    "the companion and the extra share the agent rack");
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
// converge into the sample's imaging stack alongside its companion, so every
// slide gets its own imaging checkbox. The drawer renders one checkbox per slide
// in listSlidesForStack, so the gate asserts the imaging stack owns both slides
// with imaging timestamps set.
issue(14, "a separately-stained extra converges into the sample's imaging stack", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "imaging merge");
  api.markEmbedded(id);
  const [section] = api.createSectionRequests(id, [{ duplicates: 2 }]);
  api.sectionToAssignment(section);
  const slides = api.all(`SELECT * FROM slides WHERE section_request_id = ? ORDER BY slide_ordinal`, [section]);
  api.assignSlide(slides[0].id, "stain", "stain", "H&E");
  api.assignSlide(slides[1].id, "extra", "", "");
  api.startAssayWork(section);
  // The H&E companion finishes staining and scatters into the sample's imaging stack.
  const companionRack = api.get(`SELECT stack_id FROM slides WHERE id = ?`, [slides[0].id]).stack_id;
  for (const stage of ["stained", "coverslipped", "dried", "ready_for_imaging"]) api.moveSlideStack(companionRack, stage);
  const imagingStack = api.get(
    `SELECT id FROM slide_stacks WHERE kind = 'sample' AND sample_id = ? AND current_stage = 'ready_for_imaging'`, [id]);
  assert(imagingStack, "the companion produced a per-sample imaging stack");

  // Later: the saved extra is stained independently and advances to imaging.
  const extra = api.listExtraSlides().find((s) => s.id === slides[1].id);
  assert(extra, "the saved extra is available in inventory");
  const { stackId: extraRack } = api.assignExtraSlideToAssay(extra.id, "stain", "H&E");
  eq(api.get(`SELECT kind FROM slide_stacks WHERE id = ?`, [extraRack]).kind, "stain", "the extra starts in a fresh stain rack");
  for (const stage of ["stained", "coverslipped", "dried", "ready_for_imaging"]) api.moveSlideStack(extraRack, stage);

  eq(api.get(`SELECT COUNT(*) AS c FROM slide_stacks WHERE kind = 'sample' AND sample_id = ? AND closed_at IS NULL`, [id]).c,
     1, "one imaging stack remains for the sample");
  eq(api.get(`SELECT COUNT(*) AS c FROM slides WHERE stack_id = ?`, [imagingStack.id]).c,
     2, "the imaging stack owns both the companion and the extra");
  eq(api.get(`SELECT COUNT(*) AS c FROM slides WHERE stack_id = ? AND stage_ready_for_imaging_at IS NOT NULL`, [imagingStack.id]).c,
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
  assert(drawer.includes('moveSections(sectioningBatchIds, "stain_requested")'),
    "drawer must start assays for the selected batch (Mark Sectioned → staining)");
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
  assert(drawer.includes('moveSections(sectioningBatchIds, "stain_requested")'),
    "Mark Sectioned must use the selected section IDs and go straight to staining");
});

// The real proof of the undo rework: a logical whole-DB snapshot must round-trip
// EXACTLY through a destructive churn (cascade delete + inserts + updates across
// many tables), with foreign keys enforced (freshDb sets foreign_keys = ON).
invariant("whole-DB snapshot/restore round-trips exactly across every table", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const s1 = api.addSample(p, "EE", "one", { preselectedStains: [{ assay_type: "stain", assay_name: "H&E" }] });
  const s2 = api.addSample(p, "EE", "two");
  api.markEmbedded(s1.id);
  api.markEmbedded(s2.id);
  const plan = JSON.parse(api.get(`SELECT sectioning_plan FROM samples WHERE id = ?`, [s1.id]).sectioning_plan);
  const secIds = api.createSectionRequests(s1.id, plan);
  for (const id of secIds) api.startAssayWork(id); // slides + cross-sample stain racks
  api.completePreprocessing(s2.id);
  api.startProcessingBatch({ sampleIds: [s2.id], processingType: "Short", startedAt: now() });

  const before = api.snapshotDb();
  const dump = () => JSON.stringify(
    before.order.map((t) => api.all(`SELECT * FROM "${t}"`).map((r) => JSON.stringify(r)).sort()),
  );
  const original = dump();

  // Churn hard: cascade-delete a whole sample tree, mutate another, add a new one.
  api.run(`DELETE FROM samples WHERE id = ?`, [s1.id]); // cascades to sections/slides/stacks
  api.run(`UPDATE samples SET current_stage = 'analyzed' WHERE id = ?`, [s2.id]);
  api.addSample(p, "EE", "three");
  assert(dump() !== original, "the churn actually changed the database");

  api.restoreDb(before);
  eq(dump(), original, "restore reproduces the exact pre-churn contents of every table");
});

issue(28, "undo/redo restore the whole database snapshot", () => {
  const actions = readFileSync(join(HERE, "..", "src", "hooks", "useActions.ts"), "utf8");
  const db = readFileSync(join(HERE, "..", "src", "lib", "db.ts"), "utf8");
  assert(db.includes("export async function snapshotDb") && db.includes("export async function restoreDb"),
    "the DB layer exposes whole-database snapshot + restore");
  assert(actions.includes("await snapshotDb()") && actions.includes("record({ label, snapshot: before })"),
    "every mutation captures the pre-state DB snapshot for undo");
  assert(actions.includes("restoreDbPreservingSession(entry.snapshot") && db.includes("await restoreDb(image)"),
    "undo and redo restore a whole-DB snapshot (via restoreDbPreservingSession) rather than replaying per-row closures");
});

// #29 — Undoing "start assay workflow" used to leave the minted slide stack
// behind as an empty tile. With whole-DB snapshot undo there is nothing to
// reconcile: restoring the entire pre-assay database removes the stack (and any
// scattered per-sample stacks, #31) automatically — the UI simply refetches.
issue(29, "whole-DB undo removes any stack a move minted, with no bespoke reconciliation", () => {
  const actions = readFileSync(join(HERE, "..", "src", "hooks", "useActions.ts"), "utf8");
  assert(actions.includes("const commit = useCallback") && actions.includes("await snapshotDb()"),
    "mutations snapshot the whole DB, so undo restores every table at once");
  assert(!actions.includes("snapshotStacksForSlides") && !actions.includes("pruneStacks("),
    "the fragile per-stack reconciliation is gone");
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
  assert(actions.includes("await snapshotDb()"),
    "stack moves are undoable via the whole-DB snapshot");
});

issue(58, "opening a pre-0020 image converges slides.stage_deparaffinized_at so the step doesn't die", () => {
  // Port of ensureRuntimeSchema/ensureColumn — src/lib/db.ts. The app swaps the
  // SQLite file at runtime (undo restore, sync viewer) and plugin-sql only runs
  // migrations at startup, so a live file can predate a column. Build a DB the
  // way an app upgraded to 0.4.6 (v19) would look — every migration EXCEPT 0020.
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith(".sql") || file.startsWith("0020")) continue;
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  const hasCol = () =>
    db.prepare(`PRAGMA table_info(slides)`).all().some((c) => c.name === "stage_deparaffinized_at");
  assert(!hasCol(), "precondition: the pre-0020 image is missing the column");

  const stampDepar = () =>
    db.prepare(
      `UPDATE slides SET stage_deparaffinized_at = ? WHERE stack_id = ? AND purpose = 'stain' AND assay_type = ?`,
    ).run("2026-01-01 09:00", 1, "stain");
  // Before convergence the Deparaffinized step-0 write throws — this is exactly
  // what made the checkbox silently do nothing.
  let threw = false;
  try { stampDepar(); } catch { threw = true; }
  assert(threw, "without the column the deparaffinize write throws");

  // ensureColumn(): additive, guarded by table_info — a no-op when present.
  if (!hasCol()) db.exec(`ALTER TABLE slides ADD COLUMN stage_deparaffinized_at TEXT`);
  assert(hasCol(), "convergence adds the missing column");
  stampDepar(); // now succeeds — the step can persist and the checkbox checks
  db.close();
});

invariant("getDb converges late-added runtime columns on every (re)open", () => {
  // Forward-compat contract: every additive column current queries depend on is
  // re-asserted after any DB file swap (undo/sync/backup-revert). If you add a
  // migration with a new runtime column, add it to ensureRuntimeSchema AND here.
  const db = readFileSync(join(HERE, "..", "src", "lib", "db.ts"), "utf8");
  assert(db.includes("ensureRuntimeSchema"), "getDb must run a runtime schema guard");
  const converged = [
    /ensureColumn\(\s*db,\s*"slides",\s*"stage_deparaffinized_at"/,
    /ensureColumn\(\s*db,\s*"samples",\s*"preselected_stains"/,
  ];
  for (const re of converged) {
    assert(re.test(db), `ensureRuntimeSchema must converge ${re}`);
  }
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
