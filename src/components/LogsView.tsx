import { useEffect, useMemo, useState } from "react";
import { Archive, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Download, Search, Send, Star, Tag } from "lucide-react";
import type { Sample, Slide } from "../lib/types";
import type { SampleRemoval, SlideRemoval } from "../lib/db";
import { Button, Field, Modal, TextArea, TextInput } from "./ui";
import { useActions } from "../hooks/useActions";
import { saveLogsCsv, saveLogsXlsx } from "../lib/export";
import { useAllSamples, useAllSlides, useAssayCatalog, useSampleRemovals, useSlideRemovals } from "../hooks/useData";
import { BLOCK_TIMELINE_STAGES, SECTION_STAGE_LABELS, STAGE_LABELS, STAGE_ORDER } from "../lib/stages";
import { cn, compareSlideCodes, displayCode, sampleCodeVariants, slideCutAt } from "../lib/utils";
import { useReadOnly } from "../lib/readOnly";

// A sample's coarse position in the lab pipeline, derived from its slides (which
// hold the accurate per-stage stamps) and — before any slides exist — its own
// block stage. This one categorisation drives the Stage column, the stage
// filter, and stage sorting.
type PhaseKey = "preprocessing" | "embedded" | "sectioned" | "staining" | "imaging" | "analyzed";
const LOG_PHASES: Array<{ key: PhaseKey; label: string }> = [
  { key: "preprocessing", label: "Pre-processing" },
  { key: "embedded", label: "Embedded" },
  { key: "sectioned", label: "Sectioned" },
  { key: "staining", label: "Staining / IHC" },
  { key: "imaging", label: "Imaging" },
  { key: "analyzed", label: "Analyzed" },
];
const PHASE_LABEL: Record<PhaseKey, string> = Object.fromEntries(
  LOG_PHASES.map((p) => [p.key, p.label]),
) as Record<PhaseKey, string>;
const PHASE_RANK: Record<PhaseKey, number> = Object.fromEntries(
  LOG_PHASES.map((p, i) => [p.key, i]),
) as Record<PhaseKey, number>;

/**
 * A slide that was removed at the bench (#83). It keeps its row and stays
 * visible here — that is the whole point — but it is no longer work in progress,
 * so it must not count towards the sample's phase or its analyzed fraction.
 */
function isRemoved(slide: Slide): boolean {
  return slide.current_stage === "removed";
}

function samplePhase(sample: Sample, slides: Slide[]): PhaseKey {
  const live = slides.filter((s) => !isRemoved(s));
  const assay = live.filter((s) => s.purpose !== "extra");
  if (assay.length > 0 && assay.every((s) => Boolean(s.stage_analyzed_at))) return "analyzed";
  if (assay.some((s) => s.stage_ready_for_imaging_at || s.stage_pictures_taken_at)) return "imaging";
  if (assay.some((s) => s.stage_stained_at || s.stage_coverslipped_at || s.stage_dried_at)) return "staining";
  // `live`, not `slides`: a sample whose only slide was removed has no slides at
  // the bench any more, so it reads by its block stage again rather than being
  // pinned at "Sectioned" forever.
  if (live.length > 0) return "sectioned";
  return (STAGE_ORDER[sample.current_stage] ?? 0) >= (STAGE_ORDER.embedded ?? 99) ? "embedded" : "preprocessing";
}

// Per-slide timestamp columns that count as "activity" (created_at is UTC and the
// rest local, so it's excluded to keep the derived "last activity" consistent).
const SLIDE_TS_COLUMNS: Array<keyof Slide> = [
  "stage_cut_at", "stage_stained_at", "stage_coverslipped_at", "stage_dried_at",
  "stage_ready_for_imaging_at", "stage_pictures_taken_at", "stage_analyzed_at",
];
const BLOCK_TS_COLUMNS = BLOCK_TIMELINE_STAGES.map((s) => s.column);

function lastActivityOf(sample: Sample, slides: Slide[]): string {
  let latest = "";
  const consider = (v: unknown) => {
    if (typeof v === "string" && v > latest) latest = v;
  };
  for (const col of BLOCK_TS_COLUMNS) consider((sample as unknown as Record<string, unknown>)[col]);
  for (const slide of slides) {
    for (const col of SLIDE_TS_COLUMNS) consider(slide[col]);
  }
  return latest;
}

// Analyzed progress across a sample's assay slides (extras never analyze, and a
// removed slide never will either — leaving it in the denominator would strand
// the sample at 3/4 for good, #83).
function analyzedProgress(slides: Slide[]): { done: number; total: number } {
  const assay = slides.filter((s) => s.purpose !== "extra" && !isRemoved(s));
  return { done: assay.filter((s) => Boolean(s.stage_analyzed_at)).length, total: assay.length };
}

