import { useDraggable } from "@dnd-kit/core";
import { Layers, Star } from "lucide-react";
import type { MouseEvent } from "react";
import type { SlideStack } from "../lib/types";
import { SECTION_STAGE_LABELS } from "../lib/stages";
import { cn } from "../lib/utils";

export function StackCard({
  stack,
  selected = false,
  onSelect,
  overlay = false,
}: {
  stack: SlideStack;
  selected?: boolean;
  onSelect?: (id: number, event: MouseEvent<HTMLDivElement>) => void;
  overlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `stack-${stack.id}`,
    data: { type: "stack", stack },
    disabled: overlay,
  });
  const slideCount = stack.assay_slide_count ?? stack.slide_count ?? 0;

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : listeners)}
      {...(overlay ? {} : attributes)}
      onClick={(event) => onSelect?.(stack.id, event)}
      aria-selected={selected}
      className={cn(
        "group touch-none select-none rounded-md border bg-white px-2 py-1.5 transition",
        overlay ? "cursor-grabbing shadow-lg" : "cursor-grab",
        selected ? "border-brand ring-1 ring-brand/30" : "border-line hover:border-brand/40",
        isDragging && !overlay && "opacity-30",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn("h-3.5 w-3.5 shrink-0 rounded border", selected ? "border-brand bg-brand" : "border-line bg-white")} />
        <Layers size={11} className="shrink-0 text-ink-faint" />
        <span className="text-xs font-semibold text-ink">{stack.parent_code}</span>
        <span className="text-[10px] text-ink-faint">{stack.depth_um} um</span>
        {stack.is_priority === 1 && <Star size={10} className="fill-amber-400 text-amber-500" aria-label="Priority sample" />}
        <span className="ml-auto text-[11px] font-medium text-ink-soft">
          {slideCount} {slideCount === 1 ? "slide" : "slides"}
        </span>
      </div>
      <p className="mt-0.5 truncate pl-7 text-[10px] text-ink-soft">
        {stack.slide_summary || SECTION_STAGE_LABELS[stack.current_stage] || stack.current_stage}
      </p>
    </div>
  );
}
