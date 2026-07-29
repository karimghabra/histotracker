#!/usr/bin/env node
// Prove the 0.7.0 update is safe on a REAL pre-0023 database.
//
//   node scripts/make-legacy-db.mjs && node scripts/legacy-db-upgrade-test.mjs
//
// Covers the two ways a live database reaches the new build:
//   PATH A — tauri-plugin-sql runs migration 0023 against the existing file
//            (the normal upgrade on app start).
//   PATH B — the file is swapped in at runtime (undo restore / viewer sync pull),
//            where migrations do NOT re-run and ensureRuntimeSchema() is the only
//            thing that converges it.
// Both must end with the data intact and the new columns usable.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "tests", "fixtures", "legacy-pre-0023.sqlite");
const MIGRATION_0023 = join(HERE, "..", "src-tauri", "migrations", "0023_slide_sequence_and_archive.sql");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "expected equality"} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

function openCopy(suffix) {
  const path = FIXTURE.replace(/\.sqlite$/, `.${suffix}.sqlite`);
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  return { db, path };
}

// Port of ensureColumn() — src/lib/db.ts.
function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
// Port of ensureRuntimeSchema()'s 0023 lines.
function ensureRuntimeSchema(db) {
  ensureColumn(db, "samples", "slides_issued", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "samples", "archived_at", "TEXT");
}
// Port of splitContaminatedStainRacks() — src/lib/db.ts.
function splitContaminatedStainRacks(db) {
  const done = db.prepare(`SELECT value FROM schema_meta WHERE key = 'stain_racks_split_81'`).get();
  if (done && done.value === "1") return;
  const contaminated = db.prepare(
    `SELECT ss.id, ss.assay_type, ss.assay_name FROM slide_stacks ss
      WHERE ss.kind = 'stain' AND ss.closed_at IS NULL AND ss.current_stage = 'stain_requested'
        AND (ss.stage_stained_at IS NOT NULL OR ss.stage_ihc_at IS NOT NULL)
        AND EXISTS (SELECT 1 FROM slides sl WHERE sl.stack_id = ss.id AND sl.purpose = 'stain'
                      AND sl.stage_stained_at IS NULL)`).all();
  for (const rack of contaminated) {
    const strays = db.prepare(
      `SELECT id FROM slides WHERE stack_id = ? AND purpose = 'stain' AND stage_stained_at IS NULL`,
    ).all(rack.id);
    if (!strays.length) continue;
    db.prepare(
      `INSERT INTO slide_stacks (kind, assay_type, assay_name, sample_id, current_stage, stage_stain_requested_at)
       VALUES ('stain', ?, ?, NULL, 'stain_requested', ?)`,
    ).run(rack.assay_type, rack.assay_name, "2026-07-28 12:00");
    const fresh = db.prepare(`SELECT id FROM slide_stacks ORDER BY id DESC LIMIT 1`).get().id;
    for (const s of strays) db.prepare(`UPDATE slides SET stack_id = ? WHERE id = ?`).run(fresh, s.id);
  }
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('stain_racks_split_81', '1')
       ON CONFLICT(key) DO UPDATE SET value = '1'`,
  ).run();
}

function assertDataIntact(db, label) {
  eq(db.prepare(`SELECT COUNT(*) AS n FROM samples`).get().n, 3, `${label}: all 3 samples still present`);
  eq(db.prepare(`SELECT COUNT(*) AS n FROM slides`).get().n, 6, `${label}: all 6 slides still present`);
  eq(db.prepare(`SELECT COUNT(*) AS n FROM projects`).get().n, 1, `${label}: project still present`);
  eq(
    db.prepare(`SELECT sample_description AS d FROM samples WHERE sample_code = 'EE-0001'`).get().d,
    "4 week Stretch PLA",
    `${label}: sample details unchanged`,
  );
  eq(
    db.prepare(`SELECT COUNT(*) AS n FROM slides WHERE slide_code LIKE 'EE-0001-%'`).get().n,
    4,
    `${label}: EE-0001 keeps its four slides`,
  );
}

console.log("\nPATH A — plugin-sql applies migration 0023 to the existing file");
{
  const { db } = openCopy("patha");
  const before = db.prepare(`SELECT COUNT(*) AS n FROM slides`).get().n;
  db.exec(readFileSync(MIGRATION_0023, "utf8")); // must not throw on populated data
  check("migration 0023 applies cleanly to a populated database", () => {
    const cols = db.prepare(`PRAGMA table_info(samples)`).all().map((c) => c.name);
    assert(cols.includes("slides_issued"), "slides_issued added");
    assert(cols.includes("archived_at"), "archived_at added");
  });
  check("no rows were lost or altered by the migration", () => {
    assertDataIntact(db, "A");
    eq(db.prepare(`SELECT COUNT(*) AS n FROM slides`).get().n, before, "slide count unchanged");
  });
  check("existing rows get safe defaults", () => {
    eq(db.prepare(`SELECT COUNT(*) AS n FROM samples WHERE slides_issued = 0`).get().n, 3,
       "slides_issued defaults to 0 (= not tracked yet)");
    eq(db.prepare(`SELECT COUNT(*) AS n FROM samples WHERE archived_at IS NULL`).get().n, 3,
       "nothing is archived by surprise");
  });
  check("the #81 repair splits the contaminated rack, and only it", () => {
    splitContaminatedStainRacks(db);
    const racks = db.prepare(`SELECT id FROM slide_stacks WHERE kind = 'stain'`).all();
    eq(racks.length, 2, "the merged rack became two");
    const e2 = db.prepare(`SELECT stack_id FROM slides WHERE slide_code = 'EE-0002-A'`).get().stack_id;
    const e3 = db.prepare(`SELECT stack_id FROM slides WHERE slide_code = 'EE-0003-A'`).get().stack_id;
    assert(e2 !== e3, "the two samples are no longer in the same rack");
    eq(db.prepare(`SELECT stage_stained_at AS t FROM slides WHERE slide_code = 'EE-0002-A'`).get().t,
       "2026-07-03 11:00", "the genuinely-stained slide keeps its timestamp");
  });
  check("the repair is idempotent on a second open", () => {
    splitContaminatedStainRacks(db);
    eq(db.prepare(`SELECT COUNT(*) AS n FROM slide_stacks WHERE kind = 'stain'`).get().n, 2,
       "re-running does not keep splitting");
  });
  check("slide letters continue rather than repeat after a delete (#73)", () => {
    // Freeze the mark, then delete C — exactly what deleteSlide() does.
    const sampleId = db.prepare(`SELECT id FROM samples WHERE sample_code = 'EE-0001'`).get().id;
    const nextLetter = () => {
      const r = db.prepare(
        `SELECT COALESCE((SELECT slides_issued FROM samples WHERE id = ?), 0) AS issued,
                (SELECT COUNT(sl.id) FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
                  WHERE sr.sample_id = ?) AS used`).get(sampleId, sampleId);
      return Math.max(r.issued, r.used) + 1;
    };
    eq(nextLetter(), 5, "before deleting, the next letter is E");
    db.prepare(`UPDATE samples SET slides_issued = MAX(COALESCE(slides_issued,0), ?) WHERE id = ?`)
      .run(nextLetter() - 1, sampleId);
    db.prepare(`DELETE FROM slides WHERE slide_code = 'EE-0001-C'`).run();
    eq(nextLetter(), 5, "after deleting C the next letter is STILL E, not D");
  });
  db.close();
}

console.log("\nPATH B — the image is swapped in at runtime; only ensureRuntimeSchema converges it");
{
  const { db } = openCopy("pathb");
  check("a pre-0023 image is missing the columns before convergence", () => {
    const cols = db.prepare(`PRAGMA table_info(samples)`).all().map((c) => c.name);
    assert(!cols.includes("slides_issued"), "precondition: no slides_issued");
    assert(!cols.includes("archived_at"), "precondition: no archived_at");
  });
  check("reading the new columns throws before convergence", () => {
    let threw = false;
    try { db.prepare(`SELECT archived_at FROM samples`).all(); } catch { threw = true; }
    assert(threw, "without convergence the archive query fails");
  });
  check("ensureRuntimeSchema converges the image", () => {
    ensureRuntimeSchema(db);
    const cols = db.prepare(`PRAGMA table_info(samples)`).all().map((c) => c.name);
    assert(cols.includes("slides_issued") && cols.includes("archived_at"), "both columns present");
    db.prepare(`SELECT archived_at FROM samples`).all(); // no longer throws
  });
  check("convergence is a no-op the second time", () => {
    ensureRuntimeSchema(db);
    assertDataIntact(db, "B");
  });
  check("archiving works on the converged image and hides only that sample", () => {
    db.prepare(`UPDATE samples SET archived_at = '2026-07-28 12:00' WHERE sample_code = 'EE-0003'`).run();
    eq(db.prepare(`SELECT COUNT(*) AS n FROM samples WHERE archived_at IS NULL`).get().n, 2,
       "two samples remain live");
    assertDataIntact(db, "B-after-archive"); // archiving deletes nothing
  });
  db.close();
}

console.log(
  failures === 0
    ? "\n✓ A live pre-0023 database upgrades cleanly by BOTH paths, with no data loss.\n"
    : `\n✗ ${failures} check(s) failed — do not ship.\n`,
);
process.exit(failures === 0 ? 0 : 1);