// A slide's own lifecycle, built from its per-slide timestamps (these are always
// accurate — unlike the aggregate stack, a slide keeps its own stamps through
// rack scatter/merge). Condensed to the milestones that matter.
// Cut is NOT in this list: whether a slide has been cut is a rule, not a column
// (#95) — see slideCutAt. The rest are plain stamps.
const SLIDE_TIMELINE: Array<{ label: string; column: keyof Slide; fallback?: keyof Slide }> = [
  { label: "Stained", column: "stage_stained_at" },
  { label: "Coverslipped", column: "stage_coverslipped_at" },
  { label: "Imaged", column: "stage_pictures_taken_at" },
];

/** The slide timeline, with the derived Cut step in front when it happened. */
function slideEvents(slide: Slide): Array<{ label: string; at: string }> {
  const cut = slideCutAt(slide);
  const rest = recordedEvents(slide as unknown as Record<string, unknown>, SLIDE_TIMELINE);
  return cut ? [{ label: "Cut", at: cut }, ...rest] : rest;
}

function fmtTime(at: string): string {
  return at.length >= 16 ? at.slice(5, 16) : at; // "2026-07-25 07:28" -> "07-25 07:28"
}

/** Only the steps that actually happened (have a timestamp), in order. */
function recordedEvents(
  row: Record<string, unknown>,
  steps: Array<{ label: string; column: string; fallback?: string }>,
): Array<{ label: string; at: string }> {
  return steps
    .map((s) => ({
      label: s.label,
      at: (row[s.column] ?? (s.fallback ? row[s.fallback] : null)) as string | null,
    }))
    .filter((e): e is { label: string; at: string } => Boolean(e.at));
}

// Even, tab-separated columns — the step label on top, its time underneath — so
// a column's width never depends on the timestamp.
function Timeline({ events }: { events: Array<{ label: string; at: string }> }) {
  if (events.length === 0)
    return <span className="text-[10px] text-ink-faint">No events recorded yet.</span>;
  return (
    <div className="flex flex-wrap gap-x-7 gap-y-2">
      {events.map((e, i) => (
        <div key={i} className="flex min-w-[4.5rem] flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
            {e.label}
          </span>
          <span className="pl-3 text-[10px] tabular-nums text-ink-faint">{fmtTime(e.at)}</span>
        </div>
      ))}
    </div>
  );
}

type SortKey = "sample" | "description" | "project" | "processing" | "stage" | "stains" | "slides" | "added" | "updated";

function slideStage(stage: string): string {
  if (stage === "extra") return "Extra (inventory)";
  return SECTION_STAGE_LABELS[stage] ?? STAGE_LABELS[stage] ?? stage;
}
function agentLabel(slide: Slide): string {
  if (slide.assay_name) return slide.assay_name;
  if (slide.purpose === "extra") return "Extra";
  return "—";
}

// Free-text notes with a save-on-blur textarea (only writes when changed).
function NotesEditor({
  value,
  placeholder,
  onSave,
  rows = 2,
  ariaLabel,
}: {
  value: string;
  placeholder: string;
  onSave: (notes: string) => void;
  rows?: number;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(value ?? "");
  const [focused, setFocused] = useState(false);
  // A viewer READS notes; it must not appear to edit them. Gating here covers
  // every use of this editor — the description, sample notes and slide notes —
  // rather than three separate call-site checks, one of which would be missed
  // (#72). Left editable, typing was accepted and silently discarded on blur.
  const readOnly = useReadOnly();
  // Adopt external changes only while not editing, so a refetch can't clobber typing.
  useEffect(() => {
    if (!focused) setText(value ?? "");
  }, [value, focused]);
  return (
    <textarea
      aria-label={ariaLabel}
      value={text}
      rows={rows}
      readOnly={readOnly}
      title={readOnly ? "Read-only viewer — edited on the workstation" : undefined}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (readOnly) return;
        if (text !== (value ?? "")) onSave(text);
      }}
      className="w-full resize-y rounded-md border border-line bg-white px-2 py-1 text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-brand"
    />
  );
}

