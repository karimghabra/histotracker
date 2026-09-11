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

/** Steps a release was too old to take, reported once at the end of a run. */
export const skippedSteps = new Set<string>();

/**
 * Call the build's own `fn`. A release that predates it skips the step and
 * says so, which is what lets one lab run against any release; this branch
 * must have every function the lab uses, or the lab is out of date.
 */
async function act(app: App, what: string, fn: string, ...args: unknown[]): Promise<Any> {
  if (typeof app.db[fn] !== "function") {
    if (app.build.ref === "working tree") {
      throw new Error(`this branch's data layer has no ${fn}() — update tests/compat/lab.ts (${what})`);
    }
    skippedSteps.add(`${app.build.label} has no ${fn}(), so it skipped ${what}`);
    return undefined;
  }
  try {
    return await app.db[fn](...args);
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

async function embed(app: App, sampleId: number): Promise<void> {
  for (const stage of EMBED_PATH) {
    await act(app, `moving sample ${sampleId} to ${stage}`, "updateSampleStage", sampleId, stage);
  }
}

async function project(app: App, code: string, name: string): Promise<Any> {
  const find = async () => ((await act(app, "listing projects", "listProjects")) as Any[]).find((p) => p.code === code);
  const existing = await find();
  if (existing) return existing;
  await act(app, `adding project ${code}`, "addProject", { code, name, team_lead: "", is_active: true, lead_user_id: 0 });
  return find();
}

async function newSample(
  app: App,
  proj: Any,
  description: string,
  opts: { embedding_notes?: string; stains?: Array<[string, string]> } = {},
): Promise<number> {
  return act(
    app,
    `adding sample "${description}"`,
    "addSample",
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
  );
}

export interface LabDay {
  /** Blocks in fixative with an agent assigned and a note for the embedder. */
  fixing: number[];
}

/**
 * Everything a working day puts in the database: people, projects, blocks at
 * every stage, a processor run, cut groups, a stain rack walked to imaging,
 * a request on a block that already has glass, notes, flags, an archived and
 * a removed block. `who` tags the rows so each build's writes can be told apart.
 */
export async function runTheLab(app: App, who: string): Promise<LabDay> {
  if (((await act(app, "listing users", "listUsers")) ?? []).length === 0) {
    const kg = await act(app, "adding a user", "addUser", { name: "Karim Ghabra", initials: "KG" });
    await act(app, "adding a second user", "addUser", { name: "Bench Tech", initials: "BT" });
    await act(app, "signing in", "setActiveUser", kg);
  }
  const settings = await act(app, "reading settings", "getAppSettings");
  if (settings) await act(app, "saving workstation settings", "saveAppSettings", settings);

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
    await act(app, "placing in fixative", "updateSampleStage", id, "in_fixative");
    fixing.push(id);
  }

  // A processor run.
  const run: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const id = await newSample(app, ee, `${who} EE run ${i + 1}`, { embedding_notes: `${who}: on edge` });
    for (const stage of ["in_fixative", "fixative_removed", "in_ethanol"]) {
      await act(app, `moving to ${stage}`, "updateSampleStage", id, stage);
    }
    run.push(id);
  }
  await act(app, "starting a processor run", "startProcessingBatch", {
    sampleIds: run,
    processingType: "Short",
    operatorName: "KG",
    startedAt: "2026-09-10 08:30",
    checklistLabels: ["Reagents checked"],
  });

  // Blocks embedded and cut: an H&E group sent to staining, an unstained group,
  // and the H&E rack taken through to imaging.
  const cut: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const id = await newSample(app, ee, `${who} EE cut ${i + 1}`, { stains: [["stain", "H&E"]] });
    await embed(app, id);
    const sections: number[] = await act(app, "cutting", "createSectionRequests", id, [
      { duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
      { duplicates: 2, stains: "" },
    ]);
    await act(app, "sectioning", "updateSectionStage", sections[0], "sectioned");
    await act(app, "sending for stain", "updateSectionStage", sections[0], "stain_requested");
    cut.push(id);
  }
  const stacks: Any[] = (await act(app, "listing racks", "listOpenSlideStacks")) ?? [];
  const rack = stacks.find((s) => s.kind === "stain" && s.assay_name === "H&E" && s.current_stage === "stain_requested");
  if (!rack && typeof app.db.listOpenSlideStacks === "function") {
    throw new Error(`${app.build.label}: sending H&E for stain opened no rack`);
  }
  for (const stage of rack ? ["stained", "coverslipped", "ready_for_imaging"] : []) {
    await act(app, `moving the rack to ${stage}`, "updateSlideStackStage", rack.id, stage);
  }

  // #136's harder case: a block that already has glass for one agent and a
  // second agent still only asked for.
  await act(app, "requesting a second stain on a cut block", "requestStainForSample", {
    sampleId: cut[0],
    assayType: "stain",
    assayName: "SafO",
  });

  // Everything else a record carries.
  const slides: Any[] = (await act(app, "listing a block's slides", "listSlidesForSample", cut[1])) ?? [];
  if (slides[0]) {
    await act(app, "tagging depth", "setSlidesDepthTag", [slides[0].id], "L2", `${who} 200 um`);
    await act(app, "writing slide notes", "setSlideNotes", slides[0].id, `${who}: small fold`);
  }
  await act(app, "writing sample notes", "setSampleNotes", cut[1], `${who}: re-cut if folded`);
  await act(app, "flagging priority", "setSamplePriority", fixing[0], true);

  await act(app, "archiving", "setSampleArchived", await newSample(app, te, `${who} TE archived`), true);
  const exhausted = await newSample(app, te, `${who} TE exhausted`);
  await embed(app, exhausted);
  await act(app, "marking a block exhausted", "setBlockExhausted", exhausted, true);
  await act(app, "removing a sample", "removeSample", await newSample(app, ee, `${who} EE removed`), "entered twice");

  return { fixing };
}

