import { useDraggable } from "@dnd-kit/core";
import { Layers, Star } from "lucide-react";
import type { MouseEvent } from "react";
import type { SlideStack } from "../lib/types";
import { SECTION_STAGE_LABELS } from "../lib/stages";
import { cn, displayCode, displayCodesInText } from "../lib/utils";

export function StackCard({
  stack,
  selected = false,
  onSelect,
  overlay = false,
  laterRackFor,
}: {
  stack: SlideStack;
  selected?: boolean;
  onSelect?: (id: number, event: MouseEvent<HTMLDivElement>) => void;
  overlay?: boolean;
  /**
   * True when an OLDER open rack for the same agent already exists.
   *
   * Two racks for one agent is correct — a rack that has begun its protocol
   * cannot take newcomers (#81), so the next slide starts a fresh one — but on
   * the board it just looked like a duplicate, with nothing to say which was
   * which or why. Saying it is the difference between a rule and a glitch.
   */
  laterRackFor?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `stack-${stack.id}`,
    data: { type: "stack", stack },
    disabled: overlay,
  });
  const slideCount = stack.assay_slide_count ?? stack.slide_count ?? 0;
  const memberSampleCount = (stack.member_sample_codes ?? "").split(",").filter(Boolean).length;
  const agents = (stack.agent_names ?? "")
    .split(",")
    .map((agent) => agent.trim())
    .filter(Boolean)
    .join(" · ");
  const slideSummary = displayCodesInText(stack.slide_summary ?? "");
  const summary = stack.kind === "stain" ? slideSummary : agents || slideSummary;

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
        <span className="shrink-0 text-xs font-semibold text-ink">
          {displayCode(stack.parent_code ?? "")}
        </span>
        {/* The block's description, right of its ID (#102). A tile that says
            only "EE-4" means nothing to someone reading the board from across
            the bench; the description is what they actually recognise. Empty for
            a cross-sample stain rack, which has no single description. */}
        {stack.parent_description && (
          <span className="min-w-0 truncate text-[11px] text-ink-soft" title={stack.parent_description}>
            {stack.parent_description}
          </span>
        )}
        {stack.kind === "stain" && (
          <span className="rounded bg-brand/10 px-1 text-[10px] font-medium text-brand">
            {memberSampleCount} {memberSampleCount === 1 ? "sample" : "samples"}
          </span>
        )}
        {laterRackFor && (
          <span
            className="rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800"
            title="An earlier rack for this agent has already started its protocol, so it can no longer take new slides. These went into a fresh rack."
          >
            new rack
          </span>
        )}
        {stack.is_priority === 1 && <Star size={10} className="fill-amber-400 text-amber-500" aria-label="Priority sample" />}
        <span className="ml-auto text-[11px] font-medium text-ink-soft">
          {slideCount} {slideCount === 1 ? "slide" : "slides"}
        </span>
      </div>
      {/* The agents on this stack, plainly, under the ID (#102) — "what needs
          imaging" is the question the Ready for Imaging column exists to answer,
          and slide_summary buried it inside a slide-by-slide breakdown.
          PER-SAMPLE stacks only. On a cross-sample stain rack `parent_code` is
          already the agent name, so repeating it here says nothing new AND
          displaces the slide codes that tell you which blocks are in the rack —
          which is the one thing a rack tile has to answer. */}
      <p className="mt-0.5 truncate pl-7 text-[10px] text-ink-soft" title={summary || undefined}>
        {summary || SECTION_STAGE_LABELS[stack.current_stage] || stack.current_stage}
      </p>
    </div>
  );
}
