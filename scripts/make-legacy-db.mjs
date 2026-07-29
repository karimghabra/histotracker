#!/usr/bin/env node
// Build a realistic PRE-0023 database image — the shape a lab running 0.7.0's
// predecessor actually has on disk — so we can prove the update neither loses
// data nor breaks on it.
//
//   node scripts/make-legacy-db.mjs
//
// Writes two artefacts next to the repo's test fixtures:
//   tests/fixtures/legacy-pre-0023.sqlite  — for the migration test (node)
//   tests/fixtures/legacy-pre-0023.b64     — for injection into the browser
//                                            shim's virtual FS (Playwright)
//
// The data is chosen to stress exactly the two risky paths in this release:
//   • #73 — a sample with slides A–D, so deleting one can try to reissue a letter
//     that is still in use (which used to fail the UNIQUE constraint).
//   • #81 — a stain rack that is stained-but-not-coverslipped and has ANOTHER
//     sample's slide wrongly merged into it, which the one-time repair must
//     split back out on first open.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "src-tauri", "migrations");
const OUT_DIR = join(HERE, "..", "tests", "fixtures");
const STOP_AFTER = "0022"; // the last migration before this release

mkdirSync(OUT_DIR, { recursive: true });
const dbPath = join(OUT_DIR, "legacy-pre-0023.sqlite");
try {
  // Start clean so re-running is deterministic.
  writeFileSync(dbPath, Buffer.alloc(0));
} catch {
  /* fine */
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");

const applied = [];
for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
  if (!file.endsWith(".sql")) continue;
  if (file.slice(0, 4) > STOP_AFTER) continue;
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  applied.push(file);
}
console.log(`applied ${applied.length} migrations, up to ${applied.at(-1)}`);

// Sanity: this really is a pre-0023 image.
const sampleCols = db.prepare(`PRAGMA table_info(samples)`).all().map((c) => c.name);
if (sampleCols.includes("slides_issued") || sampleCols.includes("archived_at")) {
  throw new Error("fixture is not pre-0023 — the new columns are already present");
}

const run = (sql, args = []) => db.prepare(sql).run(...args);
const one = (sql, args = []) => db.prepare(sql).get(...args);

// ---- Realistic bench data ---------------------------------------------------
run(`INSERT INTO projects (code, name, team_lead) VALUES ('EE', 'Enthesis Engineering', 'Alex Rivera')`);
const projectId = one(`SELECT id FROM projects WHERE code = 'EE'`).id;
run(`INSERT INTO users (name, initials) VALUES ('Alex Rivera', 'AR')`);

function addSample(number, description, stage) {
  run(
    `INSERT INTO samples (project_id, project_sample_number, sample_code, sample_description,
                          date_added, processing_type, fixative_agent, current_stage, stage_received_at)
     VALUES (?, ?, ?, ?, '2026-07-01', 'Short', 'Z-Fix', ?, '2026-07-01 09:00')`,
    [projectId, number, `EE-${String(number).padStart(4, "0")}`, description, stage],
  );
  return one(`SELECT id FROM samples WHERE project_sample_number = ?`, [number]).id;
}

function addSection(sampleId, duplicates, stage) {
  run(
    `INSERT INTO section_requests (sample_id, duplicates, stains, current_stage, stage_needs_sectioning_at)
     VALUES (?, ?, '', ?, '2026-07-02 09:00')`,
    [sampleId, duplicates, stage],
  );
  return one(`SELECT id FROM section_requests WHERE sample_id = ? ORDER BY id DESC LIMIT 1`, [sampleId]).id;
}

function addSlide(sectionId, ordinal, code, extra = {}) {
  run(
    `INSERT INTO slides (section_request_id, slide_ordinal, slide_code, purpose, assay_type, assay_name,
                         stain_name, assignment_saved, slice_count, control_agent, current_stage,
                         stage_cut_at, stage_stained_at, stack_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 2, 'IgG', ?, '2026-07-02 10:00', ?, ?)`,
    [
      sectionId, ordinal, code,
      extra.purpose ?? "extra",
      extra.assayType ?? "",
      extra.assayName ?? "",
      extra.stainName ?? "",
      extra.stage ?? "extra",
      extra.stainedAt ?? null,
      extra.stackId ?? null,
    ],
  );
  return one(`SELECT id FROM slides WHERE slide_code = ?`, [code]).id;
}

// EE-0001 — an embedded block with four cut extras, A–D. Deleting one of these
// is what used to make the next cut collide on slide_code.
const s1 = addSample(1, "4 week Stretch PLA", "embedded");
const sec1 = addSection(s1, 4, "extra");
for (const [i, letter] of ["A", "B", "C", "D"].entries()) {
  addSlide(sec1, i + 1, `EE-0001-${letter}`, { purpose: "extra", stage: "extra" });
}

// EE-0002 and EE-0003 — both have a SafO stain slide. EE-0002's rack was ticked
// "Stained" (timestamp set, current_stage still 'stain_requested' — the exact
// state the old rack lookup mistook for "still loading"), and EE-0003's slide
// was then absorbed into it. The repair must pull EE-0003 back out.
const s2 = addSample(2, "8 week Stretch PLA", "needs_sectioning");
const s3 = addSample(3, "12 week Stretch PLA", "needs_sectioning");
run(
  `INSERT INTO slide_stacks (kind, assay_type, assay_name, sample_id, current_stage,
                             stage_stain_requested_at, stage_stained_at)
   VALUES ('stain', 'stain', 'Safranin O', NULL, 'stain_requested', '2026-07-03 09:00', '2026-07-03 11:00')`,
);
const rackId = one(`SELECT id FROM slide_stacks ORDER BY id DESC LIMIT 1`).id;

const sec2 = addSection(s2, 1, "stain_requested");
addSlide(sec2, 1, "EE-0002-A", {
  purpose: "stain", assayType: "stain", assayName: "Safranin O", stainName: "Safranin O",
  stage: "stain_requested", stainedAt: "2026-07-03 11:00", stackId: rackId,
});

const sec3 = addSection(s3, 1, "stain_requested");
// The wrongly-merged one: no stage_stained_at of its own, because it arrived
// AFTER the rack was ticked.
addSlide(sec3, 1, "EE-0003-A", {
  purpose: "stain", assayType: "stain", assayName: "Safranin O", stainName: "Safranin O",
  stage: "stain_requested", stainedAt: null, stackId: rackId,
});

db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
db.close();

const bytes = readFileSync(dbPath);
writeFileSync(join(OUT_DIR, "legacy-pre-0023.b64"), bytes.toString("base64"));

console.log(`wrote ${dbPath} (${bytes.length} bytes) + base64 fixture`);
console.log("contents: 3 samples, 4 extras on EE-0001, 1 contaminated SafO rack");