/**
 * The release's hands on rows this branch wrote: move them, cut them, edit
 * them. Anything a release rewrites wholesale would drop what it cannot see.
 */
export async function workOnRows(app: App, ids: number[], who: string): Promise<void> {
  const [first, second] = ids;
  await embed(app, first);
  const sections: number[] = await act(app, "cutting a block this branch logged", "createSectionRequests", first, [
    { duplicates: 1, stains: "SafO", assay_type: "stain", assay_name: "SafO" },
  ]);
  await act(app, "sectioning it", "updateSectionStage", sections[0], "sectioned");
  const sample = await act(app, "reading a sample", "getSample", second);
  // What the edit dialog sends back: every field it shows. A release that
  // predates #137 has no embedding_notes field and ignores it if handed one.
  await act(app, "editing a sample's details", "updateSampleDetails", second, {
    sample_description: `${sample.sample_description} (${who} edited)`,
    processing_type: sample.processing_type,
    fixative_agent: sample.fixative_agent,
    needs_decalcification: Boolean(sample.needs_decalcification),
    cut_notes: sample.cut_notes ?? "",
    slide_notes: sample.slide_notes ?? "",
    embedding_notes: sample.embedding_notes ?? "",
    stains: sample.stains ?? "",
    preselected_stains: [],
    overall_notes: `${who} was here`,
  });
  await act(app, "setting notes", "setSampleNotes", second, `${who}: checked`);
  await act(app, "archiving", "setSampleArchived", second, true);
  await act(app, "restoring from the archive", "setSampleArchived", second, false);
}

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

export interface Reads {
  /** What every zero-argument list or get reader the data layer exports returned, by name. */
  results: Record<string, unknown>;
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
  const { db, exporter } = app;
  const failures: string[] = [];
  const results: Record<string, unknown> = {};

  for (const [name, fn] of Object.entries(db)) {
    if (typeof fn !== "function" || fn.length !== 0 || !/^(list|get)[A-Z]/.test(name)) continue;
    results[name] = await call(failures, `${name}()`, () => fn());
  }

  const perRecord = async (list: unknown, readers: string[]) => {
    for (const record of (list as Array<{ id: number }>) ?? []) {
      for (const reader of readers.filter((r) => typeof db[r] === "function")) {
        await call(failures, `${reader}(${record.id})`, () => db[reader](record.id));
      }
    }
  };
  await perRecord(results.listAllSamples, ["getSample", "listSlidesForSample", "listSampleTimelineEvents"]);
  await perRecord(results.listAllSectionRequests, ["getSectionRequest", "listSlidesForSectionRequest"]);
  await perRecord(results.listOpenSlideStacks, ["getSlideStack", "listSlidesForStack", "listStackSampleIds"]);
  await perRecord(results.listAllProcessingBatches, ["getProcessingBatchSamples", "getBatchMemberIds"]);

  // The Logs export as the Logs screen hands it rows, and the full workbook
  // the sync publishes alongside the database.
  const slides = (results.listAllSlides as Array<{ sample_id: number }>) ?? [];
  const rows = ((results.listAllSamples as Array<{ id: number }>) ?? []).map((sample) => ({
    sample,
    slides: slides.filter((s) => s.sample_id === sample.id),
  }));
  for (const [name, args] of [
    ["buildLogsCsv", [rows]],
    ["buildLogsXlsxBytes", [rows]],
    ["buildStatusWorkbookBytes", []],
  ] as const) {
    if (typeof exporter[name] === "function") await call(failures, name, async () => exporter[name](...args));
  }

  if (failures.length) {
    throw new Error(`${app.build.label} could not read the database:\n  ${failures.join("\n  ")}`);
  }
  return { results };
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
