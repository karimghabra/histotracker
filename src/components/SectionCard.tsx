import { useDraggable } from "@dnd-kit/core";
import { Layers, Star } from "lucide-react";
import type { MouseEvent } from "react";
import type { SectionRequest } from "../lib/types";
import { SECTION_STAGE_LABELS } from "../lib/stages";
import { cn, displayCode, displayCodesInText } from "../lib/utils";

/** Collapse a group's per-slide dispositions into a compact tally:
 *  "H&E · 3× Extra", "2× H&E · SafO · 2× Extra" (issue #63). */
function compactSummary(sections: SectionRequest[]): string {
  const counts = new Map<string, number>();
  let extras = 0;
  for (const s of sections) {
    for (const token of (s.slide_summary ?? "").split(" · ").map((t) => t.trim()).filter(Boolean)) {
      if (token === "Extra") {
        extras += 1;
        continue;
      }
      const label = token.replace(/^Stain:\s*/, "").replace(/^IHC:\s*/, "IHC ");
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  const parts = [...counts.entries()].map(([label, n]) => (n > 1 ? `${n}× ${label}` : label));
  if (extras > 0) parts.push(`${extras}× Extra`);
  return parts.join(" · ");
}

export function SectionCard({
  section,
  groupedSections,
  selected = false,
  onSelect,
  onSelectGroup,
  onToggle,
  overlay = false,
}: {
  section: SectionRequest;
  groupedSections?: SectionRequest[];
  selected?: boolean;
  onSelect?: (id: number, event: MouseEvent<HTMLDivElement>) => void;
  onSelectGroup?: (ids: number[], event: MouseEvent<HTMLDivElement>) => void;
  /** Toggle this card's group in/out of the multi-selection (checkbox, issue #37). */
  onToggle?: (ids: number[]) => void;
  overlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `section-${section.id}`,
    data: { type: "section", section },
    disabled: overlay,
  });
  const isDownstream = !["needs_sectioning", "sectioned", "assignment_required"].includes(
    section.current_stage,
  );
  const grouped = groupedSections ?? [section];
  const isGrouped = grouped.length > 1;
  const visibleSlideCount = isDownstream
    ? grouped.reduce((count, item) => count + (item.assay_slide_count ?? 0), 0)
    : grouped.reduce((count, item) => count + (item.slide_count ?? 0), 0);
  // Needs-sectioning cards show a COMPACT tally — each agent once, with a count,
  // plus "N× Extra" — instead of repeating "Extra · Extra · Extra" (#63).
  // The summaries are SQL-composed and embed slide codes mid-string, so strip
  // their leading zeros here rather than at a single anchored code (#87).
  const visibleSummary = displayCodesInText(
    isDownstream
      ? [...new Set(grouped.flatMap((item) => (item.assay_slide_summary ?? "").split(" · ").filter(Boolean)))].join(" · ")
      : compactSummary(grouped),
  );

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : listeners)}
      {...(overlay ? {} : attributes)}
      onClick={(event) => {
        if (isGrouped) onSelectGroup?.(grouped.map((item) => item.id), event);
        else onSelect?.(section.id, event);
      }}
      aria-selected={selected}
      className={cn(
        "group touch-none select-none rounded-md border bg-white px-2 py-1.5 transition",
        overlay ? "cursor-grabbing shadow-lg" : "cursor-grab",
        selected ? "border-brand ring-1 ring-brand/30" : "border-line hover:border-brand/40",
        isDragging && !overlay && "opacity-30",
      )}
    >
      <div className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Select ${displayCode(section.parent_code ?? "")}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onChange={() => onToggle?.(grouped.map((item) => item.id))}
          className="h-3.5 w-3.5 shrink-0 accent-[var(--color-brand)]"
        />
        <Layers size={11} className="shrink-0 text-ink-faint" />
        <span className="text-xs font-semibold text-ink">{displayCode(section.parent_code ?? "")}</span>
        {section.is_priority === 1 && <Star size={10} className="fill-amber-400 text-amber-500" aria-label="Priority sample" />}
        <span className="ml-auto text-[11px] font-medium text-ink-soft">
          {isGrouped
            ? `${visibleSlideCount} ${isDownstream ? "assay " : ""}slide${visibleSlideCount === 1 ? "" : "s"}`
            : `×${section.duplicates}`}
        </span>
      </div>
      {visibleSummary ? (
        <p className="mt-0.5 truncate pl-7 text-[10px] text-ink-soft">
          {visibleSlideCount} {visibleSlideCount === 1 ? "slide" : "slides"} · {visibleSummary}
        </p>
      ) : section.stains ? (
        <p className="mt-0.5 truncate pl-7 text-[11px] text-ink-soft">{section.stains}</p>
      ) : (
        <p className="mt-0.5 truncate pl-7 text-[10px] uppercase tracking-wide text-ink-faint">
          {SECTION_STAGE_LABELS[section.current_stage] ?? section.current_stage}
        </p>
      )}
    </div>
  );
}
