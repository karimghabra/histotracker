import { useDraggable } from "@dnd-kit/core";
import { Layers, Star } from "lucide-react";
import type { MouseEvent } from "react";
import type { SectionRequest } from "../lib/types";
import { SECTION_STAGE_LABELS } from "../lib/stages";
import { cn } from "../lib/utils";

export function SectionCard({
  section,
  selected = false,
  onSelect,
  overlay = false,
}: {
  section: SectionRequest;
  selected?: boolean;
  onSelect?: (id: number, event: MouseEvent<HTMLDivElement>) => void;
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
  const visibleSlideCount = isDownstream
    ? (section.assay_slide_count ?? 0)
    : (section.slide_count ?? 0);
  const visibleSummary = isDownstream ? section.assay_slide_summary : section.slide_summary;

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : listeners)}
      {...(overlay ? {} : attributes)}
      onClick={(event) => onSelect?.(section.id, event)}
      aria-selected={selected}
      className={cn(
        "group touch-none select-none rounded-md border bg-white px-2 py-1.5 transition",
        overlay ? "cursor-grabbing shadow-lg" : "cursor-grab",
        selected ? "border-brand ring-1 ring-brand/30" : "border-line hover:border-brand/40",
        isDragging && !overlay && "opacity-30",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "h-3.5 w-3.5 shrink-0 rounded border",
            selected ? "border-brand bg-brand" : "border-line bg-white",
          )}
        />
        <Layers size={11} className="shrink-0 text-ink-faint" />
        <span className="text-xs font-semibold text-ink">{section.parent_code}</span>
        {section.is_priority === 1 && <Star size={10} className="fill-amber-400 text-amber-500" aria-label="Priority sample" />}
        <span className="ml-auto text-[11px] font-medium text-ink-soft">
          {section.depth_um}µm ×{section.duplicates}
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
