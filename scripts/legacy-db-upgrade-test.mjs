#!/usr/bin/env node
// Prove the 0.7.0 update is safe on a REAL pre-0023 database.
//
//   node scripts/make-legacy-db.mjs && node scripts/legacy-db-upgrade-test.mjs
//
// Covers the ways a live database reaches the new build:
//   PATH A — tauri-plugin-sql runs the migrations the file predates, then
//            getDb() converges it (the normal upgrade on app start).
//   PATH B — the file is swapped in at runtime (undo restore / viewer sync pull),
//            where migrations do NOT re-run and ensureRuntimeSchema() is the only
//            thing that converges it.
//   PATH C — the round trip through the build IN USE: upgrade, revert to a
//            backup that build took, relaunch; and that build opening the
//            upgraded file. Modelled on the real migrator, record and all.
// All must end with the data intact and the new columns usable.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "tests", "fixtures", "legacy-pre-0023.sqlite");
const MIGRATIONS_DIR = join(HERE, "..", "src-tauri", "migrations");

/**
 * Every migration the fixture predates, in order.
 *
 * This used to name 0023 alone, which quietly stopped meaning "the update" the
 * moment a 0024 existed: a later migration could be destructive on a populated
 * database and this file — the one test whose whole job is to say otherwise —
 * would not have run it. Discovered from the directory instead, so a new
 * migration is covered here the day it is added, with no edit to remember.
 */
const PENDING_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql") && Number(f.slice(0, 4)) >= 23)
  .sort();

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
// Port of ensureRuntimeSchema() — src/lib/db.ts. A FULL mirror, not just the
// columns this fixture happens to lack: ensureColumn is idempotent, and keeping
// the whole list here is what lets the drift guard below insist on a match.
const RUNTIME_COLUMNS = [
  ["slides", "stage_deparaffinized_at", "TEXT"],
  ["samples", "preselected_stains", "TEXT NOT NULL DEFAULT ''"],
  ["slides", "depth_label", "TEXT NOT NULL DEFAULT ''"],
  ["slides", "depth_note", "TEXT NOT NULL DEFAULT ''"],
  ["samples", "slides_issued", "INTEGER NOT NULL DEFAULT 0"],
  ["samples", "archived_at", "TEXT"],
  ["slides", "requested_assay_type", "TEXT NOT NULL DEFAULT ''"],
  ["slides", "requested_assay_name", "TEXT NOT NULL DEFAULT ''"],
  ["samples", "embedding_notes", "TEXT NOT NULL DEFAULT ''"],
];
function ensureRuntimeSchema(db, columns = RUNTIME_COLUMNS) {
  for (const [table, column, type] of columns) ensureColumn(db, table, column, type);
}

/**
 * DRIFT GUARD for the port above.
 *
 * This file is a SECOND hand-port of ensureRuntimeSchema (the harness has the
 * first). A column added to db.ts but not mirrored here would leave this test
 * quietly asserting the wrong contract — and the whole point of it is to prove
 * that an existing database converges. Rather than trust anyone to remember,
 * read db.ts and require every converged column to appear here too.
 */
