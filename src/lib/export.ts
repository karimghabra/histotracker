import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import writeXlsxFile from "write-excel-file/browser";
import {
  listAllProcessingBatches,
  listAllSamples,
  listAllSectionRequests,
  listAllSlides,
  listProjects,
} from "./db";
import type { ProcessingBatch, Project, Sample, SectionRequest, Slide } from "./types";
import { BLOCK_TIMELINE_STAGES } from "./stages";
import { duplicateLabel, todayIso } from "./utils";

type Accessor<T> = (row: T) => string;

// Ordered column definitions shared by the CSV and XLSX sample exports.
export const SAMPLE_COLUMNS: Array<[string, Accessor<Sample>]> = [
  ["Project", (s) => s.project_code ?? ""],
  ["Sample ID", (s) => s.sample_code],
  ["Description", (s) => s.sample_description],
  ["Date Added", (s) => s.date_added],
  ["Processing", (s) => s.processing_type],
  ["Fixative", (s) => s.fixative_agent],
  ["Needs Decalc", (s) => (s.needs_decalcification ? "Yes" : "No")],
  ["Priority", (s) => (s.is_priority ? "Yes" : "No")],
  ["Current Stage", (s) => s.current_stage],
  // Block-level physical events only — the downstream slide stages (Stained,
  // Deparaffinized, Imaged, …) are never stamped on a block, so they'd be empty
  // columns here; they live in the Slides / Cut Orders sheets.
  ...BLOCK_TIMELINE_STAGES.map(
    (stage): [string, Accessor<Sample>] => [
      stage.label,
      (s) => (s as unknown as Record<string, string | null>)[stage.column] ?? "",
    ],
  ),
  ["Cut Notes", (s) => s.cut_notes],
  ["Slide Notes", (s) => s.slide_notes],
  ["Stains / IHC", (s) => s.stains],
  ["General Notes", (s) => s.overall_notes],
  ["Sectioning Plan", (s) => s.sectioning_plan],
];

const PROJECT_COLUMNS: Array<[string, Accessor<Project>]> = [
  ["Code", (p) => p.code],
  ["Name", (p) => p.name],
  ["Team Lead", (p) => p.team_lead],
  ["Status", (p) => (p.is_active ? "Active" : "Inactive")],
  ["Samples", (p) => String(p.sample_count ?? 0)],
  ["Created", (p) => p.created_at],
];

const SECTION_COLUMNS: Array<[string, Accessor<SectionRequest>]> = [
  ["Project", (row) => row.project_code ?? ""],
  ["Sample ID", (row) => row.parent_code ?? ""],
  ["Duplicates", (row) => String(row.duplicates)],
  ["Current Stage", (row) => row.current_stage],
  ["Requested Stains", (row) => row.stains || row.parent_stains || ""],
  ["Needs Sectioning", (row) => row.stage_needs_sectioning_at ?? ""],
  ["Sectioned", (row) => row.stage_sectioned_at ?? ""],
  ["Stain Requested", (row) => row.stage_stain_requested_at ?? ""],
  ["Stained", (row) => row.stage_stained_at ?? ""],
  ["IHC Complete", (row) => row.stage_ihc_at ?? ""],
  ["Coverslipped", (row) => row.stage_coverslipped_at ?? ""],
  ["Dried", (row) => row.stage_dried_at ?? ""],
  ["Ready for Imaging", (row) => row.stage_ready_for_imaging_at ?? ""],
  ["Pictures Taken", (row) => row.stage_pictures_taken_at ?? ""],
  ["Analyzed", (row) => row.stage_analyzed_at ?? ""],
  ["Notes", (row) => row.notes],
];

export const SLIDE_COLUMNS: Array<[string, Accessor<Slide>]> = [
  ["Project", (row) => row.project_code ?? ""],
  ["Sample ID", (row) => row.parent_code ?? ""],
  ["Slide ID", (row) => row.slide_code],
  ["Duplicate", (row) => duplicateLabel(row.slide_ordinal)],
  ["Purpose", (row) => row.purpose],
  ["Slices", (row) => String(row.slice_count)],
  ["Control Slice", (row) => row.control_agent],
  ["Assay Type", (row) => row.assay_type.toUpperCase()],
  ["Target Assay", (row) => row.assay_name || row.stain_name],
  ["Current Stage", (row) => row.current_stage],
  ["Cut", (row) => row.stage_cut_at ?? ""],
  ["Stain Requested", (row) => row.stage_stain_requested_at ?? ""],
  ["Stained", (row) => row.stage_stained_at ?? ""],
  ["Coverslipped", (row) => row.stage_coverslipped_at ?? ""],
  ["Dried", (row) => row.stage_dried_at ?? ""],
  ["Ready for Imaging", (row) => row.stage_ready_for_imaging_at ?? ""],
  ["Pictures Taken", (row) => row.stage_pictures_taken_at ?? ""],
  ["Analyzed", (row) => row.stage_analyzed_at ?? ""],
  ["Location", (row) => row.location],
  ["Notes", (row) => row.notes],
];

