#!/usr/bin/env node
// Staining-stack model harness — the executable spec for the 0.3.3 stack rework.
//
//   node scripts/staining-stack-harness.mjs [--verbose]
//
// This harness is intentionally SELF-CONTAINED. It defines the *target* shape of
// slide_stacks for the staining stage and a reference implementation of the new
// grouping rules, so we can lock the behaviour down before touching the real
// migrations / db.ts (which still carry the depth-based per-sample model). Once
// the design is agreed, this becomes migration 0018 + the db.ts port, and these
// invariants fold into scripts/workflow-test.mjs.
//
// ---------------------------------------------------------------------------
// The model (agreed for 0.3.3)
// ---------------------------------------------------------------------------
// Stack identity is `sample + stage` everywhere EXCEPT the staining stage.
//
// During staining a stack is a *rack*: the unit that moves through the
// histological reagents together and will eventually own a protocol timer.
//   • Grouping key while loading = (assay agent) + (substage). Slides entering
//     staining join the one OPEN rack for their agent that is still at the entry
//     substage `stain_requested` — CROSS-SAMPLE. Ten samples' SafO slides load
//     into one SafO rack.
//   • A rack is homogeneous by agent, so its protocol (stain vs IHC) is
//     unambiguous.
//   • A rack advances through the staining substages AS A UNIT and NEVER merges
//     with another rack — not even a same-agent rack at the same substage. A
//     SafO rack started shortly after another SafO rack stays a separate stack so
//     the two move through the reagents (and their timers) independently.
//   • Leaving staining (→ ready_for_imaging) the rack SCATTERS: each member slide
//     rejoins its own sample's imaging stack. Cross-sample grouping exists ONLY
//     during staining; imaging and analysis are per-sample. A sample whose slides
//     were spread across several agent racks re-converges into ONE imaging stack.
//
// No depth anywhere (issue #5): stacks and slides carry no depth columns.

import { DatabaseSync } from "node:sqlite";

const VERBOSE = process.argv.includes("--verbose");