function assertPortMatchesSource() {
  const dbSource = readFileSync(join(HERE, "..", "src", "lib", "db.ts"), "utf8");
  const guard = /async function ensureRuntimeSchema[\s\S]*?\n}/.exec(dbSource)?.[0] ?? "";
  if (!guard) throw new Error("could not find ensureRuntimeSchema in db.ts");
  const wanted = [...guard.matchAll(/ensureColumn\(\s*db,\s*"([^"]+)",\s*"([^"]+)"/g)]
    .map((m) => `${m[1]}.${m[2]}`);
  const ported = JSON.stringify(RUNTIME_COLUMNS);
  const missing = wanted.filter((col) => {
    const [table, column] = col.split(".");
    return !ported.includes(`"${table}","${column}"`);
  });
  if (missing.length) {
    throw new Error(
      `ensureRuntimeSchema port is out of date — missing ${missing.join(", ")}. ` +
      `Add it here so this test still proves what it claims.`,
    );
  }
}
// Port of splitContaminatedStainRacks() — src/lib/db.ts.
function splitContaminatedStainRacks(db) {
  const done = db.prepare(`SELECT value FROM schema_meta WHERE key = 'stain_racks_split_81'`).get();
  if (done && done.value === "1") return;
  const contaminated = db.prepare(
    // Keyed off the SLIDES, matching db.ts: the cut-group drawer's checkboxes
    // stamp slides without touching slide_stacks, so a rack contaminated that
    // way has all-NULL stack columns (#81).
    `SELECT ss.id, ss.assay_type, ss.assay_name FROM slide_stacks ss
      WHERE ss.kind = 'stain' AND ss.closed_at IS NULL AND ss.current_stage = 'stain_requested'
        AND EXISTS (SELECT 1 FROM slides w WHERE w.stack_id = ss.id AND w.purpose = 'stain'
                      AND (w.stage_stained_at IS NOT NULL OR w.stage_refrax_at IS NOT NULL
                        OR w.stage_coverslipped_at IS NOT NULL OR w.stage_dried_at IS NOT NULL))
        AND EXISTS (SELECT 1 FROM slides sl WHERE sl.stack_id = ss.id AND sl.purpose = 'stain'
                      AND sl.stage_stained_at IS NULL AND sl.stage_refrax_at IS NULL
                      AND sl.stage_coverslipped_at IS NULL AND sl.stage_dried_at IS NULL)`).all();
  for (const rack of contaminated) {
    // All four substage columns, matching db.ts. Testing stage_stained_at alone
    // evicts a member that was coverslipped or dried but never stained — a slide
    // the shipped code keeps in the rack it travelled through the reagents with.
    const strays = db.prepare(
      `SELECT id FROM slides
        WHERE stack_id = ? AND purpose = 'stain'
          AND stage_stained_at IS NULL AND stage_refrax_at IS NULL
          AND stage_coverslipped_at IS NULL AND stage_dried_at IS NULL`,
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

console.log(`\nPATH A — plugin-sql applies ${PENDING_MIGRATIONS.join(", ")} to the existing file`);
{
  const { db } = openCopy("patha");
  const before = db.prepare(`SELECT COUNT(*) AS n FROM slides`).get().n;
  const samplesBefore = db.prepare(
    `SELECT id, sample_code, sample_description, cut_notes, overall_notes FROM samples ORDER BY id`,
  ).all();
  // Every migration the fixture predates, in order — must not throw on
  // populated data.
  for (const file of PENDING_MIGRATIONS) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  // …and then getDb() opens it, which is where a runtime-only column arrives.
  ensureRuntimeSchema(db);
  check("this file's ensureRuntimeSchema port is still in step with db.ts", () => {
    assertPortMatchesSource();
  });
  check("migration 0023 applies cleanly to a populated database", () => {
    const cols = db.prepare(`PRAGMA table_info(samples)`).all().map((c) => c.name);
    assert(cols.includes("slides_issued"), "slides_issued added");
    assert(cols.includes("archived_at"), "archived_at added");
  });
  // #137 — the column the captain's populated database gains with this update.
  // Asserted DIRECTLY on a real pre-existing image, not inferred from a suite
  // that passed on an empty one: adding a column is only safe if every row that
  // was already there survives it, filled in place. It has no numbered
  // migration (see PATH C for why), so opening the file is what adds it.
  check("the update adds samples.embedding_notes to a populated database", () => {
    const cols = db.prepare(`PRAGMA table_info(samples)`).all().map((c) => c.name);
    assert(cols.includes("embedding_notes"), "embedding_notes added");
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM samples WHERE embedding_notes = ''`).get().n;
    eq(rows, 3, "every existing sample gets the empty-string default, not NULL");
  });
  check("the rows that were already there are untouched by the new column", () => {
    const after = db.prepare(
      `SELECT id, sample_code, sample_description, cut_notes, overall_notes FROM samples ORDER BY id`,
    ).all();
    eq(JSON.stringify(after), JSON.stringify(samplesBefore),
       "existing sample rows survive the new column byte for byte");
  });
  check("embedding notes are writable and readable on a pre-existing row", () => {
    db.prepare(`UPDATE samples SET embedding_notes = ? WHERE sample_code = 'EE-0001'`)
      .run("cut face down, proximal left");
    eq(db.prepare(`SELECT embedding_notes AS n FROM samples WHERE sample_code = 'EE-0001'`).get().n,
       "cut face down, proximal left", "the new column round-trips on an old row");
    assertDataIntact(db, "A-after-embedding-note");
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
  check("an image from before #137 is missing embedding_notes before convergence", () => {
    const cols = db.prepare(`PRAGMA table_info(samples)`).all().map((c) => c.name);
    assert(!cols.includes("embedding_notes"), "precondition: no embedding_notes");
  });
  check("ensureRuntimeSchema converges the image", () => {
    ensureRuntimeSchema(db);
    const cols = db.prepare(`PRAGMA table_info(samples)`).all().map((c) => c.name);
    assert(cols.includes("slides_issued") && cols.includes("archived_at"), "both columns present");
    db.prepare(`SELECT archived_at FROM samples`).all(); // no longer throws
  });
  // The path a backup revert or a sync pull takes: no migrations run, so this
  // is the ONLY thing that makes the new column exist on the captain's file.
  check("#137: embedding_notes converges too, with every row intact", () => {
    const cols = db.prepare(`PRAGMA table_info(samples)`).all().map((c) => c.name);
    assert(cols.includes("embedding_notes"), "embedding_notes present after convergence");
    eq(db.prepare(`SELECT COUNT(*) AS n FROM samples WHERE embedding_notes = ''`).get().n, 3,
       "existing rows default to empty, not NULL");
    db.prepare(`UPDATE samples SET embedding_notes = 'bisect' WHERE sample_code = 'EE-0002'`).run();
    eq(db.prepare(`SELECT embedding_notes AS n FROM samples WHERE sample_code = 'EE-0002'`).get().n,
       "bisect", "and the app can write to it straight away");
    assertDataIntact(db, "B-embedding-notes");
  });
  check("convergence is a no-op the second time", () => {
    ensureRuntimeSchema(db);
    assertDataIntact(db, "B");
  });
  check("#87: stored codes keep their four digits — only the DISPLAY strips them", () => {
    // The whole point of the display-layer approach: a lab that has been running
    // for months keeps every identifier exactly as written on its blocks, and
    // still sees the short form in the app.
    const codes = db.prepare(`SELECT sample_code AS c FROM samples ORDER BY id`).all().map((r) => r.c);
    eq(codes.join(","), "EE-0001,EE-0002,EE-0003", "storage is untouched by #87");
    const slides = db.prepare(`SELECT slide_code AS c FROM slides ORDER BY id LIMIT 2`).all().map((r) => r.c);
    eq(slides.join(","), "EE-0001-A,EE-0001-B", "slide codes keep the padded parent");

    // Port of displayCode() — src/lib/utils.ts.
    const display = (code) =>
      String(code ?? "").replace(/^([A-Za-z]+)-0*(\d+)/, (_m, p, d) => `${p}-${Number(d)}`);
    eq(codes.map(display).join(","), "EE-1,EE-2,EE-3", "the user sees the short form retroactively");
    eq(slides.map(display).join(","), "EE-1-A,EE-1-B", "slide codes display short too");
  });

  check("archiving works on the converged image and hides only that sample", () => {
    db.prepare(`UPDATE samples SET archived_at = '2026-07-28 12:00' WHERE sample_code = 'EE-0003'`).run();
    eq(db.prepare(`SELECT COUNT(*) AS n FROM samples WHERE archived_at IS NULL`).get().n, 2,
       "two samples remain live");
    assertDataIntact(db, "B-after-archive"); // archiving deletes nothing
  });
  db.close();
}

// ---------------------------------------------------------------------------
// PATH C — compatibility with the build IN USE, through the real migrator.
// ---------------------------------------------------------------------------

/**
 * The migrations a build registers, read out of `src-tauri/src/lib.rs` — the
 * list is explicit there, not discovered, and it is what actually runs.
 */
function registeredMigrations() {
  const rs = readFileSync(join(HERE, "..", "src-tauri", "src", "lib.rs"), "utf8");
  const found = [...rs.matchAll(/version:\s*(\d+),[\s\S]*?include_str!\("\.\.\/migrations\/([^"]+)"\)/g)]
    .map(([, version, file]) => ({
      version: Number(version),
      file,
      sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
    }));
  if (found.length === 0) throw new Error("could not read the migration list out of lib.rs");
  return found;
}

/**
 * The last migration the build in use registers. 0.17.0, cut from the
 * long-running claude/** release line, registers 0001–0024 — the same files as
 * master (checked 2026-09-10). Raise this when a release ships a new one.
 * This is a model of that build; `pnpm test:compat` runs the real one.
 */
const IN_USE_LAST_MIGRATION = 24;

/**
 * A model of what tauri-plugin-sql does at launch, then getDb().
 *
 * The plugin hands the registered list to sqlx's Migrator (0.8, ignore_missing
 * = false), which keeps the versions it has applied INSIDE the database file,
 * in `_sqlx_migrations`. That record is the whole point of modelling it: a
 * backup, a sync pull and an undo image all carry it with them, so a file can
 * come back into a build holding a record that disagrees with its columns.
 * sqlx then (1) refuses a file recording a version it does not know, and
 * (2) runs every known version it has no record of — whatever the columns say.
 */
function launch(db, { migrations, runtimeColumns }) {
  db.exec(`CREATE TABLE IF NOT EXISTS _sqlx_migrations (version INTEGER PRIMARY KEY)`);
  const applied = new Set(
    db.prepare(`SELECT version FROM _sqlx_migrations`).all().map((r) => Number(r.version)),
  );
  const known = new Set(migrations.map((m) => m.version));
  for (const v of applied) {
    if (!known.has(v)) {
      throw new Error(`migration ${v} was previously applied but is missing in the resolved migrations`);
    }
  }
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare(`INSERT INTO _sqlx_migrations (version) VALUES (?)`).run(m.version);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.file} failed at launch: ${err.message}`);
    }
  }
  ensureRuntimeSchema(db, runtimeColumns);
}

/** A whole-file image of `db`, the way a backup is taken, opened as its own DB. */
function imageOf(db, suffix) {
  const path = FIXTURE.replace(/\.sqlite$/, `.${suffix}.sqlite`);
  rmSync(path, { force: true });
  db.exec(`VACUUM INTO '${path}'`);
  return new DatabaseSync(path);
}

console.log("\nPATH C — upgrade from the build in use, revert to its backup, relaunch");
{
  const thisBuild = { migrations: registeredMigrations(), runtimeColumns: RUNTIME_COLUMNS };
  // The build in use: its own migrations, and none of the columns this change
  // adds at runtime (on master before #137, and on 0.17.0 today, the list is
  // this one without samples.embedding_notes).
  const inUseBuild = {
    migrations: thisBuild.migrations.filter((m) => m.version <= IN_USE_LAST_MIGRATION),
    runtimeColumns: RUNTIME_COLUMNS.filter(([t, c]) => `${t}.${c}` !== "samples.embedding_notes"),
  };

  // The captain's database: the fixture predates 0023, so its record holds
  // 1–22; the build in use brings it to its own last migration on launch.
  const { db } = openCopy("pathc");
  db.exec(`CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY)`);
  for (let v = 1; v <= 22; v += 1) db.prepare(`INSERT INTO _sqlx_migrations VALUES (?)`).run(v);
  launch(db, inUseBuild);
  const inUseSamples = JSON.stringify(db.prepare(`SELECT * FROM samples ORDER BY id`).all());
  // The backup the build in use took on its schedule, before anyone upgraded.
  const backup = imageOf(db, "pathc-backup");
  backup.close();

  check("this build opens the in-use database and adds embedding_notes", () => {
    launch(db, thisBuild);
    const cols = db.prepare(`PRAGMA table_info(samples)`).all().map((c) => c.name);
    assert(cols.includes("embedding_notes"), "embedding_notes present after the upgrade launch");
    assertDataIntact(db, "C-upgraded");
  });

  // Problem 1 — the upgrade must not be a one-way door. A version recorded by
  // this build that the build in use does not know makes the build in use
  // refuse the file outright; so does every sync viewer still running it.
  check("the build in use can still open a database this build has opened", () => {
    const image = imageOf(db, "pathc-rollback");
    try {
      launch(image, inUseBuild);
      assertDataIntact(image, "C-rolled-back");
    } finally {
      image.close();
    }
  });

  // Problem 2 — the one reproduced on this fixture. Reverting swaps the backup
  // in WITHOUT migrating (revertToBackup → restoreDbPreservingSession), so
  // getDb() converges the column onto a file whose record never heard of it.
  // A migration that also adds the column then runs again at the next launch
  // and fails on "duplicate column name": the app cannot open its database.
  check("revert to the in-use build's backup, then relaunch: the database opens", () => {
    db.close();
    copyFileSync(FIXTURE.replace(/\.sqlite$/, ".pathc-backup.sqlite"),
                 FIXTURE.replace(/\.sqlite$/, ".pathc.sqlite"));
    const reverted = new DatabaseSync(FIXTURE.replace(/\.sqlite$/, ".pathc.sqlite"));
    try {
      ensureRuntimeSchema(reverted); // the revert, live
      launch(reverted, thisBuild);   // the next launch
      const cols = reverted.prepare(`PRAGMA table_info(samples)`).all().map((c) => c.name);
      assert(cols.includes("embedding_notes"), "embedding_notes present after the relaunch");
      const after = reverted.prepare(`SELECT * FROM samples ORDER BY id`).all()
        .map(({ embedding_notes, ...rest }) => rest);
      eq(JSON.stringify(after), inUseSamples,
         "every sample the backup held comes back exactly, apart from the new empty column");
      assertDataIntact(reverted, "C-reverted");
    } finally {
      reverted.close();
    }
  });
}

console.log(
  failures === 0
    ? "\n✓ A live pre-0023 database upgrades cleanly by every path, with no data loss,\n  and stays openable by the build in use.\n"
    : `\n✗ ${failures} check(s) failed — do not ship.\n`,
);
process.exit(failures === 0 ? 0 : 1);
