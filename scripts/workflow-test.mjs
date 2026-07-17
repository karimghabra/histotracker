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

  // Port of startProcessingBatch() — src/lib/db.ts. `guardEmptyProcessor`
  // reflects the *desired* fix for issue #5 (off by default = current behaviour).
  function startProcessingBatch({ sampleIds, processingType, startedAt, guardEmptyProcessor = false }) {
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

    if (guardEmptyProcessor) {
      const busy = get(`SELECT COUNT(*) AS c FROM processing_batches WHERE status = 'processing'`);
      if (busy.c > 0) throw new Error("The processor already has a run in progress.");
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

  // Save the whole assignment set for a section, then move it to staining.
  // Port of updateSectionStage(id, 'stain_requested') — src/lib/db.ts.
  function startAssayWork(sectionId) {
    const unsaved = get(`SELECT COUNT(*) AS c FROM slides WHERE section_request_id = ? AND assignment_saved = 0`, [sectionId]);
    if (unsaved.c > 0) throw new Error("Click Save All to confirm every slide assignment before starting assay work.");
    const ts = now();
    run(`UPDATE slides SET current_stage = CASE WHEN purpose = 'stain' THEN 'stain_requested' ELSE purpose END,
           stage_stain_requested_at = CASE WHEN purpose = 'stain' THEN COALESCE(stage_stain_requested_at, ?) ELSE stage_stain_requested_at END
           WHERE section_request_id = ?`, [ts, sectionId]);
    run(`UPDATE section_requests SET current_stage = 'stain_requested', stage_stain_requested_at = COALESCE(stage_stain_requested_at, ?) WHERE id = ?`, [ts, sectionId]);
  }

  // Port of assignExtraSlideToAssay() — src/lib/db.ts. This is the code path
  // exercised by issue #9: it always MINTS A NEW section_request for the slide.
  function assignExtraSlideToAssay(slideId, assayType, assayName) {
    const ts = now();
    const slide = get(
      `SELECT sl.section_request_id, sr.sample_id, sl.slide_code, sr.depth_um, sr.depth_index
         FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
        WHERE sl.id = ? AND sl.purpose = 'extra' AND sl.current_stage = 'extra'`, [slideId]);
    if (!slide) throw new Error("That extra slide is no longer available.");
    const cat = get(`SELECT id FROM assay_catalog WHERE assay_type = ? AND name = ? COLLATE NOCASE AND is_active = 1`, [assayType, assayName]);
    if (!cat) throw new Error("Choose an active stain or IHC agent from the catalog.");
    const r = run(
      `INSERT INTO section_requests (sample_id, depth_um, depth_index, duplicates, stains, current_stage,
         stage_sectioned_at, stage_assignment_required_at, stage_stain_requested_at)
       VALUES (?, ?, ?, 1, ?, 'stain_requested', ?, ?, ?)`,
      [slide.sample_id, slide.depth_um, slide.depth_index, assayName, ts, ts, ts]);
    const newSection = Number(r.lastInsertRowid);
    run(
      `UPDATE slides SET section_request_id = ?, slide_ordinal = 1, purpose = 'stain',
             assay_type = ?, assay_name = ?, stain_name = ?, current_stage = 'stain_requested',
             assignment_saved = 1, stage_stain_requested_at = COALESCE(stage_stain_requested_at, ?)
        WHERE id = ?`,
      [newSection, assayType, assayName, assayName, ts, slideId]);
    return newSection;
  }

  // The Extra Slides inventory query — src/lib/db.ts listExtraSlides().
  function listExtraSlides() {
    return all(
      `SELECT sl.*, s.id AS sample_id, s.sample_code AS parent_code
         FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
         JOIN samples s ON s.id = sr.sample_id JOIN projects p ON p.id = s.project_id
        WHERE sl.purpose = 'extra' AND sl.assignment_saved = 1 AND sl.current_stage = 'extra' AND p.is_active = 1
        ORDER BY sl.id`);
  }

  return {
    db, run, all, get,
    seedProject, addSample, completePreprocessing, startProcessingBatch, moveBatch,
    markEmbedded, createSectionRequests, sectionToAssignment, assignSlide,
    startAssayWork, assignExtraSlideToAssay, listExtraSlides, nextSampleNumber,
  };
}

// ---------------------------------------------------------------------------
// INVARIANTS — the happy path and data integrity that must always hold
// ---------------------------------------------------------------------------

invariant("all 14 migrations apply and expected tables exist", () => {
  const api = makeApi(freshDb());
  const names = api.all(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name);
  for (const t of ["projects", "samples", "section_requests", "slides", "processing_batches", "assay_catalog", "stain_requests", "sample_timeline_events"]) {
    assert(names.includes(t), `missing table ${t}`);
  }
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

// #2 — Z-Fix should be the default fixative. Data default is still 'PFA'; the
// fix is UI (dialog default) — but we assert the intended default here so the
// change is captured. knownOpen until the default flips.
issue(2, "new samples default to the Z-Fix fixative", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  // Simulates the dialog's default selection feeding addSample().
  const DEFAULT_FIXATIVE = "PFA"; // TODO(fix #2): change dialog default to "Z-Fix"
  const { id } = api.addSample(p, "EE", "fixative", { fixative: DEFAULT_FIXATIVE });
  eq(api.get(`SELECT fixative_agent FROM samples WHERE id = ?`, [id]).fixative_agent, "Z-Fix", "default fixative");
}, { knownOpen: true });

// #5 — Short and Long runs cannot coincide. A second batch must be refused
// while one is already processing. The current startProcessingBatch has no such
// guard (guardEmptyProcessor defaults off), so this fails until the check ships.
issue(5, "cannot start a second batch while the processor is busy", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const a = api.addSample(p, "EE", "batch A", { processingType: "Short" });
  const b = api.addSample(p, "EE", "batch B", { processingType: "Long" });
  api.completePreprocessing(a.id);
  api.completePreprocessing(b.id);
  api.startProcessingBatch({ sampleIds: [a.id], processingType: "Short", startedAt: now() });
  let threw = false;
  try { api.startProcessingBatch({ sampleIds: [b.id], processingType: "Long", startedAt: now() }); }
  catch { threw = true; }
  assert(threw, "overlapping processor run should be rejected");
}, { knownOpen: true });

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
}, { knownOpen: true });

