import { useDroppable } from "@dnd-kit/core";
import type { ReactNode } from "react";
import type { QueueDef } from "../lib/stages";
import { LANE_COLORS } from "../lib/stages";
import { cn } from "../lib/utils";

export function QueueColumn({
  queue,
  count,
  headerExtra,
  selectedCount = 0,
  onToggleAll,
  children,
}: {
  queue: QueueDef;
  count: number;
  headerExtra?: ReactNode;
  selectedCount?: number;
  onToggleAll?: () => void;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: queue.key, data: { queue } });
  const accent = LANE_COLORS[queue.lane];

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg">
      <div className="flex items-center gap-1.5 px-2 pb-1 pt-2">
        {onToggleAll && count > 0 && (
          <button
            type="button"
            title={selectedCount === count ? "Clear selection" : "Select visible rows"}
            onClick={onToggleAll}
            className={cn(
              "h-3.5 w-3.5 shrink-0 rounded border",
              selectedCount > 0 ? "border-brand bg-brand" : "border-line bg-white",
            )}
          />
        )}
        <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: accent }} />
        <h3 className="truncate text-xs font-semibold text-ink">{queue.title}</h3>
        <span className="ml-auto rounded bg-black/5 px-1.5 text-[11px] font-medium text-ink-faint">
          {count}
        </span>
      </div>
      {headerExtra && <div className="px-2 pb-1">{headerExtra}</div>}

      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden rounded-lg border border-line bg-surface p-1.5 thin-scroll transition",
          queue.key === "processor_pickup" && count > 0 &&
            "border-amber-300/70 shadow-[0_0_10px_rgba(245,158,11,0.16)]",
          isOver && "border-brand/50 bg-brand/5 ring-1 ring-brand/30",
        )}
      >
        {children}
        {count === 0 && (
          <p className="px-1 py-3 text-center text-[11px] text-ink-faint">Empty</p>
        )}
      </div>
    </div>
  );
}