// ---------------------------------------------------------------------------
// Tiny test framework
// ---------------------------------------------------------------------------
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, passed: true, detail: "" });
  } catch (err) {
    results.push({ name, passed: false, detail: err?.message ?? String(err) });
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

// ---------------------------------------------------------------------------
// Target schema for the staining slice (no depth; agent-scoped racks)
// ---------------------------------------------------------------------------
// The staining substage chain the rack walks. IHC racks run the same shape with
// their own protocol; the agent's type is what selects the protocol/timer.
const STAIN_SUBSTAGES = ["stain_requested", "stained", "coverslipped", "dried", "ready_for_imaging"];

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE samples (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_code  TEXT NOT NULL
    );

    -- A slide belongs to exactly one sample and (once assigned) one assay agent.
    CREATE TABLE slides (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slide_code    TEXT NOT NULL UNIQUE,
      sample_id     INTEGER NOT NULL,
      assay_type    TEXT NOT NULL DEFAULT '',   -- 'stain' | 'ihc' | '' (extra)
      assay_name    TEXT NOT NULL DEFAULT '',   -- e.g. 'SafO', 'H&E', 'CD31'
      purpose       TEXT NOT NULL DEFAULT 'stain',
      stack_id      INTEGER,
      current_stage TEXT NOT NULL DEFAULT 'assigned',
      FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE CASCADE,
      FOREIGN KEY (stack_id) REFERENCES slide_stacks(id) ON DELETE SET NULL
    );

    -- Two kinds of stack share this table:
    --   kind='stain'  → a cross-sample rack. assay_type/assay_name set,
    --                    sample_id NULL. Identity = agent + substage, never merged.
    --   kind='sample' → a per-sample downstream stack (imaging/analysis).
    --                    sample_id set, assay_* NULL.
    CREATE TABLE slide_stacks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT NOT NULL CHECK (kind IN ('stain', 'sample')),
      assay_type    TEXT,
      assay_name    TEXT,
      sample_id     INTEGER,
      current_stage TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
      closed_at     TEXT,
      FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE CASCADE,
      CHECK (
        (kind = 'stain'  AND sample_id IS NULL AND assay_name IS NOT NULL) OR
        (kind = 'sample' AND sample_id IS NOT NULL AND assay_name IS NULL)
      )
    );

    -- At most one OPEN sample-stack per (sample, stage): per-sample convergence.
    CREATE UNIQUE INDEX idx_sample_stack_open
      ON slide_stacks(sample_id, current_stage)
      WHERE kind = 'sample' AND closed_at IS NULL;

    -- NOTE: there is deliberately NO unique index on (assay_name, current_stage)
    -- for stain racks — two same-agent racks may legitimately sit at the same
    -- substage and must stay separate. Loading joins only the stain_requested
    -- rack (see loadIntoStainRack); nothing else merges.
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Reference implementation of the staining-stage rules
// ---------------------------------------------------------------------------
function makeApi(db) {
  const run = (sql, params = []) => db.prepare(sql).run(...params);
  const get = (sql, params = []) => db.prepare(sql).get(...params);
  const all = (sql, params = []) => db.prepare(sql).all(...params);

  let slideSeq = 0;
  function addSample(code) {
    const r = run(`INSERT INTO samples (sample_code) VALUES (?)`, [code]);
    return Number(r.lastInsertRowid);
  }
  // A physical slide with its assay agent already assigned (0.3.3 preassigns
  // stains at sample creation; extras get an agent when a stain is requested).
  function addAssignedSlide(sampleId, assayType, assayName) {
    slideSeq += 1;
    const code = `${get(`SELECT sample_code FROM samples WHERE id = ?`, [sampleId]).sample_code}-${String.fromCharCode(64 + slideSeq)}`;
    const r = run(
      `INSERT INTO slides (slide_code, sample_id, assay_type, assay_name, purpose, current_stage)
       VALUES (?, ?, ?, ?, 'stain', 'assigned')`,
      [code, sampleId, assayType, assayName],
    );
    return Number(r.lastInsertRowid);
  }

  // Enter staining: the slide loads into the OPEN rack for its agent that is
  // still at 'stain_requested', cross-sample. If none exists, a new rack starts.
  function loadIntoStainRack(slideId) {
    const sl = get(`SELECT * FROM slides WHERE id = ?`, [slideId]);
    if (!sl || sl.purpose !== "stain" || !sl.assay_name) {
      throw new Error("Only an assigned assay slide can enter staining.");
    }
    let rack = get(
      `SELECT * FROM slide_stacks
        WHERE kind = 'stain' AND assay_type = ? AND assay_name = ?
          AND current_stage = 'stain_requested' AND closed_at IS NULL`,
      [sl.assay_type, sl.assay_name],
    );
    if (!rack) {
      const r = run(
        `INSERT INTO slide_stacks (kind, assay_type, assay_name, sample_id, current_stage)
         VALUES ('stain', ?, ?, NULL, 'stain_requested')`,
        [sl.assay_type, sl.assay_name],
      );
      rack = { id: Number(r.lastInsertRowid) };
    }
    run(`UPDATE slides SET stack_id = ?, current_stage = 'stain_requested' WHERE id = ?`, [rack.id, slideId]);
    return rack.id;
  }

  // Advance a rack one substage AS A UNIT. Never merges with any other rack.
  function advanceRack(stackId, nextStage) {
    const rack = get(`SELECT * FROM slide_stacks WHERE id = ? AND kind = 'stain'`, [stackId]);
    if (!rack) throw new Error("That stain rack no longer exists.");
    const from = STAIN_SUBSTAGES.indexOf(rack.current_stage);
    const to = STAIN_SUBSTAGES.indexOf(nextStage);
    if (to !== from + 1) throw new Error(`A rack advances one substage at a time (${rack.current_stage} → ${nextStage}).`);
    if (nextStage === "ready_for_imaging") return scatterToImaging(stackId);
    run(`UPDATE slides SET current_stage = ? WHERE stack_id = ?`, [nextStage, stackId]);
    run(`UPDATE slide_stacks SET current_stage = ? WHERE id = ?`, [nextStage, stackId]);
    return stackId;
  }

  // Leaving staining: scatter each slide back to its own sample's imaging stack.
  function scatterToImaging(stackId) {
    const members = all(`SELECT * FROM slides WHERE stack_id = ?`, [stackId]);
    for (const sl of members) {
      let imaging = get(
        `SELECT * FROM slide_stacks
          WHERE kind = 'sample' AND sample_id = ? AND current_stage = 'ready_for_imaging'
            AND closed_at IS NULL`,
        [sl.sample_id],
      );
      if (!imaging) {
        const r = run(
          `INSERT INTO slide_stacks (kind, assay_type, assay_name, sample_id, current_stage)
           VALUES ('sample', NULL, NULL, ?, 'ready_for_imaging')`,
          [sl.sample_id],
        );
        imaging = { id: Number(r.lastInsertRowid) };
      }
      run(`UPDATE slides SET stack_id = ?, current_stage = 'ready_for_imaging' WHERE id = ?`, [imaging.id, sl.id]);
    }
    run(`DELETE FROM slide_stacks WHERE id = ?`, [stackId]); // rack consumed
    return null;
  }

  // Convenience: walk a rack all the way out of staining.
  function runRackToImaging(stackId) {
    let stage = get(`SELECT current_stage FROM slide_stacks WHERE id = ?`, [stackId]).current_stage;
    let id = stackId;
    while (stage !== "ready_for_imaging") {
      const next = STAIN_SUBSTAGES[STAIN_SUBSTAGES.indexOf(stage) + 1];
      advanceRack(id, next);
      if (next === "ready_for_imaging") return;
      stage = next;
    }
  }

  return { db, run, get, all, addSample, addAssignedSlide, loadIntoStainRack, advanceRack, runRackToImaging, STAIN_SUBSTAGES };
}

