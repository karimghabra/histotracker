import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Search } from "lucide-react";
import type { Slide } from "../lib/types";
import { useAllSamples, useAllSlides, useAssayCatalog } from "../hooks/useData";
import { SECTION_STAGE_LABELS, STAGE_LABELS } from "../lib/stages";
import { cn } from "../lib/utils";

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
    return rows.filter(({ sample, agents }) => {
      if (project !== "all" && sample.project_code !== project) return false;
      if (status === "analyzed" && sample.current_stage !== "analyzed") return false;
      if (status === "active" && sample.current_stage === "analyzed") return false;
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
                  open={isOpen}
                  onToggle={() => toggleExpand(sample.id)}
                  code={sample.sample_code}
                  description={sample.sample_description}
                  projectCode={sample.project_code ?? ""}
                  stage={sampleStage(sample.current_stage)}
                  agents={agents}
                  slideCount={sampleSlides.length}
                  added={sample.date_added}
                  slides={sampleSlides}
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
  open,
  onToggle,
  code,
  description,
  projectCode,
  stage,
  agents,
  slideCount,
  added,
  slides,
  stainFilter,
  colCount,
}: {
  open: boolean;
  onToggle: () => void;
  code: string;
  description: string;
  projectCode: string;
  stage: string;
  agents: string[];
  slideCount: number;
  added: string;
  slides: Slide[];
  stainFilter: string | null;
  colCount: number;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={cn("cursor-pointer border-b border-line/60 hover:bg-brand/5", open && "bg-brand/5")}
      >
        <td className="pl-2 text-ink-faint">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </td>
        <td className="px-2 py-1.5 font-semibold text-ink">{code}</td>
        <td className="max-w-[16rem] truncate px-2 py-1.5 text-ink-soft">{description || "—"}</td>
        <td className="px-2 py-1.5 text-ink-soft">{projectCode}</td>
        <td className="px-2 py-1.5 text-ink-soft">{stage}</td>
        <td className="max-w-[14rem] truncate px-2 py-1.5 text-ink-soft">
          {agents.length ? agents.join(", ") : "—"}
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums text-ink-soft">{slideCount}</td>
        <td className="px-2 py-1.5 text-ink-faint" title={added}>{(added || "").slice(0, 10)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={colCount} className="bg-surface px-3 py-2">
            {slides.length === 0 ? (
              <p className="py-2 text-center text-[11px] text-ink-faint">No slides cut yet for this sample.</p>
            ) : (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-ink-faint">
                    <th className="px-2 py-1 text-left font-medium">Slide ID</th>
                    <th className="px-2 py-1 text-left font-medium">Agent</th>
                    <th className="px-2 py-1 text-left font-medium">Stage</th>
                    <th className="px-2 py-1 text-left font-medium">Location</th>
                  </tr>
                </thead>
                <tbody>
                  {slides.map((slide) => {
                    const match =
                      stainFilter && slide.assay_name?.toLowerCase() === stainFilter.toLowerCase();
                    return (
                      <tr key={slide.id} className={cn("border-t border-line/50", match && "bg-amber-100/60")}>
                        <td className="px-2 py-1 font-medium text-ink">{slide.slide_code}</td>
                        <td className="px-2 py-1 text-ink-soft">
                          {slide.assay_type && (
                            <span className="mr-1 rounded bg-brand/10 px-1 text-[9px] font-semibold uppercase text-brand">
                              {slide.assay_type}
                            </span>
                          )}
                          {agentLabel(slide)}
                        </td>
                        <td className="px-2 py-1 text-ink-soft">{slideStage(slide.current_stage)}</td>
                        <td className="px-2 py-1 text-ink-faint">{slide.location || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
