import { CalendarClock, CheckCircle2, Clock3, FlaskConical, Pencil, Play, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProcessingBatch, Sample } from "../lib/types";
import { parseTimestamp } from "../lib/utils";
import { Button } from "./ui";

function countdown(batch: ProcessingBatch, now: number): string {
  if (batch.status === "planned") return "Planned — not started yet";
  if (batch.current_stage !== "processing_started") return "Complete — awaiting pickup";
  const ready = parseTimestamp(batch.ready_at);
  if (!ready) return "Ready time unavailable";
  const remaining = ready.getTime() - now;
  if (remaining <= 0) return "Completing now";
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m remaining` : `${minutes}m remaining`;
}

export function ProcessingBatchDetailsDrawer({
  batch,
  samples,
  onMove,
  onEditStart,
  onConfirmStart,
  width = 320,
  onClose,
}: {
  batch: ProcessingBatch;
  samples: Sample[];
  onMove: (batchId: number, stageKey: string) => void;
  /** Correct the batch start time (issue #6); recomputes ready time + members. */
  onEditStart?: (batchId: number, startedAt: string) => void;
  /** Confirm a planned run actually started (issue #4). */
  onConfirmStart?: (batchId: number, actualStartedAt?: string) => void;
  width?: number;
  onClose: () => void;
}) {
  const isPlanned = batch.status === "planned";
  const [now, setNow] = useState(() => Date.now());
  const [confirmAt, setConfirmAt] = useState(() =>
    (batch.planned_start_at ?? "").replace(" ", "T").slice(0, 16),
  );
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <aside className="flex h-full shrink-0 flex-col border-l border-line bg-panel" style={{ width }}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <FlaskConical size={16} className="text-brand" />
            <h2 className="text-base font-semibold text-ink">Processing Batch {batch.id}</h2>
          </div>
          <p className="mt-0.5 text-xs text-ink-faint">
            {batch.processing_type} protocol · {batch.member_count} samples
          </p>
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-ink-faint hover:bg-black/5 hover:text-ink">
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 thin-scroll">
        <div className="mb-4 rounded-lg border border-line bg-surface p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
            <Clock3 size={15} className="text-amber-600" /> {countdown(batch, now)}
          </div>
          <dl className="space-y-1 text-xs">
            {isPlanned ? (
              <Row label="Planned start" value={batch.planned_start_at ?? "—"} />
            ) : (
              <EditableStartRow
                value={batch.started_at}
                editable={
                  (batch.current_stage === "processing_started" ||
                    batch.current_stage === "processed") && Boolean(onEditStart)
                }
                onSave={(next) => onEditStart?.(batch.id, next)}
              />
            )}
            <Row label="Expected ready" value={batch.ready_at ?? "—"} />
            <Row label="Operator" value={batch.operator_name || "—"} />
            {batch.checklist_total > 0 && (
              <Row label="Checklist" value={`${batch.checklist_completed}/${batch.checklist_total}`} />
            )}
          </dl>
        </div>

        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Samples</h3>
        <div className="space-y-1.5">
          {samples.map((sample) => (
            <div key={sample.id} className="rounded-md border border-line bg-surface px-2.5 py-2">
              <div className="text-xs font-semibold text-ink">{sample.sample_code}</div>
              {sample.sample_description && <div className="truncate text-[11px] text-ink-soft">{sample.sample_description}</div>}
            </div>
          ))}
        </div>

        {batch.notes && (
          <div className="mt-4">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">Notes</h3>
            <p className="whitespace-pre-wrap text-sm text-ink-soft">{batch.notes}</p>
          </div>
        )}
      </div>

      <div className="border-t border-line px-4 py-3">
        {isPlanned ? (
          <>
            <label className="mb-1 flex items-center gap-1 text-xs font-medium text-ink-soft">
              <CalendarClock size={13} /> Actual start
            </label>
            <input
              type="datetime-local"
              value={confirmAt}
              onChange={(event) => setConfirmAt(event.target.value)}
              className="mb-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand"
            />
            <Button
              variant="primary"
              className="w-full"
              disabled={!onConfirmStart}
              onClick={() =>
                onConfirmStart?.(batch.id, confirmAt ? confirmAt.replace("T", " ").slice(0, 16) : undefined)
              }
            >
              <Play size={15} /> Confirm start &amp; begin countdown
            </Button>
          </>
        ) : batch.current_stage === "processing_started" ? (
          <>
            <p className="mb-2 text-xs text-amber-700">
              Moving this batch early will ask for confirmation before skipping the remaining countdown.
            </p>
            <Button variant="primary" className="w-full" onClick={() => onMove(batch.id, "processed")}>
              Mark Ready for Pickup
            </Button>
          </>
        ) : (
          <Button variant="primary" className="w-full" onClick={() => onMove(batch.id, "needs_embedding")}>
            <CheckCircle2 size={15} /> Picked Up — Needs Embedding
          </Button>
        )}
      </div>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-right text-ink-soft">{value}</dd>
    </div>
  );
}

function EditableStartRow({
  value,
  editable,
  onSave,
}: {
  value: string;
  editable: boolean;
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (!editable) return <Row label="Started" value={value} />;
  if (editing) {
    return (
      <div className="flex items-center justify-between gap-2">
        <dt className="text-ink-faint">Started</dt>
        <dd className="flex items-center gap-1">
          <input
            type="datetime-local"
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            className="rounded border border-line px-1 py-0.5 text-[11px] outline-none focus:border-brand"
          />
          <button
            onClick={() => {
              if (draft) onSave(draft.replace("T", " ").slice(0, 16));
              setEditing(false);
            }}
            className="rounded bg-brand px-1.5 py-0.5 text-[11px] text-white"
          >
            Set
          </button>
          <button
            onClick={() => setEditing(false)}
            className="rounded px-1 py-0.5 text-[11px] text-ink-faint hover:bg-black/5"
          >
            Cancel
          </button>
        </dd>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-ink-faint">Started</dt>
      <dd className="flex items-center gap-2">
        <span className="text-ink-soft">{value}</span>
        <button
          onClick={() => {
            setDraft(value.replace(" ", "T"));
            setEditing(true);
          }}
          className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] font-medium text-brand hover:bg-brand/5"
        >
          <Pencil size={11} /> Edit
        </button>
      </dd>
    </div>
  );
}