// ---------------------------------------------------------------------------
// Invariants — the staining-stage stack model
// ---------------------------------------------------------------------------

test("slides of the SAME agent from different samples load into ONE cross-sample rack", () => {
  const api = makeApi(freshDb());
  const s1 = api.addSample("AA");
  const s2 = api.addSample("BB");
  const a = api.addAssignedSlide(s1, "stain", "SafO");
  const b = api.addAssignedSlide(s2, "stain", "SafO");
  const r1 = api.loadIntoStainRack(a);
  const r2 = api.loadIntoStainRack(b);
  eq(r1, r2, "both SafO slides join the same rack across samples");
  eq(api.all(`SELECT id FROM slide_stacks WHERE kind = 'stain'`).length, 1, "exactly one SafO rack");
  eq(api.get(`SELECT COUNT(*) AS c FROM slides WHERE stack_id = ?`, [r1]).c, 2, "rack owns both samples' slides");
  eq(api.get(`SELECT sample_id FROM slide_stacks WHERE id = ?`, [r1]).sample_id, null, "a stain rack is not tied to a sample");
});

test("different agents form different racks", () => {
  const api = makeApi(freshDb());
  const s = api.addSample("AA");
  const safo = api.loadIntoStainRack(api.addAssignedSlide(s, "stain", "SafO"));
  const he = api.loadIntoStainRack(api.addAssignedSlide(s, "stain", "H&E"));
  assert(safo !== he, "SafO and H&E are separate racks");
  eq(api.all(`SELECT id FROM slide_stacks WHERE kind = 'stain'`).length, 2, "two agent racks");
});

test("a sample with several stains scatters its slides across the agent racks", () => {
  const api = makeApi(freshDb());
  const s = api.addSample("AA");
  const racks = new Set([
    api.loadIntoStainRack(api.addAssignedSlide(s, "stain", "SafO")),
    api.loadIntoStainRack(api.addAssignedSlide(s, "stain", "H&E")),
    api.loadIntoStainRack(api.addAssignedSlide(s, "ihc", "CD31")),
  ]);
  eq(racks.size, 3, "one sample's three stains occupy three distinct racks");
});

test("a rack is homogeneous by agent, so its protocol type is unambiguous", () => {
  const api = makeApi(freshDb());
  const s1 = api.addSample("AA");
  const s2 = api.addSample("BB");
  const rack = api.loadIntoStainRack(api.addAssignedSlide(s1, "ihc", "CD31"));
  api.loadIntoStainRack(api.addAssignedSlide(s2, "ihc", "CD31"));
  const agents = api.all(`SELECT DISTINCT assay_type, assay_name FROM slides WHERE stack_id = ?`, [rack]);
  eq(agents.length, 1, "every slide in the rack shares one agent");
  eq(agents[0].assay_type, "ihc", "the rack's protocol type is the agent's type");
});

test("a rack advances through the substages as a single unit", () => {
  const api = makeApi(freshDb());
  const s1 = api.addSample("AA");
  const s2 = api.addSample("BB");
  const rack = api.loadIntoStainRack(api.addAssignedSlide(s1, "stain", "SafO"));
  api.loadIntoStainRack(api.addAssignedSlide(s2, "stain", "SafO"));
  api.advanceRack(rack, "stained");
  eq(api.get(`SELECT current_stage FROM slide_stacks WHERE id = ?`, [rack]).current_stage, "stained", "rack moved");
  eq(api.get(`SELECT COUNT(*) AS c FROM slides WHERE stack_id = ? AND current_stage = 'stained'`, [rack]).c, 2,
     "all member slides advanced together");
});

