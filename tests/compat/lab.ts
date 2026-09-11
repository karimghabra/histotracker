// A day at the bench, done through a build's own data layer, and a sweep of
// everything the app reads. Both run unchanged on every build under test, so a
// database written by one build is exercised by the other the way the lab
// would exercise it.
//
// KEEP runTheLab() WRITING EVERY COLUMN. The harness fails if a column this
// branch adds holds only its default after the lab has run, because a column
// nobody writes proves nothing about whether its values survive the release.

import type { App } from "./app";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function step<T>(app: App, what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(`${app.build.label} on ${app.machine.name}: ${what} failed — ${(err as Error).message}`);
  }
}

const EMBED_PATH = [
  "in_fixative",
  "fixative_removed",
  "in_ethanol",
  "processing_started",
  "processed",
  "picked_up",
  "needs_embedding",
  "embedded",
];

export async function embed(app: App, sampleId: number): Promise<void> {
  for (const stage of EMBED_PATH) {
    await step(app, `moving sample ${sampleId} to ${stage}`, () => app.db.updateSampleStage(sampleId, stage));
  }
}

async function project(app: App, code: string, name: string): Promise<Any> {
  const existing = (await app.db.listProjects()).find((p: Any) => p.code === code);
  if (existing) return existing;
  await step(app, `adding project ${code}`, () =>
    app.db.addProject({ code, name, team_lead: "", is_active: true, lead_user_id: 0 }),
  );
  return (await app.db.listProjects()).find((p: Any) => p.code === code);
}

async function newSample(
  app: App,
  proj: Any,
  description: string,
  opts: { embedding_notes?: string; stains?: Array<[string, string]> } = {},
): Promise<number> {
  return step(app, `adding sample "${description}"`, () =>
    app.db.addSample(
      {
        project_id: proj.id,
        sample_description: description,
        processing_type: "Short",
        fixative_agent: "Z-Fix",
        needs_decalcification: false,
        cut_notes: "trim to 5 um",
        slide_notes: "",
        // #137. A release that predates the field never reads it.
        embedding_notes: opts.embedding_notes ?? "",
        stains: "",
        preselected_stains: (opts.stains ?? []).map(([assay_type, assay_name]) => ({ assay_type, assay_name })),
        overall_notes: "",
      },
      proj.code,
    ),
  );
}

export interface LabDay {
  /** Blocks in fixative with an agent assigned and a note for the embedder. */
  fixing: number[];
  processing: number[];
  cut: number[];
}

/**
 * Everything a working day puts in the database: people, projects, blocks at
 * every stage, a processor run, cut groups, a stain rack walked to imaging,
 * a request on a block that already has glass, notes, flags, an archived and
 * a removed block. `who` tags the rows so each build's writes can be told apart.
 */
