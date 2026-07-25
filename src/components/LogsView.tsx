import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Search } from "lucide-react";
import type { Sample, Slide } from "../lib/types";
import { useActions } from "../hooks/useActions";
import { useAllSamples, useAllSlides, useAssayCatalog } from "../hooks/useData";
import { BLOCK_TIMELINE_STAGES, SECTION_STAGE_LABELS, STAGE_LABELS } from "../lib/stages";
import { cn } from "../lib/utils";

// A slide's own lifecycle, built from its per-slide timestamps (these are always
// accurate — unlike the aggregate stack, a slide keeps its own stamps through
// rack scatter/merge). Condensed to the milestones that matter.
const SLIDE_TIMELINE: Array<{ label: string; column: keyof Slide; fallback?: keyof Slide }> = [
  // stage_cut_at is stamped in local time at cut; created_at (UTC) is a fallback
  // for older slides so their Cut step still shows.
  { label: "Cut", column: "stage_cut_at", fallback: "created_at" },
  { label: "Stained", column: "stage_stained_at" },
  { label: "Coverslipped", column: "stage_coverslipped_at" },
  { label: "Imaged", column: "stage_pictures_taken_at" },
];

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

type SortKey = "sample" | "description" | "project" | "stage" | "stains" | "slides" | "added";
type Status = "all" | "active" | "analyzed";

function sampleStage(stage: string): string {
  return STAGE_LABELS[stage] ?? SECTION_STAGE_LABELS[stage] ?? stage;
}
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
}: {
  value: string;
  placeholder: string;
  onSave: (notes: string) => void;
}) {
  const [text, setText] = useState(value ?? "");
  const [focused, setFocused] = useState(false);
  // Adopt external changes only while not editing, so a refetch can't clobber typing.
  useEffect(() => {
    if (!focused) setText(value ?? "");
  }, [value, focused]);
  return (
    <textarea
      value={text}
      rows={2}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (text !== (value ?? "")) onSave(text);
      }}
      className="w-full resize-y rounded-md border border-line bg-white px-2 py-1 text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-brand"
    />
  );
}