// Multi-select workflow-stage filter as a native disclosure (no outside-click
// wiring needed). Empty selection = all stages.
function StageFilter({ selected, onToggle }: { selected: Set<PhaseKey>; onToggle: (k: PhaseKey) => void }) {
  const label = selected.size === 0 ? "All stages" : `${selected.size} stage${selected.size > 1 ? "s" : ""}`;
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md border border-line bg-white px-2 py-1 text-xs text-ink [&::-webkit-details-marker]:hidden">
        {label}
        <ChevronDown size={12} className="text-ink-faint" />
      </summary>
      <div className="absolute z-20 mt-1 w-44 rounded-md border border-line bg-white p-1 shadow-lg">
        {LOG_PHASES.map((p) => (
          <label
            key={p.key}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-ink hover:bg-brand/5"
          >
            <input
              type="checkbox"
              checked={selected.has(p.key)}
              onChange={() => onToggle(p.key)}
              className="h-3.5 w-3.5 accent-[var(--color-brand)]"
            />
            {p.label}
          </label>
        ))}
      </div>
    </details>
  );
}

export function LogsView({ onRequestStain }: { onRequestStain?: (sampleCode: string) => void } = {}) {
  const { tagSlidesDepth } = useActions();
  const readOnly = useReadOnly();
  const [selectedSlideIds, setSelectedSlideIds] = useState<Set<number>>(new Set());
  const [showDepthDialog, setShowDepthDialog] = useState(false);
  const toggleSlideSelect = (id: number) =>
    setSelectedSlideIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const { data: samples = [] } = useAllSamples();
  const { data: slides = [] } = useAllSlides();
  const { data: catalog = [] } = useAssayCatalog(true);
  const { data: removalList = [] } = useSlideRemovals();
  const removals = useMemo(
    () => new Map(removalList.map((entry) => [entry.slide_id, entry])),
    [removalList],
  );
  // Blocks removed from the board keep their row here, flagged, with the
  // reason — the same treatment their slides get (#96).
  const { data: sampleRemovalList = [] } = useSampleRemovals();
  const sampleRemovals = useMemo(
    () => new Map(sampleRemovalList.map((entry) => [entry.sample_id, entry])),
    [sampleRemovalList],
  );

  const [project, setProject] = useState("all");
  const [stain, setStain] = useState("all");
  const [assayType, setAssayType] = useState<"all" | "stain" | "ihc">("all");
  const [onlyMatching, setOnlyMatching] = useState(false);
  const [phases, setPhases] = useState<Set<PhaseKey>>(new Set());
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("sample");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  // Archived samples are hidden by default and can be shown on demand (#74).
  const [showArchived, setShowArchived] = useState(false);
  const phasesKey = [...phases].join(",");
  useEffect(() => setExportMsg(null), [project, stain, assayType, phasesKey, fromDate, toDate, search]);

  const slidesBySample = useMemo(() => {
    const map = new Map<string, Slide[]>();
    for (const slide of slides) {
      const key = slide.parent_code ?? "";
      const list = map.get(key);
      if (list) list.push(slide);
      else map.set(key, [slide]);
    }
    // Slides arrive in insertion order, which drifts as extras are assigned and
    // re-parented. Sort each sample's slides by code so the log always reads
    // A, B, C… (issue #75). Done here so the table, the drill-down, and the
    // CSV/Excel exports (which all read this map) agree.
    for (const list of map.values()) {
      list.sort((a, b) => compareSlideCodes(a.slide_code, b.slide_code));
    }
    return map;
  }, [slides]);

  const projectCodes = useMemo(
    () => [...new Set(samples.map((s) => s.project_code).filter(Boolean) as string[])].sort(),
    [samples],
  );
  const stainNames = useMemo(
    () => [...new Set(catalog.map((c) => c.name))].sort((a, b) => a.localeCompare(b)),
    [catalog],
  );

  const rows = useMemo(
    () =>
      samples.map((sample) => {
        const slidesForSample = slidesBySample.get(sample.sample_code) ?? [];
        const agents = [...new Set(slidesForSample.map((s) => s.assay_name).filter(Boolean))];
        const phase = samplePhase(sample, slidesForSample);
        const progress = analyzedProgress(slidesForSample);
        // Removed slides are listed in the drill-down but are not inventory, so
        // they are excluded from both the "N slides" column and the extras
        // arithmetic — otherwise a removed assay slide silently reappeared as an
        // extra (#83).
        const removedCount = slidesForSample.filter(isRemoved).length;
        const extras = slidesForSample.length - removedCount - progress.total;
        const hasNotes =
          Boolean(sample.overall_notes?.trim()) || slidesForSample.some((s) => Boolean(s.notes?.trim()));
        return {
          sample,
          slides: slidesForSample,
          agents,
          phase,
          progress,
          extras,
          removedCount,
          hasNotes,
          lastActivity: lastActivityOf(sample, slidesForSample),
        };
      }),
    [samples, slidesBySample],
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      const { sample, slides: sampleSlides, agents, phase } = row;
      // Archived samples stay out of the way unless explicitly asked for (#74).
      if (!showArchived && sample.archived_at) return false;
      if (project !== "all" && sample.project_code !== project) return false;
      if (phases.size > 0 && !phases.has(phase)) return false;
      if (assayType !== "all" && !sampleSlides.some((s) => s.assay_type === assayType)) return false;
      if (stain !== "all" && !agents.some((a) => a.toLowerCase() === stain.toLowerCase())) return false;
      const added = (sample.date_added || "").slice(0, 10);
      if (fromDate && added && added < fromDate) return false;
      if (toDate && added && added > toDate) return false;
      if (query) {
        const hay = [
          sample.sample_code,
          // Both spellings, so searching "EE-0001" still finds "EE-1" and vice
          // versa — the number on the physical block may be written either way
          // depending on when it was cut (#87).
          ...sampleCodeVariants(sample.sample_code),
          sample.sample_description,
          sample.project_code,
          sample.project_name,
          sample.overall_notes,
          ...agents,
          ...sampleSlides.map((s) => s.slide_code),
          ...sampleSlides.map((s) => s.notes),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }, [rows, project, phases, assayType, stain, fromDate, toDate, search, showArchived]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const sa = a.sample;
      const sb = b.sample;
      let cmp = 0;
      switch (sortKey) {
        case "sample":
          cmp =
            (sa.project_code ?? "").localeCompare(sb.project_code ?? "") ||
            (sa.project_sample_number ?? 0) - (sb.project_sample_number ?? 0);
          break;
        case "description":
          cmp = (sa.sample_description || "").localeCompare(sb.sample_description || "");
          break;
        case "project":
          cmp = (sa.project_code || "").localeCompare(sb.project_code || "");
          break;
        case "processing":
          cmp = (sa.processing_type || "").localeCompare(sb.processing_type || "");
          break;
        case "stage":
          // Pipeline order (Pre-processing → Analyzed), not alphabetical.
          cmp = PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
          break;
        case "stains":
          cmp = a.agents.join(",").localeCompare(b.agents.join(","));
          break;
        case "slides":
          cmp = a.slides.length - b.slides.length;
          break;
        case "added":
          cmp = (sa.date_added || "").localeCompare(sb.date_added || "");
          break;
        case "updated":
          cmp = a.lastActivity.localeCompare(b.lastActivity);
          break;
      }
      return cmp * dir;
    });
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }
  function toggleExpand(id: number) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function runExport(kind: "csv" | "xlsx") {
    setExportMsg(null);
    // Export exactly what's shown: the current filter + sort, one row per slide.
    const payload = sorted.map((r) => ({ sample: r.sample, slides: r.slides }));
    try {
      const path = kind === "csv" ? await saveLogsCsv(payload) : await saveLogsXlsx(payload);
      setExportMsg(path ? "Exported." : "Export cancelled.");
    } catch (e) {
      setExportMsg(`Export failed: ${e}`);
    }
  }
  function togglePhase(key: PhaseKey) {
    setPhases((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const columns: Array<{ key: SortKey; label: string; align?: "right" }> = [
    { key: "sample", label: "Sample ID" },
    { key: "description", label: "Description" },
    { key: "project", label: "Project" },
    // Short vs Long decides an 18h or 52h protocol, so it belongs in the log
    // of what was actually done to a block (#97).
    { key: "processing", label: "Processing" },
    { key: "stage", label: "Stage" },
    { key: "stains", label: "Stains / IHC" },
    { key: "slides", label: "Slides", align: "right" },
    { key: "added", label: "Added" },
    { key: "updated", label: "Updated" },
  ];
  const totals = useMemo(() => {
    let slideCount = 0;
    let analyzedSamples = 0;
    for (const r of sorted) {
      slideCount += r.slides.length;
      if (r.phase === "analyzed") analyzedSamples += 1;
    }
    return { samples: sorted.length, slides: slideCount, analyzed: analyzedSamples };
  }, [sorted]);
  const selectClass =
    "rounded-md border border-line bg-white px-2 py-1 text-xs text-ink outline-none";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 rounded-md border border-line bg-white px-2 py-1">
          <Search size={13} className="text-ink-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search code, description, stain, slide, notes…"
            className="w-56 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
          />
        </label>
        <select className={selectClass} value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="all">All projects</option>
          {projectCodes.map((code) => (
            <option key={code} value={code}>{code}</option>
          ))}
        </select>
        <select className={selectClass} value={stain} onChange={(e) => setStain(e.target.value)}>
          <option value="all">Any stain / IHC</option>
          {stainNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <select
          className={selectClass}
          value={assayType}
          onChange={(e) => setAssayType(e.target.value as "all" | "stain" | "ihc")}
        >
          <option value="all">Any type</option>
          <option value="stain">Stain</option>
          <option value="ihc">IHC</option>
        </select>
        <StageFilter selected={phases} onToggle={togglePhase} />
        {stain !== "all" && (
          <label className="flex cursor-pointer items-center gap-1 rounded-md border border-line bg-white px-2 py-1 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={onlyMatching}
              onChange={(e) => setOnlyMatching(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--color-brand)]"
            />
            Only matching slides
          </label>
        )}
        {/* Archived samples are hidden by default; this brings them back (#74). */}
        <label className="flex cursor-pointer items-center gap-1 rounded-md border border-line bg-white px-2 py-1 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--color-brand)]"
          />
          Show archived
        </label>
        <label className="flex items-center gap-1 rounded-md border border-line bg-white px-2 py-1 text-xs text-ink-faint">
          Added
          <input
            type="date"
            aria-label="Added from"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="bg-transparent text-xs text-ink outline-none"
          />
          <span>–</span>
          <input
            type="date"
            aria-label="Added to"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="bg-transparent text-xs text-ink outline-none"
          />
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void runExport("csv")}
            title="Export the current view (filtered + sorted) as CSV, one row per slide"
            className="flex items-center gap-1 rounded-md border border-line bg-white px-2 py-1 text-xs text-ink-soft hover:text-ink"
          >
            <Download size={13} /> CSV
          </button>
          <button
            type="button"
            onClick={() => void runExport("xlsx")}
            title="Export the current view (filtered + sorted) as an Excel workbook"
            className="flex items-center gap-1 rounded-md border border-line bg-white px-2 py-1 text-xs text-ink-soft hover:text-ink"
          >
            <Download size={13} /> Excel
          </button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="mb-2 flex items-center gap-3 px-1 text-xs text-ink-faint">
        <span>
          <span className="font-semibold text-ink-soft">{totals.samples}</span>{" "}
          {totals.samples === 1 ? "sample" : "samples"}
        </span>
        <span>
          <span className="font-semibold text-ink-soft">{totals.slides}</span> slides
        </span>
        <span>
          <span className="font-semibold text-ink-soft">{totals.analyzed}</span> analyzed
        </span>
        {exportMsg && <span className="ml-auto text-brand">{exportMsg}</span>}
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-panel thin-scroll">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr className="border-b border-line">
              <th className="w-7" />
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  className={cn(
                    "cursor-pointer select-none px-2 py-2 font-semibold text-ink-soft hover:text-ink",
                    col.align === "right" && "text-right",
                  )}
                >
                  <span className={cn("inline-flex items-center gap-1", col.align === "right" && "flex-row-reverse")}>
                    {col.label}
                    {sortKey === col.key &&
                      (sortDir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="px-3 py-10 text-center text-ink-faint">
                  No samples match these filters.
                </td>
              </tr>
            )}
            {sorted.map((row) => {
              const isOpen = expanded.has(row.sample.id);
              return (
                <FragmentRow
                  key={row.sample.id}
                  sample={row.sample}
                  agents={row.agents}
                  slides={row.slides}
                  // A removed block has no live slides, so the derived phase
                  // falls back to its stage column — which removal overwrote.
                  // Say what it is instead of reporting a phase it is not (#96).
                  phaseLabel={
                    row.sample.current_stage === "removed" ? "Removed" : PHASE_LABEL[row.phase]
                  }
                  progress={row.progress}
                  extras={row.extras}
                  removedCount={row.removedCount}
                  removals={removals}
                  removal={sampleRemovals.get(row.sample.id)}
                  hasNotes={row.hasNotes}
                  lastActivity={row.lastActivity}
                  open={isOpen}
                  onToggle={() => toggleExpand(row.sample.id)}
                  stainFilter={stain === "all" ? null : stain}
                  onlyMatching={onlyMatching}
                  colCount={columns.length + 1}
                  onRequestStain={onRequestStain}
                  selectedSlideIds={selectedSlideIds}
                  onToggleSlideSelect={toggleSlideSelect}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Depth-tagging action bar — appears when slides are selected (#69). */}
      {selectedSlideIds.size > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-2 shadow-xl">
            <span className="text-xs font-medium text-ink">
              {selectedSlideIds.size} slide{selectedSlideIds.size === 1 ? "" : "s"} selected
            </span>
            {/* A viewer can SEE existing tags but cannot add them (#72) — the
                write would be rejected and the dialog would hang. */}
            {readOnly ? (
              <span className="text-[11px] text-ink-faint">Read-only viewer — tagging is done on the workstation</span>
            ) : (
              <Button variant="primary" className="px-3 py-1.5 text-xs" onClick={() => setShowDepthDialog(true)}>
                <Tag size={13} /> Create Tag
              </Button>
            )}
            <Button variant="ghost" className="px-2 py-1.5 text-xs" onClick={() => setSelectedSlideIds(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {showDepthDialog && (
        <DepthTagDialog
          count={selectedSlideIds.size}
          onApply={async (label, note) => {
            await tagSlidesDepth([...selectedSlideIds], label, note);
            setSelectedSlideIds(new Set());
            setShowDepthDialog(false);
          }}
          onClose={() => setShowDepthDialog(false)}
        />
      )}
    </div>
  );
}

function DepthTagDialog({
  count,
  onApply,
  onClose,
}: {
  count: number;
  onApply: (label: string, note: string) => Promise<void>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Tag ${count} slide${count === 1 ? "" : "s"} at a depth`} onClose={onClose} width="max-w-sm">
      <p className="mb-3 text-xs text-ink-faint">
        Group these slides under a depth label (e.g. “surface”, “100µm deep”), with an optional note.
        Leave the label empty and apply to clear an existing tag.
      </p>
      <Field label="Depth label">
        <TextInput autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. 100µm deep" />
      </Field>
      <Field label="Note (optional)">
        <TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Context…" />
      </Field>
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onApply(label, note);
            setBusy(false);
          }}
        >
          <Tag size={14} /> {busy ? "Applying…" : "Apply tag"}
        </Button>
      </div>
    </Modal>
  );
}

function FragmentRow({
  sample,
  agents,
  slides,
  phaseLabel,
  progress,
  extras,
  removedCount,
  removals,
  removal,
  hasNotes,
  lastActivity,
  open,
  onToggle,
  stainFilter,
  onlyMatching,
  colCount,
  onRequestStain,
  selectedSlideIds,
  onToggleSlideSelect,
}: {
  sample: Sample;
  agents: string[];
  slides: Slide[];
  phaseLabel: string;
  progress: { done: number; total: number };
  extras: number;
  removedCount: number;
  /** Reason per removed slide id (#83). */
  removals: Map<number, SlideRemoval>;
  /** Set when this BLOCK itself was removed from the board (#96). */
  removal?: SampleRemoval;
  hasNotes: boolean;
  lastActivity: string;
  open: boolean;
  onToggle: () => void;
  stainFilter: string | null;
  onlyMatching: boolean;
  colCount: number;
  onRequestStain?: (sampleCode: string) => void;
  selectedSlideIds: Set<number>;
  onToggleSlideSelect: (id: number) => void;
}) {
  const { editSampleNotes, editSlideNotes, editSampleDescription, setArchived } = useActions();
  const readOnly = useReadOnly();
  const [openSlides, setOpenSlides] = useState<Set<number>>(new Set());
  function toggleSlide(id: number) {
    setOpenSlides((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // With a stain filter active, optionally show only the slides that match it.
  const visibleSlides =
    stainFilter && onlyMatching
      ? slides.filter((s) => s.assay_name?.toLowerCase() === stainFilter.toLowerCase())
      : slides;
  const liveSlideCount = slides.length - removedCount;
  const slideTitle = [
    extras > 0 ? `${progress.total} assay · ${extras} extra` : `${liveSlideCount} slides`,
    removedCount > 0 ? `${removedCount} removed (listed below)` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <tr
        onClick={onToggle}
        className={cn("cursor-pointer border-b border-line/60 hover:bg-brand/5", open && "bg-brand/5")}
      >
        <td className="pl-2 text-ink-faint">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </td>
        <td className="px-2 py-1.5 font-semibold text-ink">
          <span className="inline-flex items-center gap-1">
            {sample.is_priority ? (
              <Star size={11} aria-hidden className="shrink-0 fill-amber-400 text-amber-400" />
            ) : null}
            {displayCode(sample.sample_code)}
            {hasNotes && (
              <span title="Has notes" aria-hidden className="text-ink-faint">
                📝
              </span>
            )}
          </span>
        </td>
        <td className="max-w-[16rem] truncate px-2 py-1.5 text-ink-soft">{sample.sample_description || "—"}</td>
        <td className="px-2 py-1.5 text-ink-soft">{sample.project_code ?? ""}</td>
        <td className="px-2 py-1.5 text-ink-soft">{sample.processing_type || "—"}</td>
        <td className="px-2 py-1.5">
          <div className="flex items-center gap-2">
            <span className="whitespace-nowrap text-ink-soft">{phaseLabel}</span>
            {sample.block_exhausted === 1 && (
              <span
                className="whitespace-nowrap rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                title="Block exhausted — no sample left to cut"
              >
                Exhausted
              </span>
            )}
            {sample.archived_at && (
              <span
                className="whitespace-nowrap rounded-full bg-ink/10 px-1.5 py-0.5 text-[10px] font-medium text-ink-soft"
                title={`Archived ${sample.archived_at.slice(0, 10)} — hidden from the board, restorable`}
              >
                Archived
              </span>
            )}
            {/* Removed ≠ archived. Archived is a reversible hide; this block was
                taken off the board on purpose, and the row exists to say so and
                to carry the reason (#96). Expand it to read why. */}
            {sample.current_stage === "removed" && (
              <span
                className="whitespace-nowrap rounded-full bg-red-600 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-white"
                title="Removed from the board — expand for the reason"
              >
                Removed
              </span>
            )}
            {progress.total > 0 && (
              <span className="flex items-center gap-1" title={`${progress.done}/${progress.total} analyzed`}>
                <span className="h-1.5 w-10 overflow-hidden rounded-full bg-line">
                  <span
                    className="block h-full rounded-full bg-brand"
                    style={{ width: `${(progress.done / progress.total) * 100}%` }}
                  />
                </span>
                <span className="tabular-nums text-[10px] text-ink-faint">
                  {progress.done}/{progress.total}
                </span>
              </span>
            )}
          </div>
        </td>
        <td className="max-w-[14rem] truncate px-2 py-1.5 text-ink-soft">
          {agents.length ? agents.join(", ") : "—"}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-ink-soft" title={slideTitle}>
          {liveSlideCount}
          {removedCount > 0 && (
            <span className="text-removed ml-1 text-[10px] font-medium">−{removedCount}</span>
          )}
        </td>
        <td className="px-2 py-1.5 text-ink-faint" title={sample.date_added}>
          {(sample.date_added || "").slice(0, 10)}
        </td>
        <td className="px-2 py-1.5 tabular-nums text-ink-faint">{lastActivity.slice(0, 10) || "—"}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={colCount} className="bg-surface px-4 py-3">
            {sample.current_stage === "removed" && (
              <div className="note-removed mb-3 rounded-md border px-2 py-1.5">
                <p className="text-removed text-[10px] font-semibold uppercase tracking-wide">
                  Block removed{removal?.at ? ` · ${fmtTime(removal.at)}` : ""}
                  {removal?.user_name ? ` · ${removal.user_name}` : ""}
                </p>
                <p className="mt-0.5 text-[11px] text-ink">
                  {removal?.reason ?? "No reason recorded."}
                </p>
              </div>
            )}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {onRequestStain && !readOnly && (
                <button
                  onClick={() => onRequestStain(sample.sample_code)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-medium text-ink hover:border-brand/50"
                >
                  <Send size={13} /> Request stain for {displayCode(sample.sample_code)}
                </button>
              )}
              {/* Archive is a reversible hide, not a delete, and never renumbers
                  anything — so it asks first and says so plainly (#74). Hidden
                  on a viewer, which cannot write (#72). */}
              {!readOnly && <button
                aria-label={
                  sample.archived_at
                    ? `Unarchive ${displayCode(sample.sample_code)}`
                    : `Archive ${displayCode(sample.sample_code)}`
                }
                onClick={() => {
                  if (sample.archived_at) {
                    void setArchived(sample.id, false);
                    return;
                  }
                  if (
                    confirm(
                      `Archive ${displayCode(sample.sample_code)}?\n\n` +
                        `The block, its cut groups and its extra slides all leave the board, ` +
                        `and the sample is hidden from this log. Nothing is deleted and no ` +
                        `numbering changes — tick "Show archived" to find it again and restore it.\n\n` +
                        `A shared staining rack stays put while it still holds another ` +
                        `sample's slides.`,
                    )
                  ) {
                    void setArchived(sample.id, true);
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-medium text-ink hover:border-brand/50"
              >
                <Archive size={13} />
                {sample.archived_at
                  ? `Restore ${displayCode(sample.sample_code)}`
                  : `Archive ${displayCode(sample.sample_code)}`}
              </button>}
            </div>

            {/* Sample description — editable right here, next to the notes the
                user already edits. #79 shipped this only as a faint pencil in the
                board drawer, which nobody found; descriptions belong wherever
                free text is edited. */}
            {!readOnly && (
              <>
                <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                  Sample description
                </h4>
                <NotesEditor
                  value={sample.sample_description ?? ""}
                  placeholder="Describe this sample…"
                  rows={1}
                  ariaLabel={`Description for ${displayCode(sample.sample_code)}`}
                  onSave={(text) => void editSampleDescription(sample.id, text)}
                />
              </>
            )}

            {/* Sample timeline — the block's own lifecycle. */}
            <h4 className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              Sample timeline
            </h4>
            <Timeline events={recordedEvents(sample as unknown as Record<string, unknown>, BLOCK_TIMELINE_STAGES)} />

            {/* Sample notes — free text, saved on blur. */}
            <h4 className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              Sample notes
            </h4>
            <NotesEditor
              value={sample.overall_notes ?? ""}
              placeholder="Notes about this sample…"
              onSave={(notes) => void editSampleNotes(sample.id, notes)}
            />

            {/* Slides — each with its own separate timeline. */}
            <h4 className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              Slides ({visibleSlides.length}
              {visibleSlides.length !== slides.length ? ` of ${slides.length}` : ""})
            </h4>
            {visibleSlides.length === 0 ? (
              <p className="text-[11px] text-ink-faint">
                {slides.length === 0 ? "No slides cut yet for this sample." : "No slides match the stain filter."}
              </p>
            ) : (
              <div className="divide-y divide-line/60 overflow-hidden rounded-md border border-line/60">
                {visibleSlides.map((slide) => {
                  const match =
                    stainFilter && slide.assay_name?.toLowerCase() === stainFilter.toLowerCase();
                  const slideOpen = openSlides.has(slide.id);
                  const removed = isRemoved(slide);
                  const removal = removed ? removals.get(slide.id) : undefined;
                  return (
                    <div key={slide.id} className={cn(match && "row-match", removed && "row-removed")}>
                      <div className="flex w-full items-center gap-2 px-2 py-1.5 text-[11px] hover:bg-brand/5">
                        <input
                          type="checkbox"
                          aria-label={`Select slide ${displayCode(slide.slide_code)}`}
                          checked={selectedSlideIds.has(slide.id)}
                          onChange={() => onToggleSlideSelect(slide.id)}
                          className="h-3 w-3 shrink-0 accent-[var(--color-brand)]"
                        />
                        <button
                          type="button"
                          onClick={() => toggleSlide(slide.id)}
                          className="flex flex-1 items-center gap-2 text-left"
                        >
                          {slideOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          <span className={cn("font-medium", removed ? "text-ink-faint line-through" : "text-ink")}>
                            {displayCode(slide.slide_code)}
                          </span>
                          {slide.assay_type && (
                            <span className="rounded bg-brand/10 px-1 text-[9px] font-semibold uppercase text-brand">
                              {slide.assay_type}
                            </span>
                          )}
                          <span className="text-ink-soft">{agentLabel(slide)}</span>
                          {slide.depth_label && (
                            <span
                              className="rounded-full bg-violet-100 px-1.5 text-[9px] font-medium text-violet-700"
                              title={slide.depth_note || undefined}
                            >
                              {slide.depth_label}
                            </span>
                          )}
                          {/* The flag IS the affordance: it sits inside the row
                              button, so clicking it opens the row and reveals the
                              reason panel below (#83). */}
                          {removed ? (
                            <span className="ml-auto rounded-full bg-red-600 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-white">
                              Removed
                            </span>
                          ) : (
                            <span className="ml-auto text-ink-faint">{slideStage(slide.current_stage)}</span>
                          )}
                        </button>
                      </div>
                      {slideOpen && (
                        <div className="space-y-2 px-3 pb-2 pl-7">
                          {removed && (
                            <div className="note-removed rounded-md border px-2 py-1.5">
                              <p className="text-removed text-[10px] font-semibold uppercase tracking-wide">
                                Removed{removal?.at ? ` · ${fmtTime(removal.at)}` : ""}
                                {removal?.user_name ? ` · ${removal.user_name}` : ""}
                              </p>
                              <p className="mt-0.5 text-[11px] text-ink">
                                {/* A removal recorded before the reason was kept,
                                    or by a build that stored it differently, still
                                    shows as removed — just without wording. */}
                                {removal?.reason ?? "No reason recorded."}
                              </p>
                            </div>
                          )}
                          <Timeline events={slideEvents(slide)} />
                          <NotesEditor
                            value={slide.notes ?? ""}
                            placeholder="Notes about this slide…"
                            onSave={(notes) => void editSlideNotes(slide.id, notes)}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
