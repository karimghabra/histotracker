import { CheckCircle2, Clock3, FlaskConical, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProcessingBatch, Sample } from "../lib/types";
import { parseTimestamp } from "../lib/utils";
import { Button } from "./ui";

function countdown(batch: ProcessingBatch, now: number): string {
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
  onClose,
}: {
  batch: ProcessingBatch;
  samples: Sample[];
  onMove: (batchId: number, stageKey: string) => void;
  onClose: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-panel">
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
            <Row label="Started" value={batch.started_at} />
            <Row label="Expected ready" value={batch.ready_at ?? "—"} />
            <Row label="Operator" value={batch.operator_name || "—"} />
            <Row label="Checklist" value={`${batch.checklist_completed}/${batch.checklist_total}`} />
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
        {batch.current_stage === "processing_started" ? (
          <>
            <p className="mb-2 text-xs text-amber-700">
              Moving this batch early will ask for confirmation before skipping the remaining countdown.
            </p>
            <Button variant="primary" className="w-full" onClick={() => onMove(batch.id, "processed")}>
              Move to Processor Pickup
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
