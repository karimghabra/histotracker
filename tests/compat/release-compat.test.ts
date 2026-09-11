// Is this branch compatible with the build the lab is running?
//
// Both builds are real: the release is its own tagged source (its data layer,
// its registered migrations, its migration files) and this branch is the
// working tree. Each opens the database the way the shipped app does — the
// migrator on the first open of a process, then its own getDb() — and each is
// driven through its own data layer. docs/release_compat.md explains it.
//
//   pnpm test:compat                 the release in use, and the newest release
//   pnpm test:compat app-v0.18.0     any release, by tag

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "./sqlite";
import { currentBuild, releaseBuild, REPO_ROOT, type Build } from "./builds";
import { type App, type Dump, columnsOf, dump, launch, ledger, lostOrChanged, newMachine, quit } from "./app";
import { readEverything, runTheLab, skippedSteps, stored, workOnRows, type LabDay, type Reads } from "./lab";
import { seedLedger } from "./sqlx-migrator";

const RELEASE = process.env.COMPAT_RELEASE;
if (!RELEASE) throw new Error("Set COMPAT_RELEASE to a release tag, or run `pnpm test:compat`.");

/**
 * Migrations this branch registers that the release does not, accepted as a
 * ONE-WAY upgrade. Once this build opens a database, the release refuses it
 * ("migration N was previously applied but is missing"), so does every sync
 * viewer still running it, and a revert to a backup from before the update
 * re-runs the migration on the next launch. Empty is the normal state: a
 * column can be converged at runtime instead (AGENTS.md, embedding_notes).
 * Add a version only with the captain's sign-off, saying why; the stories
 * below then stop at the refusal instead of failing on it.
 */
const ACCEPTED_ONE_WAY: Record<number, string> = {};

/** The readers whose stored columns both builds must read back identically. */
const RECORDS = [
  ["listAllSamples", "samples"],
  ["listAllSlides", "slides"],
  ["listAllSectionRequests", "section_requests"],
  ["listAllProcessingBatches", "processing_batches"],
] as const;

/**
 * A revert keeps the live session on purpose (restoreDbPreservingSession, #1):
 * lab users and workstation settings are not rewound with the workflow data.
 */
const SESSION_TABLES = /^(table |column )?(users|app_settings)[ .]/;

let release: Build;
let branch: Build;
const lab = newMachine("lab-workstation");

let releaseDb: Dump; // the lab's database as the release left it
let releaseReads: Reads;
let releaseBackup = "";
let branchDb: Dump; // …and after this branch has worked on it too
let branchReads: Reads;
let branchDay: LabDay;
let newColumns: Array<[table: string, column: string]> = [];

async function using<T>(app: App, fn: (app: App) => Promise<T>): Promise<T> {
  try {
    return await fn(app);
  } finally {
    await quit(app);
  }
}

function sameStoredRecords(a: Reads, b: Reads, reference: Dump): void {
  for (const [list, table] of RECORDS) {
    if (!a.results[list] || !b.results[list]) {
      skippedSteps.add(`${list}() is missing from one build, so its records were not compared`);
      continue;
    }
    const columns = reference[table].columns;
    expect(stored(a.results[list], columns), `${list}(), stored columns`).toEqual(stored(b.results[list], columns));
  }
}

/** Every value this branch's new columns hold, by table, column and rowid. */
function newColumnValues(d: Dump): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [table, column] of newColumns) {
    for (const [rowid, row] of d[table].rows) out[`${table}.${column} row ${rowid}`] = row[column];
  }
  return out;
}

const oneWay = () => {
  const known = new Set(release.migrations.map((m) => m.version));
  return branch.migrations.map((m) => m.version).filter((v) => !known.has(v));
};
const acceptedOneWay = () => oneWay().length > 0 && oneWay().every((v) => v in ACCEPTED_ONE_WAY);

beforeAll(() => {
  release = releaseBuild(RELEASE);
  branch = currentBuild();
  console.log(
    `\n  release:     ${release.ref}, version ${release.version}, commit ${release.commit.slice(0, 12)}` +
      `\n  this branch: version ${branch.version}, commit ${branch.commit.slice(0, 12)} plus the working tree\n`,
  );
});

afterAll(() => {
  if (skippedSteps.size) console.log(`\n  steps the release is too old for:\n    ${[...skippedSteps].join("\n    ")}\n`);
});