export function LogsView() {
  const { data: samples = [] } = useAllSamples();
  const { data: slides = [] } = useAllSlides();
  const { data: catalog = [] } = useAssayCatalog(true);

  const [project, setProject] = useState("all");
  const [stain, setStain] = useState("all");
  const [status, setStatus] = useState<Status>("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("sample");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const slidesBySample = useMemo(() => {
    const map = new Map<string, Slide[]>();
    for (const slide of slides) {
      const key = slide.parent_code ?? "";
      const list = map.get(key);
      if (list) list.push(slide);
      else map.set(key, [slide]);
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
        return { sample, slides: slidesForSample, agents };
      }),
    [samples, slidesBySample],
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter(({ sample, slides: sampleSlides, agents }) => {
      if (project !== "all" && sample.project_code !== project) return false;
      // "Analyzed" is a per-slide state — a block itself never reaches the
      // analyzed stage, so filter on whether any of its slides were analyzed.
      const hasAnalyzed = sampleSlides.some((s) => Boolean(s.stage_analyzed_at));
      if (status === "analyzed" && !hasAnalyzed) return false;
      if (status === "active" && hasAnalyzed) return false;
      if (stain !== "all" && !agents.some((a) => a.toLowerCase() === stain.toLowerCase())) return false;
      if (query) {
        const hay = [sample.sample_code, sample.sample_description, ...agents].join(" ").toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }, [rows, project, status, stain, search]);

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
        case "stage":
          cmp = sampleStage(sa.current_stage).localeCompare(sampleStage(sb.current_stage));
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

  const columns: Array<{ key: SortKey; label: string; align?: "right" }> = [
    { key: "sample", label: "Sample ID" },
    { key: "description", label: "Description" },
    { key: "project", label: "Project" },
    { key: "stage", label: "Stage" },
    { key: "stains", label: "Stains / IHC" },
    { key: "slides", label: "Slides", align: "right" },
    { key: "added", label: "Added" },
  ];
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
            placeholder="Search sample, description, or stain…"
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
        <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="analyzed">Analyzed</option>
        </select>
        <span className="ml-auto text-xs text-ink-faint">
          {sorted.length} {sorted.length === 1 ? "sample" : "samples"}
        </span>
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
            {sorted.map(({ sample, slides: sampleSlides, agents }) => {
              const isOpen = expanded.has(sample.id);
              return (
                <FragmentRow
                  key={sample.id}
                  sample={sample}
                  agents={agents}
                  slides={sampleSlides}
                  open={isOpen}
                  onToggle={() => toggleExpand(sample.id)}
                  stainFilter={stain === "all" ? null : stain}
                  colCount={columns.length + 1}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FragmentRow({
  sample,
  agents,
  slides,
  open,
  onToggle,
  stainFilter,
  colCount,
}: {
  sample: Sample;
  agents: string[];
  slides: Slide[];
  open: boolean;
  onToggle: () => void;
  stainFilter: string | null;
  colCount: number;
}) {
  const { editSampleNotes, editSlideNotes } = useActions();
  const [openSlides, setOpenSlides] = useState<Set<number>>(new Set());
  function toggleSlide(id: number) {
    setOpenSlides((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <tr
        onClick={onToggle}
        className={cn("cursor-pointer border-b border-line/60 hover:bg-brand/5", open && "bg-brand/5")}
      >
        <td className="pl-2 text-ink-faint">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </td>
        <td className="px-2 py-1.5 font-semibold text-ink">{sample.sample_code}</td>
        <td className="max-w-[16rem] truncate px-2 py-1.5 text-ink-soft">{sample.sample_description || "—"}</td>
        <td className="px-2 py-1.5 text-ink-soft">{sample.project_code ?? ""}</td>
        <td className="px-2 py-1.5 text-ink-soft">{sampleStage(sample.current_stage)}</td>
        <td className="max-w-[14rem] truncate px-2 py-1.5 text-ink-soft">
          {agents.length ? agents.join(", ") : "—"}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-ink-soft">{slides.length}</td>
        <td className="px-2 py-1.5 text-ink-faint" title={sample.date_added}>
          {(sample.date_added || "").slice(0, 10)}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={colCount} className="bg-surface px-4 py-3">
            {/* Sample timeline — the block's own lifecycle. */}
            <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
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
              Slides ({slides.length})
            </h4>
            {slides.length === 0 ? (
              <p className="text-[11px] text-ink-faint">No slides cut yet for this sample.</p>
            ) : (
              <div className="divide-y divide-line/60 overflow-hidden rounded-md border border-line/60">
                {slides.map((slide) => {
                  const match =
                    stainFilter && slide.assay_name?.toLowerCase() === stainFilter.toLowerCase();
                  const slideOpen = openSlides.has(slide.id);
                  return (
                    <div key={slide.id} className={cn(match && "bg-amber-100/50")}>
                      <button
                        type="button"
                        onClick={() => toggleSlide(slide.id)}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-brand/5"
                      >
                        {slideOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span className="font-medium text-ink">{slide.slide_code}</span>
                        {slide.assay_type && (
                          <span className="rounded bg-brand/10 px-1 text-[9px] font-semibold uppercase text-brand">
                            {slide.assay_type}
                          </span>
                        )}
                        <span className="text-ink-soft">{agentLabel(slide)}</span>
                        <span className="ml-auto text-ink-faint">{slideStage(slide.current_stage)}</span>
                      </button>
                      {slideOpen && (
                        <div className="space-y-2 px-3 pb-2 pl-7">
                          <Timeline events={recordedEvents(slide as unknown as Record<string, unknown>, SLIDE_TIMELINE)} />
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