const BATCH_COLUMNS: Array<[string, Accessor<ProcessingBatch>]> = [
  ["Batch ID", (row) => String(row.id)],
  ["Processing", (row) => row.processing_type],
  ["Operator", (row) => row.operator_name],
  ["Status", (row) => row.status],
  ["Started", (row) => row.started_at],
  ["Ready", (row) => row.ready_at ?? ""],
  ["Collected", (row) => row.collected_at ?? ""],
  ["Completed", (row) => row.completed_at ?? ""],
  ["Members", (row) => row.member_codes.join(", ")],
  ["Checklist", (row) => `${row.checklist_completed}/${row.checklist_total}`],
  ["Notes", (row) => row.notes],
];

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function toCsv<T>(rows: T[], columns: Array<[string, Accessor<T>]>): string {
  const header = columns.map(([h]) => csvCell(h)).join(",");
  const body = rows.map((r) => columns.map(([, fn]) => csvCell(fn(r))).join(",")).join("\n");
  return `${header}\n${body}\n`;
}

async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await invoke("save_file", { path, contents: Array.from(bytes) });
}

/** Export all samples as a single CSV file. Returns the saved path, or null if cancelled. */
export async function exportSamplesCsv(): Promise<string | null> {
  const samples = await listAllSamples();
  const path = await save({
    defaultPath: `histometer-samples-${todayIso()}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!path) return null;
  const csv = toCsv(samples, SAMPLE_COLUMNS);
  await writeBytes(path, new TextEncoder().encode(csv));
  return path;
}

// ---- Logs view export (one row per slide, with sample context) ---------------

export type LogExportRow = { sample: Sample; slides: Slide[] };

// Slides cut before local stamping only have the UTC created_at; use it as a
// fallback so the Cut column is never blank (mirrors the Logs slide timeline).
const slideCutAt = (sl: Slide): string => sl.stage_cut_at ?? sl.created_at ?? "";

const LOGS_HEADERS = [
  "Project", "Sample ID", "Description", "Sample Stage", "Date Added",
  "Slide", "Assay Type", "Stain / IHC", "Slide Stage",
  "Cut", "Stained", "Coverslipped", "Imaged", "Analyzed",
  "Slide Notes", "Sample Notes",
];

// One array of cells (in LOGS_HEADERS order) per exported line — one row per
// slide, plus a single row for a sample with no slides. Shared by CSV and XLSX.
function logRowCells(rows: LogExportRow[]): string[][] {
  const out: string[][] = [];
  for (const { sample, slides } of rows) {
    const base = [
      sample.project_code ?? "",
      sample.sample_code,
      sample.sample_description ?? "",
      sample.current_stage ?? "",
      (sample.date_added ?? "").slice(0, 10),
    ];
    if (slides.length === 0) {
      out.push([...base, "", "", "", "", "", "", "", "", "", sample.overall_notes ?? ""]);
      continue;
    }
    for (const sl of slides) {
      out.push([
        ...base,
        sl.slide_code ?? "",
        sl.assay_type ?? "",
        sl.assay_name || (sl.purpose === "extra" ? "Extra" : ""),
        sl.current_stage ?? "",
        slideCutAt(sl),
        sl.stage_stained_at ?? "",
        sl.stage_coverslipped_at ?? "",
        sl.stage_pictures_taken_at ?? "",
        sl.stage_analyzed_at ?? "",
        sl.notes ?? "",
        sample.overall_notes ?? "",
      ]);
    }
  }
  return out;
}

/**
 * Build the Logs CSV — one row per slide, mirroring what the Logs table shows
 * (including the per-slide timeline stamps). Pure and order-preserving so it can
 * be unit tested and so it honours the caller's current filter/sort.
 */
export function buildLogsCsv(rows: LogExportRow[]): string {
  const lines = [LOGS_HEADERS.map(csvCell).join(",")];
  for (const cells of logRowCells(rows)) lines.push(cells.map(csvCell).join(","));
  return `${lines.join("\n")}\n`;
}

/** Save the (already filtered/sorted) Logs rows as a CSV via the native dialog. */
export async function saveLogsCsv(rows: LogExportRow[]): Promise<string | null> {
  const path = await save({
    defaultPath: `histometer-logs-${todayIso()}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!path) return null;
  await writeBytes(path, new TextEncoder().encode(buildLogsCsv(rows)));
  return path;
}

/** Save the same Logs rows as a single-sheet XLSX workbook. */
export async function saveLogsXlsx(rows: LogExportRow[]): Promise<string | null> {
  const path = await save({
    defaultPath: `histometer-logs-${todayIso()}.xlsx`,
    filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
  });
  if (!path) return null;
  const objects = logRowCells(rows).map((cells) =>
    Object.fromEntries(LOGS_HEADERS.map((h, i) => [h, cells[i] ?? ""])),
  );
  const schema = LOGS_HEADERS.map((column) => ({
    column,
    type: String,
    value: (r: Record<string, string>) => r[column],
  }));
  // Use the same multi-sheet overload as exportWorkbookXlsx (a single "Log"
  // sheet); the single-sheet `{ schema }` form is rejected by this version.
  const write = writeXlsxFile as unknown as (
    data: unknown[],
    opts: { schema: unknown[]; sheets: string[] },
  ) => { toBlob: () => Promise<Blob> };
  const blob = await write([objects], { schema: [schema], sheets: ["Log"] }).toBlob();
  await writeBytes(path, new Uint8Array(await blob.arrayBuffer()));
  return path;
}

/** Export a normalized workbook with Projects and Samples sheets. */
export async function exportWorkbookXlsx(): Promise<string | null> {
  const [projects, samples, sections, slides, batches] = await Promise.all([
    listProjects(false),
    listAllSamples(),
    listAllSectionRequests(),
    listAllSlides(),
    listAllProcessingBatches(),
  ]);
  const path = await save({
    defaultPath: `histometer-${todayIso()}.xlsx`,
    filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
  });
  if (!path) return null;

  const projectSchema = PROJECT_COLUMNS.map(([column, fn]) => ({
    column,
    type: String,
    value: (p: Project) => fn(p),
  }));
  const sampleSchema = SAMPLE_COLUMNS.map(([column, fn]) => ({
    column,
    type: String,
    value: (s: Sample) => fn(s),
  }));
  const sectionSchema = SECTION_COLUMNS.map(([column, fn]) => ({
    column,
    type: String,
    value: (row: SectionRequest) => fn(row),
  }));
  const slideSchema = SLIDE_COLUMNS.map(([column, fn]) => ({
    column,
    type: String,
    value: (row: Slide) => fn(row),
  }));
  const batchSchema = BATCH_COLUMNS.map(([column, fn]) => ({
    column,
    type: String,
    value: (row: ProcessingBatch) => fn(row),
  }));

  // write-excel-file's multi-sheet browser overload returns a { toBlob, toFile }
  // handle (NOT a Blob directly); its types don't model that overload cleanly,
  // so we call through a narrow signature and take the blob via toBlob().
  const write = writeXlsxFile as unknown as (
    data: unknown[],
    opts: { schema: unknown[]; sheets: string[] },
  ) => { toBlob: () => Promise<Blob> };

  const blob = await write([projects, samples, sections, slides, batches], {
    schema: [projectSchema, sampleSchema, sectionSchema, slideSchema, batchSchema],
    sheets: ["Projects", "Samples", "Cut Orders", "Slides", "Processing Batches"],
  }).toBlob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeBytes(path, bytes);
  return path;
}

// ---- Shared-sync status workbook (published alongside the DB snapshot) -------

// Bold, tinted, frozen header row so the SharePoint/at-a-glance workbook reads
// cleanly without any filtering applied.
const STATUS_HEADER_STYLE = {
  fontWeight: "bold" as const,
  backgroundColor: "#EEF2F7",
  align: "left" as const,
};

function statusSheetRows<T>(rows: T[], columns: Array<[string, Accessor<T>]>): unknown[] {
  const header = columns.map(([label]) => ({ value: label, ...STATUS_HEADER_STYLE }));
  const body = rows.map((row) => columns.map(([, fn]) => fn(row)));
  return [header, ...body];
}

/**
 * Build the human-facing 2-sheet status workbook ("Sample Status", "Slide
 * Status") as raw bytes, so the sync layer can upload it as a release asset
 * without going through the save dialog. Reuses the CSV/XLSX column sets.
 */
export async function buildStatusWorkbookBytes(): Promise<Uint8Array> {
  const [samples, slides] = await Promise.all([listAllSamples(), listAllSlides()]);

  const sheets = [
    { data: statusSheetRows(samples, SAMPLE_COLUMNS), sheet: "Sample Status", stickyRowsCount: 1 },
    { data: statusSheetRows(slides, SLIDE_COLUMNS), sheet: "Slide Status", stickyRowsCount: 1 },
  ];

  // The multi-sheet browser overload takes an array of { data, sheet, ... } and
  // returns a { toBlob, toFile } handle (NOT a Blob directly); its types don't
  // model this overload cleanly, so we call through a narrow signature and take
  // the blob via toBlob() (same approach as exportWorkbookXlsx above).
  const write = writeXlsxFile as unknown as (
    sheets: unknown[],
  ) => { toBlob: () => Promise<Blob> };
  const blob = await write(sheets).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}