describe("the migration ledger", () => {
  it("this branch registers every migration the release has applied, with the same SQL", () => {
    // Otherwise this branch refuses the lab's database on the first launch
    // after the update (VersionMissing, or VersionMismatch for changed SQL).
    const ours = new Map(branch.migrations.map((m) => [m.version, m.sql]));
    const problems = release.migrations.flatMap((m) =>
      !ours.has(m.version)
        ? [`${m.version} (${m.file}) is not registered by this branch`]
        : ours.get(m.version) !== m.sql
          ? [`${m.version} (${m.file}) has different SQL on this branch`]
          : [],
    );
    expect(problems).toEqual([]);
  });

  it("the release registers every migration this branch does, so it can still open what this branch writes", () => {
    const refused = oneWay().filter((v) => !(v in ACCEPTED_ONE_WAY));
    expect(
      refused,
      `this branch registers migration ${refused.join(", ")}, which ${release.ref} does not. After this ` +
        `build opens the lab's database, ${release.ref} refuses to open it; after a revert to a backup ` +
        `taken before the update, the next launch runs the migration again on top of the column ` +
        `getDb() already converged. Converge the column at runtime only, or get a signed-off ` +
        `ACCEPTED_ONE_WAY entry.`,
    ).toEqual([]);
  });
});

describe("upgrade: the release's database, opened by this branch", () => {
  it("the release builds up a working lab", async () => {
    await using(await launch(release, lab), async (app) => {
      await runTheLab(app, "release");
      releaseReads = await readEverything(app);
      releaseBackup = (await app.backup.createBackup("manual", 48)).name;
    });
    releaseDb = dump(lab.dbFile);
    expect(releaseDb.samples.rows.size).toBeGreaterThan(5);
  });

  it("this branch opens it, and records only the migrations both builds register", async () => {
    await quit(await launch(branch, lab));
    const both = new Set(release.migrations.map((m) => m.version));
    expect(ledger(lab.dbFile).filter((v) => !both.has(v) && !(v in ACCEPTED_ONE_WAY))).toEqual([]);
  });

  it("opening it lost or changed nothing the release wrote", () => {
    expect(lostOrChanged(releaseDb, dump(lab.dbFile))).toEqual([]);
  });

  it("every column this branch adds is nullable or defaulted, so the release's inserts still work", () => {
    const columns = columnsOf(lab.dbFile);
    newColumns = Object.entries(columns).flatMap(([table, cols]) =>
      table in releaseDb
        ? cols
            .filter((c) => !releaseDb[table].columns.includes(c.name))
            .map((c) => [table, c.name] as [string, string])
        : [],
    );
    console.log(`  columns this branch adds: ${newColumns.map((c) => c.join(".")).join(", ") || "none"}`);
    const unsafe = newColumns.filter(([table, column]) => {
      const c = columns[table].find((x) => x.name === column)!;
      return c.notnull && c.dflt_value === null;
    });
    expect(unsafe).toEqual([]);
  });

  it("this branch reads everything in it, and reads the stored values exactly as the release does", async () => {
    await using(await launch(branch, lab), async (app) => {
      sameStoredRecords(await readEverything(app), releaseReads, releaseDb);
    });
  });

  it("this branch works on it, and changes nothing the release wrote in doing so", async () => {
    await using(await launch(branch, lab), async (app) => {
      branchDay = await runTheLab(app, "branch");
      branchReads = await readEverything(app);
    });
    branchDb = dump(lab.dbFile);
    expect(lostOrChanged(releaseDb, branchDb)).toEqual([]);
  });

  it("the lab writes every column this branch adds, so the survival checks below mean something", () => {
    const unwritten = newColumns.filter(([table, column]) => {
      const dflt = columnsOf(lab.dbFile)[table].find((c) => c.name === column)!.dflt_value;
      const fallback = dflt === null ? null : String(dflt).replace(/^'(.*)'$/, "$1");
      return [...branchDb[table].rows.values()].every((row) => row[column] === fallback);
    });
    expect(unwritten, "make runTheLab() in tests/compat/lab.ts write these").toEqual([]);
  });
});

describe("rollback: the same database, now written by this branch, opened by the release", () => {
  it("the release opens it", async () => {
    if (acceptedOneWay()) {
      await expect(launch(release, lab)).rejects.toThrow(/previously applied but is missing/);
      return;
    }
    await quit(await launch(release, lab));
  });

  it("opening it lost or changed nothing this branch wrote", ({ skip }) => {
    if (acceptedOneWay()) skip();
    expect(lostOrChanged(branchDb, dump(lab.dbFile))).toEqual([]);
  });

  it("the release reads everything in it, and reads the stored values exactly as this branch does", async ({ skip }) => {
    if (acceptedOneWay()) skip();
    await using(await launch(release, lab), async (app) => {
      sameStoredRecords(await readEverything(app), branchReads, releaseDb);
    });
  });

  it("the release works on it, rows this branch created included, and this branch's values survive", async ({ skip }) => {
    if (acceptedOneWay()) skip();
    await using(await launch(release, lab), async (app) => {
      await runTheLab(app, "release again");
      await workOnRows(app, branchDay.fixing, "release");
      await readEverything(app);
    });
    const kept = newColumnValues(dump(lab.dbFile));
    const before = newColumnValues(branchDb);
    expect(Object.fromEntries(Object.keys(before).map((k) => [k, kept[k]]))).toEqual(before);
  });

  it("this branch opens it again and reads everything", async ({ skip }) => {
    if (acceptedOneWay()) skip();
    await using(await launch(branch, lab), async (app) => {
      await readEverything(app);
    });
  });
});

