import { useDraggable } from "@dnd-kit/core";
import { ChevronDown, ChevronRight, Clock3, FlaskConical } from "lucide-react";
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

export function ProcessingBatchRow({
  batch,
  overlay = false,
  selected = false,
  onSelect,
}: {
  batch: ProcessingBatch;
  overlay?: boolean;
  selected?: boolean;
  onSelect?: (batchId: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (batch.current_stage !== "processing_started") return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [batch.current_stage]);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `batch-${batch.id}`,
    data: { type: "batch", batch },
    disabled: overlay,
  });
  const time = remaining(batch, now);
  const awaitingPickup = batch.current_stage === "processed";

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : listeners)}
      {...(overlay ? {} : attributes)}
      onClick={() => !overlay && onSelect?.(batch.id)}
      className={cn(
        "rounded-md border transition",
        awaitingPickup
          // Issue #19: a batch awaiting pickup needs an unmistakable amber glow.
          ? "border-amber-400 bg-amber-50 shadow-[0_0_16px_rgba(245,158,11,0.55)]"
          : "border-brand/25 bg-brand/5",
        // Issue #17: show which batch is selected.
        selected && "ring-2 ring-brand ring-offset-1",
        overlay ? "cursor-grabbing shadow-lg" : "cursor-grab",
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
        <FlaskConical size={12} className="text-brand" />
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