// #9 — Extra slides getting stained do not merge cleanly. Assigning an extra
// slide to an assay for a sample that ALREADY has an open assay section should
// join that section, not mint a brand-new one. Today a new section is minted.
issue(9, "staining an extra slide joins the sample's existing assay section", () => {
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
  api.assignExtraSlideToAssay(extra.id, "ihc", "CD31");
  // Desired: the sample has exactly ONE open assay section carrying both slides.
  const openSections = api.all(
    `SELECT sr.id, COUNT(sl.id) AS stain_slides
       FROM section_requests sr JOIN slides sl ON sl.section_request_id = sr.id
      WHERE sr.sample_id = ? AND sl.purpose = 'stain' AND sr.current_stage = 'stain_requested'
      GROUP BY sr.id`, [id]);
  eq(openSections.length, 1, "extra slide should merge into the existing assay section, not spawn a second");
}, { knownOpen: true });

// #10 — Undo/redo erroneously depopulates the extra-slide inventory. The
// concrete data defect underlying the symptom: assigning a lone extra slide to
// an assay (assignExtraSlideToAssay) re-parents it to a NEW section and leaves
// its original section behind with zero slides — an orphan the board's grouping
// and undo logic then mishandle, which is what makes inventory rows disappear
// unexpectedly. A clean model must never leave an empty section behind. (The
// full undo-stack symptom also warrants a UI/Playwright repro — see the plan.)
issue(10, "assigning an extra slide leaves no orphaned empty section behind", () => {
  const api = makeApi(freshDb());
  const p = api.seedProject();
  const { id } = api.addSample(p, "EE", "orphan");
  api.markEmbedded(id);
  // A single-slide cut, saved as an extra so it lands in inventory.
  const [section] = api.createSectionRequests(id, [{ depth_um: 100, duplicates: 1 }]);
  api.sectionToAssignment(section);
  const slide = api.get(`SELECT id FROM slides WHERE section_request_id = ?`, [section]);
  api.assignSlide(slide.id, "extra", "", "");
  eq(api.listExtraSlides().length, 1, "one extra in inventory");
  // Send that extra to IHC from the inventory.
  api.assignExtraSlideToAssay(slide.id, "ihc", "CD31");
  // Desired: the original section is gone (or reused), never left slide-less.
  const orphans = api.get(
    `SELECT COUNT(*) AS c FROM section_requests sr
      WHERE sr.sample_id = ? AND NOT EXISTS (SELECT 1 FROM slides sl WHERE sl.section_request_id = sr.id)`, [id]);
  eq(orphans.c, 0, "an empty, orphaned section was left behind");
}, { knownOpen: true });

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