export async function runTheLab(app: App, who: string): Promise<LabDay> {
  const db = app.db;

  if ((await db.listUsers()).length === 0) {
    const kg = await step(app, "adding a user", () => db.addUser({ name: "Karim Ghabra", initials: "KG" }));
    await step(app, "adding a second user", () => db.addUser({ name: "Bench Tech", initials: "BT" }));
    await step(app, "signing in", () => db.setActiveUser(kg));
  }
  await step(app, "saving workstation settings", async () => db.saveAppSettings(await db.getAppSettings()));

  const te = await project(app, "TE", "Tendon Engineering");
  const ee = await project(app, "EE", "Enthesis");

  // #136, the captain's own example: blocks still in fixative with SafO
  // assigned. The log has to say so before anything is cut.
  const fixing: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const id = await newSample(app, te, `${who} TE fixing ${i + 1}`, {
      embedding_notes: `${who}: cut face down, proximal left`,
      stains: [["stain", "SafO"]],
    });
    await step(app, "placing in fixative", () => db.updateSampleStage(id, "in_fixative"));
    fixing.push(id);
  }

  // A processor run.
  const processing: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const id = await newSample(app, ee, `${who} EE run ${i + 1}`, { embedding_notes: `${who}: on edge` });
    for (const stage of ["in_fixative", "fixative_removed", "in_ethanol"]) {
      await step(app, `moving to ${stage}`, () => db.updateSampleStage(id, stage));
    }
    processing.push(id);
  }
  await step(app, "starting a processor run", () =>
    db.startProcessingBatch({
      sampleIds: processing,
      processingType: "Short",
      operatorName: "KG",
      startedAt: "2026-09-10 08:30",
      checklistLabels: ["Reagents checked"],
    }),
  );

  // Blocks embedded and cut: an H&E group sent to staining, an unstained group,
  // and the H&E rack taken through to imaging.
  const cut: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const id = await newSample(app, ee, `${who} EE cut ${i + 1}`, { stains: [["stain", "H&E"]] });
    await embed(app, id);
    const sections: number[] = await step(app, "cutting", () =>
      db.createSectionRequests(id, [
        { duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
        { duplicates: 2, stains: "" },
      ]),
    );
    await step(app, "sectioning", () => db.updateSectionStage(sections[0], "sectioned"));
    await step(app, "sending for stain", () => db.updateSectionStage(sections[0], "stain_requested"));
    cut.push(id);
  }
  const rack = (await db.listOpenSlideStacks()).find(
    (s: Any) => s.kind === "stain" && s.assay_name === "H&E" && s.current_stage === "stain_requested",
  );
  if (!rack) throw new Error(`${app.build.label}: sending H&E for stain opened no rack`);
  for (const stage of ["stained", "coverslipped", "ready_for_imaging"]) {
    await step(app, `rack to ${stage}`, () => db.updateSlideStackStage(rack.id, stage));
  }

  // #136's harder case: a block that already has glass for one agent and a
  // second agent still only asked for.
  await step(app, "requesting a second stain on a cut block", () =>
    db.requestStainForSample({ sampleId: cut[0], assayType: "stain", assayName: "SafO" }),
  );

  // Everything else a record carries.
  const slides = await db.listSlidesForSample(cut[1]);
  await step(app, "tagging depth", () => db.setSlidesDepthTag([slides[0].id], "L2", `${who} 200 um`));
  await step(app, "writing sample notes", () => db.setSampleNotes(cut[1], `${who}: re-cut if folded`));
  await step(app, "writing slide notes", () => db.setSlideNotes(slides[0].id, `${who}: small fold`));
  await step(app, "flagging priority", () => db.setSamplePriority(fixing[0], true));

  const archived = await newSample(app, te, `${who} TE archived`);
  await step(app, "archiving", () => db.setSampleArchived(archived, true));
  const exhausted = await newSample(app, te, `${who} TE exhausted`);
  await embed(app, exhausted);
  await step(app, "marking a block exhausted", () => db.setBlockExhausted(exhausted, true));
  const removed = await newSample(app, ee, `${who} EE removed`);
  await step(app, "removing a sample", () => db.removeSample(removed, "entered twice"));

  return { fixing, processing, cut };
}

/**
 * The release's hands on rows this branch wrote: move them, cut them, edit
 * them. Anything a release rewrites wholesale would drop what it cannot see.
 */