test("a second same-agent rack started later stays SEPARATE and never merges", () => {
  const api = makeApi(freshDb());
  const s1 = api.addSample("AA");
  const s2 = api.addSample("BB");
  // Rack A loads and moves into the reagents.
  const rackA = api.loadIntoStainRack(api.addAssignedSlide(s1, "stain", "SafO"));
  api.advanceRack(rackA, "stained");
  // A new SafO slide arrives: it must NOT join the advanced rack — a fresh
  // loading rack starts at stain_requested.
  const rackB = api.loadIntoStainRack(api.addAssignedSlide(s2, "stain", "SafO"));
  assert(rackA !== rackB, "the later SafO slide starts a new rack, not joining the advanced one");
  eq(api.all(`SELECT id FROM slide_stacks WHERE kind = 'stain'`).length, 2, "two independent SafO racks");
  // Even when B catches up to A's substage, they remain separate (independent timers).
  api.advanceRack(rackB, "stained");
  eq(api.all(`SELECT id FROM slide_stacks WHERE kind = 'stain' AND current_stage = 'stained'`).length, 2,
     "two SafO racks coexist at the same substage without merging");
});

test("leaving staining scatters slides back into per-sample imaging stacks", () => {
  const api = makeApi(freshDb());
  const s1 = api.addSample("AA");
  const s2 = api.addSample("BB");
  const rack = api.loadIntoStainRack(api.addAssignedSlide(s1, "stain", "SafO"));
  api.loadIntoStainRack(api.addAssignedSlide(s2, "stain", "SafO"));
  api.runRackToImaging(rack);
  eq(api.all(`SELECT id FROM slide_stacks WHERE kind = 'stain'`).length, 0, "the rack is consumed on the way out");
  const sampleStacks = api.all(`SELECT sample_id FROM slide_stacks WHERE kind = 'sample' AND current_stage = 'ready_for_imaging'`);
  eq(sampleStacks.length, 2, "each sample gets its own imaging stack");
  for (const sid of [s1, s2]) {
    const stack = api.get(`SELECT id FROM slide_stacks WHERE kind = 'sample' AND sample_id = ?`, [sid]);
    eq(api.get(`SELECT COUNT(*) AS c FROM slides WHERE stack_id = ?`, [stack.id]).c, 1, "the sample's slide followed it to imaging");
  }
});

test("a sample's slides from different agent racks re-converge into ONE imaging stack", () => {
  const api = makeApi(freshDb());
  const s = api.addSample("AA");
  const other = api.addSample("BB"); // shares the SafO rack, keeps it cross-sample
  const safo = api.loadIntoStainRack(api.addAssignedSlide(s, "stain", "SafO"));
  api.loadIntoStainRack(api.addAssignedSlide(other, "stain", "SafO"));
  const he = api.loadIntoStainRack(api.addAssignedSlide(s, "stain", "H&E"));
  // Both of sample AA's stains finish and leave staining.
  api.runRackToImaging(safo);
  api.runRackToImaging(he);
  const aaStacks = api.all(`SELECT id FROM slide_stacks WHERE kind = 'sample' AND sample_id = ?`, [s]);
  eq(aaStacks.length, 1, "sample AA has a single imaging stack, not one per stain");
  eq(api.get(`SELECT COUNT(*) AS c FROM slides WHERE stack_id = ?`, [aaStacks[0].id]).c, 2,
     "both of AA's stained slides converged into that one stack");
});

test("no depth columns exist anywhere in the staining model", () => {
  const api = makeApi(freshDb());
  for (const table of ["slides", "slide_stacks"]) {
    const cols = api.all(`PRAGMA table_info(${table})`).map((r) => r.name.toLowerCase());
    for (const c of cols) {
      assert(!c.includes("depth"), `${table}.${c} still references depth`);
    }
  }
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const c = process.stdout.isTTY
  ? { g: "\x1b[32m", r: "\x1b[31m", d: "\x1b[2m", x: "\x1b[0m" }
  : { g: "", r: "", d: "", x: "" };
let failed = 0;
for (const t of results) {
  if (t.passed) {
    if (VERBOSE) console.log(`  ${c.g}PASS${c.x} ${t.name}`);
  } else {
    failed += 1;
    console.log(`  ${c.r}FAIL${c.x} ${t.name}\n       ${c.d}${t.detail}${c.x}`);
  }
}
const passed = results.length - failed;
console.log(`\n${failed === 0 ? c.g : c.r}${passed}/${results.length} staining-stack invariants hold${c.x}`);
if (failed === 0) console.log(`${c.g}✓ The 0.3.3 staining-stack model is consistent.${c.x}`);
process.exit(failed === 0 ? 0 : 1);