describe("backups across the version change", () => {
  it("this branch reverts to a backup the release took; the next launch opens it, all there", async () => {
    await using(await launch(branch, lab), async (app) => {
      await app.backup.revertToBackup(releaseBackup);
    });
    // The next morning: a new process, so the migrator runs against the
    // ledger the backup carried in.
    await using(await launch(branch, lab), async (app) => {
      await readEverything(app);
    });
    expect(lostOrChanged(releaseDb, dump(lab.dbFile)).filter((d) => !SESSION_TABLES.test(d))).toEqual([]);
  });

  it("the release reverts to a backup this branch took; the next launch opens it, all there", async ({ skip }) => {
    if (acceptedOneWay()) skip();
    let name = "";
    await using(await launch(branch, lab), async (app) => {
      await runTheLab(app, "branch before backup");
      name = (await app.backup.createBackup("manual", 48)).name;
    });
    const atBackup = dump(lab.dbFile);
    await using(await launch(release, lab), async (app) => {
      await runTheLab(app, "release after backup");
      await app.backup.revertToBackup(name);
    });
    await using(await launch(release, lab), async (app) => {
      await readEverything(app);
    });
    expect(lostOrChanged(atBackup, dump(lab.dbFile)).filter((d) => !SESSION_TABLES.test(d))).toEqual([]);
  });
});

describe("sync between a workstation and a viewer on different builds", () => {
  /** Publish from `workstation`, pull on a viewer that has been running `viewerBuild`, relaunch it. */
  async function publishAndPull(workstation: () => Promise<App>, viewerBuild: Build, viewerName: string): Promise<void> {
    const viewer = newMachine(viewerName, "viewer");
    await quit(await launch(viewerBuild, viewer)); // a viewer that has been running its own build
    const published = await using(await workstation(), async (app) => {
      await app.sync.publishSnapshot();
      return app.machine.dbFile;
    }).then(dump);
    await using(await launch(viewerBuild, viewer), async (app) => {
      expect((await app.sync.pullSnapshotIfNewer()).updated).toBe(true);
      await readEverything(app);
    });
    // The swap happened under a running app; the migrator meets the pulled
    // ledger only at the next launch.
    await using(await launch(viewerBuild, viewer), async (app) => {
      await readEverything(app);
    });
    expect(lostOrChanged(published, dump(viewer.dbFile))).toEqual([]);
  }

  it("the workstation updates first: a viewer still on the release pulls what this branch published", async ({ skip }) => {
    if (acceptedOneWay()) skip();
    await publishAndPull(() => launch(branch, lab), release, "viewer on the release");
  });

  it("a viewer updates first: this branch pulls what a workstation still on the release published", async () => {
    const workstation = newMachine("workstation still on the release");
    await using(await launch(release, workstation), (app) => runTheLab(app, "release workstation"));
    await publishAndPull(() => launch(release, workstation), branch, "viewer on this branch");
  });
});

describe("the populated legacy database (tests/fixtures/legacy-pre-0023.b64)", () => {
  it("goes release, then this branch, then the release again, with every row intact", async ({ skip }) => {
    if (acceptedOneWay()) skip();
    const legacy = newMachine("legacy");
    const b64 = readFileSync(join(REPO_ROOT, "tests", "fixtures", "legacy-pre-0023.b64"), "utf8");
    writeFileSync(legacy.dbFile, Buffer.from(b64, "base64"));
    // Built by running migrations 1–22 directly; give it the ledger the app
    // would have written doing the same.
    const db = new DatabaseSync(legacy.dbFile);
    seedLedger(db, release.migrations.filter((m) => m.version <= 22));
    db.close();
    const shipped = dump(legacy.dbFile);

    await using(await launch(release, legacy), async (app) => {
      await readEverything(app);
    });
    const onRelease = dump(legacy.dbFile); // after the release's own one-time repairs
    await using(await launch(branch, legacy), async (app) => {
      await readEverything(app);
      await runTheLab(app, "branch on legacy");
    });
    await using(await launch(release, legacy), async (app) => {
      await readEverything(app);
    });
    const final = dump(legacy.dbFile);
    expect(lostOrChanged(onRelease, final)).toEqual([]);
    const codes = (d: Dump) => [...d.samples.rows.values()].map((r) => r.sample_code);
    expect(codes(final)).toEqual(expect.arrayContaining(codes(shipped)));
  });
});