export async function workOnRows(app: App, ids: number[], who: string): Promise<void> {
  const db = app.db;
  const [first, second] = ids;
  await embed(app, first);
  const sections: number[] = await step(app, "cutting a block this branch logged", () =>
    db.createSectionRequests(first, [{ duplicates: 1, stains: "SafO", assay_type: "stain", assay_name: "SafO" }]),
  );
  await step(app, "sectioning it", () => db.updateSectionStage(sections[0], "sectioned"));
  const sample = await db.getSample(second);
  await step(app, "editing a sample's details", () =>
    db.updateSampleDetails(second, {
      sample_description: `${sample.sample_description} (${who} edited)`,
      processing_type: sample.processing_type,
      fixative_agent: sample.fixative_agent,
      needs_decalcification: Boolean(sample.needs_decalcification),
      cut_notes: sample.cut_notes ?? "",
      slide_notes: sample.slide_notes ?? "",
      // A release that predates #137 has no idea this field exists and
      // ignores it; this branch writes back what it read.
      embedding_notes: sample.embedding_notes ?? "",
      stains: sample.stains ?? "",
      preselected_stains: [],
      overall_notes: `${who} was here`,
    }),
  );
  await step(app, "setting notes", () => db.setSampleNotes(second, `${who}: checked`));
  await step(app, "archiving and restoring", async () => {
    await db.setSampleArchived(second, true);
    await db.setSampleArchived(second, false);
  });
}

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

export interface Reads {
  /** What every zero-argument list or get reader the data layer exports returned, by name. */
  results: Record<string, unknown>;
  csv: string;
  workbookBytes: number;
}

async function call(failures: string[], label: string, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Everything the board, the drawers, the Logs and the exports read. The
 * zero-argument readers are found, not listed — whatever a build exports as
 * `list…()`/`get…()` gets called — so a reader added in a future release is
 * covered without touching this file. Per-record readers are called for every
 * record when the build has them.
 */
export async function readEverything(app: App): Promise<Reads> {
  const db = app.db;
  const failures: string[] = [];
  const results: Record<string, unknown> = {};

  for (const [name, fn] of Object.entries(db)) {
    if (typeof fn !== "function" || fn.length !== 0 || !/^(list|get)[A-Z]/.test(name)) continue;
    results[name] = await call(failures, `${name}()`, () => fn());
  }

  const perRecord = async (list: unknown, readers: string[]) => {
    for (const record of (list as Array<{ id: number }>) ?? []) {
      for (const reader of readers) {
        if (typeof db[reader] === "function") {
          await call(failures, `${reader}(${record.id})`, () => db[reader](record.id));
        }
      }
    }
  };
  await perRecord(results.listAllSamples, ["getSample", "listSlidesForSample", "listSampleTimelineEvents"]);
  await perRecord(results.listAllSectionRequests, ["getSectionRequest", "listSlidesForSectionRequest"]);
  await perRecord(results.listOpenSlideStacks, ["getSlideStack", "listSlidesForStack", "listStackSampleIds"]);
  await perRecord(results.listAllProcessingBatches, ["getProcessingBatchSamples", "getBatchMemberIds"]);

  // The Logs export, built the way the Logs screen hands it rows.
  const slides = (results.listAllSlides as Array<{ sample_id: number }>) ?? [];
  const rows = ((results.listAllSamples as Array<{ id: number }>) ?? []).map((sample) => ({
    sample,
    slides: slides.filter((s) => s.sample_id === sample.id),
  }));
  const csv = (await call(failures, "buildLogsCsv", async () => app.exporter.buildLogsCsv(rows))) as string;
  if (typeof app.exporter.buildLogsXlsxBytes === "function") {
    await call(failures, "buildLogsXlsxBytes", () => app.exporter.buildLogsXlsxBytes(rows));
  }
  const workbook = (await call(failures, "buildStatusWorkbookBytes", () =>
    app.exporter.buildStatusWorkbookBytes(),
  )) as Uint8Array | undefined;

  if (failures.length) {
    throw new Error(`${app.build.label} could not read the database:\n  ${failures.join("\n  ")}`);
  }
  return { results, csv: csv ?? "", workbookBytes: workbook?.length ?? 0 };
}

/**
 * The stored columns of a record list — what is on disk, as a build reads it
 * back — keyed by id. Two builds reading the same file must agree on these.
 */
export function stored(rows: unknown, columns: string[]): Record<number, Record<string, unknown>> {
  const out: Record<number, Record<string, unknown>> = {};
  for (const row of (rows as Array<Record<string, unknown>>) ?? []) {
    out[row.id as number] = Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]]));
  }
  return out;
}
