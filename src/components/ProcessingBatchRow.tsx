import { useDraggable } from "@dnd-kit/core";
import { CalendarClock, ChevronDown, ChevronRight, Clock3, FlaskConical, Play } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProcessingBatch } from "../lib/types";
import { cn, parseTimestamp } from "../lib/utils";

function remaining(batch: ProcessingBatch, now: number): string {
  if (batch.current_stage !== "processing_started") return "";
  const ready = parseTimestamp(batch.ready_at);
  if (!ready) return "";
  const ms = ready.getTime() - now;
  if (ms <= 0) return "ready";
  const hours = Math.floor(ms / 3600_000);
  const minutes = Math.floor((ms % 3600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// "PLANNED FOR 07:30 · TOMORROW" / "· MON" (issues #4, #24): the tile must show
// the scheduled start, not a timer that misleadingly counts up before the run.
function plannedLabel(batch: ProcessingBatch): string {
  const when = parseTimestamp(batch.planned_start_at);
  if (!when) return "PLANNED";
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(when) - startOfDay(new Date())) / 86_400_000);
  const day =
    days === 0 ? "TODAY" :
    days === 1 ? "TOMORROW" :
    when.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase();
  return `PLANNED FOR ${clock} · ${day}`;
}

export function ProcessingBatchRow({
  batch,
  overlay = false,
  selected = false,
  onSelect,
  onConfirmStart,
}: {
  batch: ProcessingBatch;
  overlay?: boolean;
  selected?: boolean;
  onSelect?: (batchId: number) => void;
  onConfirmStart?: (batchId: number) => void;
}) {
  const isPlanned = batch.status === "planned";
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (isPlanned || batch.current_stage !== "processing_started") return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [isPlanned, batch.current_stage]);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `batch-${batch.id}`,
    data: { type: "batch", batch },
    // A planned run has not entered the processor, so it cannot be dragged onward.
    disabled: overlay || isPlanned,
  });
  const time = isPlanned ? "" : remaining(batch, now);
  const awaitingPickup = !isPlanned && batch.current_stage === "processed";

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : listeners)}
      {...(overlay ? {} : attributes)}
      onClick={() => !overlay && onSelect?.(batch.id)}
      className={cn(
        "rounded-md border transition",
        isPlanned
          ? "border-dashed border-ink-faint/40 bg-surface"
          : awaitingPickup
            // Issue #19: keep the pickup signal on the edges without washing out the tile.
            ? "batch-awaiting-pickup"
            : "border-brand/25 bg-brand/5",
        // Issue #17: show which batch is selected.
        selected && "ring-2 ring-brand ring-offset-1",
        overlay ? "cursor-grabbing shadow-lg" : isPlanned ? "cursor-pointer" : "cursor-grab",
        isDragging && !overlay && "opacity-30",
      )}
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          aria-label={expanded ? "Collapse batch" : "Expand batch"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
          className="rounded p-0.5 text-ink-faint hover:bg-black/5"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {isPlanned ? <CalendarClock size={12} className="text-ink-soft" /> : <FlaskConical size={12} className="text-brand" />}
        <span className="text-xs font-semibold text-ink">Batch {batch.id}</span>
        <span className="text-[10px] text-ink-soft">
          {batch.processing_type} · {batch.member_count} samples
        </span>
        {time && (
          <span className="ml-auto inline-flex items-center gap-0.5 rounded bg-white/70 px-1 text-[10px] font-medium text-amber-700">
            <Clock3 size={9} /> {time}
          </span>
        )}
        {awaitingPickup && (
          <span className="ml-auto px-1 text-[10px] font-semibold text-amber-700">
            PICK UP
          </span>
        )}
      </div>
      {isPlanned && (
        <div className="flex items-center gap-2 border-t border-ink-faint/15 px-2 py-1.5">
          <span className="inline-flex items-center gap-1 rounded bg-ink-faint/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-ink-soft">
            <CalendarClock size={10} /> {plannedLabel(batch)}
          </span>
          {onConfirmStart && !overlay && (
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onConfirmStart(batch.id);
              }}
              className="ml-auto inline-flex items-center gap-1 rounded border border-brand bg-brand px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-brand/90"
            >
              <Play size={10} /> Confirm start
            </button>
          )}
        </div>
      )}
      {batch.operator_name && (
        <div className="border-t border-brand/10 px-7 py-1 text-[10px] text-ink-faint">
          {batch.operator_name}
          {batch.checklist_total > 0 && ` · checklist ${batch.checklist_completed}/${batch.checklist_total}`}
        </div>
      )}
      {expanded && !overlay && (
        <div className="border-t border-brand/10 px-7 py-1.5">
          <div className="flex flex-wrap gap-1">
            {batch.member_codes.map((code) => (
              <span key={code} className="rounded bg-white px-1.5 py-0.5 text-[10px] text-ink-soft">
                {code}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
