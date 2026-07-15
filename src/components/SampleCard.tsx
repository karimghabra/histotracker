import { useDraggable } from "@dnd-kit/core";
import { Clock, Star } from "lucide-react";
import type { MouseEvent } from "react";
import type { Sample } from "../lib/types";
import { processingDurationHours } from "../lib/stages";
import { cn, parseTimestamp } from "../lib/utils";

function processingRemaining(sample: Sample): string | null {
  if (sample.current_stage !== "processing_started") return null;
  const started = parseTimestamp(sample.processing_started_at);
  if (!started) return null;
  const readyAt = new Date(
    started.getTime() + processingDurationHours(sample.processing_type) * 3600_000,
  );
  const diffMs = readyAt.getTime() - Date.now();
  if (diffMs <= 0) return "ready";
  const hours = Math.floor(diffMs / 3600_000);
  const mins = Math.floor((diffMs % 3600_000) / 60_000);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

const PREPROCESSING_STAGES = new Set([
  "received", "in_fixative", "fixative_removed", "decalcified", "in_ethanol",
]);

function PreprocessingProgress({ sample }: { sample: Sample }) {
  if (!PREPROCESSING_STAGES.has(sample.current_stage)) return null;
  const milestones = [
    { code: "F+", label: "Placed in fixative", done: Boolean(sample.fixative_placed_at) },
    { code: "F✓", label: "Removed from fixative / fixation complete", done: Boolean(sample.fixative_removed_at) },
    ...(sample.needs_decalcification === 1
      ? [{ code: "D", label: "Decalcification complete", done: Boolean(sample.decalc_completed_at) }]
      : []),
    { code: "E", label: "Placed in ethanol", done: Boolean(sample.ethanol_placed_at) },
  ];
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5" aria-label="Preprocessing progress">
      {milestones.map((milestone) => (
        <span
          key={milestone.code}
          title={`${milestone.label}: ${milestone.done ? "complete" : "pending"}`}
          className={cn(
            "flex h-4 min-w-4 items-center justify-center rounded px-0.5 text-[8px] font-bold",
            milestone.done ? "bg-emerald-100 text-emerald-700" : "bg-black/5 text-ink-faint/50",
          )}
        >
          {milestone.code}
        </span>
      ))}
    </span>
  );
}

export function SampleCard({
  sample,
  variant = "default",
  selected = false,
  onSelect,
  onToggle,
  onTogglePriority,
  overlay = false,
}: {
  sample: Sample;
  variant?: "default" | "dense";
  selected?: boolean;
  onSelect?: (id: number, event: MouseEvent<HTMLDivElement>) => void;
  onToggle?: (id: number) => void;
  onTogglePriority?: (id: number) => void;
  overlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `block-${sample.id}`,
    data: { type: "block", sample },
    disabled: overlay,
  });

  const remaining = processingRemaining(sample);

  const base = cn(
    "group touch-none rounded-md border bg-white transition select-none",
    overlay ? "cursor-grabbing shadow-lg" : "cursor-grab",
    selected ? "border-brand ring-1 ring-brand/30" : "border-line hover:border-brand/40",
    isDragging && !overlay && "opacity-30",
  );

  if (variant === "dense") {
    return (
      <div
        ref={overlay ? undefined : setNodeRef}
        {...(overlay ? {} : listeners)}
        {...(overlay ? {} : attributes)}
        onClick={(event) => onSelect?.(sample.id, event)}
        aria-selected={selected}
        className={cn(base, "flex items-center gap-2 px-2 py-1.5")}
      >
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Select ${sample.sample_code}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onChange={() => onToggle?.(sample.id)}
          className="h-3.5 w-3.5 shrink-0 accent-[var(--color-brand)]"
        />
        <span className="text-xs font-semibold text-ink">{sample.sample_code}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-soft">
          {sample.sample_description || "—"}
        </span>
        {(sample.sectioned_depths || sample.max_cut_depth_um != null) && (
          <span
            className="shrink-0 text-[10px] text-ink-faint"
            title={sample.sectioned_depths ? `Sectioned depths: ${sample.sectioned_depths}` : "Deepest requested depth"}
          >
            {sample.sectioned_depths || `${sample.max_cut_depth_um}µm requested`}
          </span>
        )}
        <button
          type="button"
          title={sample.is_priority === 1 ? "Remove priority" : "Prioritize sample"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onTogglePriority?.(sample.id); }}
          className="shrink-0 rounded p-0.5 text-amber-500 hover:bg-amber-50"
        >
          <Star size={12} className={sample.is_priority === 1 ? "fill-current" : ""} />
        </button>
      </div>
    );
  }

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : listeners)}
      {...(overlay ? {} : attributes)}
      onClick={(event) => onSelect?.(sample.id, event)}
      aria-selected={selected}
      className={cn(base, "flex items-center gap-1.5 px-2 py-1.5")}
    >
      <input
        type="checkbox"
        checked={selected}
        aria-label={`Select ${sample.sample_code}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onChange={() => onToggle?.(sample.id)}
        className="h-3.5 w-3.5 shrink-0 accent-[var(--color-brand)]"
      />
      <span className="shrink-0 text-xs font-semibold text-ink">{sample.sample_code}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-ink-soft">
        {sample.sample_description}
      </span>
      {remaining && (
        <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-50 px-1 py-px text-[10px] font-medium text-amber-700">
          <Clock size={9} /> {remaining}
        </span>
      )}
      {!remaining && <PreprocessingProgress sample={sample} />}
      <button
        type="button"
        title={sample.is_priority === 1 ? "Remove priority" : "Prioritize sample"}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onTogglePriority?.(sample.id); }}
        className="shrink-0 rounded p-0.5 text-amber-500 hover:bg-amber-50"
      >
        <Star size={12} className={sample.is_priority === 1 ? "fill-current" : ""} />
      </button>
    </div>
  );
}
