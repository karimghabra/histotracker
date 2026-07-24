import { useState } from "react";
import { Plus, Scissors, X } from "lucide-react";
import { Button, Modal } from "./ui";
import type { Sample } from "../lib/types";

interface Row {
  duplicates: number;
  stains: string;
  cut: boolean;
}

function parsePlan(raw: string): Row[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((r) => ({
      duplicates: Math.max(1, Number(r.duplicates) || 1),
      stains: typeof r.stains === "string" ? r.stains : "",
      cut: false,
    }));
  } catch {
    return [];
  }
}

export function SectioningPlanDialog({
  sample,
  batchCount = 1,
  onSave,
  onSend,
  onClose,
}: {
  sample: Sample;
  /** When > 1, the same plan is sent to that many selected embedded blocks (#8). */
  batchCount?: number;
  onSave: (plan: Array<{ duplicates: number; stains?: string }>) => Promise<void>;
  onSend: (groups: Array<{ duplicates: number; stains?: string }>) => Promise<void>;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => {
    const existing = parsePlan(sample.sectioning_plan);
    return existing.length ? existing : [{ duplicates: 4, stains: "", cut: false }];
  });
  const [busy, setBusy] = useState(false);

  const selected = rows.filter((r) => r.cut);
  const totalSlides = rows.reduce((sum, r) => sum + Math.max(1, r.duplicates), 0);
  // Cutting is only allowed once the block is embedded (issue #7). Planning
  // ahead (Save Plan) stays available at any stage.
  const canSend = sample.current_stage === "embedded";
  // When stains were preselected at sample creation the plan is prefilled and
  // saved, so the technician only has to confirm (0.3.3).
  const preselected = Boolean(sample.pending_stains);

  function update(index: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function planOnly(): Array<{ duplicates: number; stains?: string }> {
    return rows.map((r) => ({
      duplicates: Math.max(1, Number(r.duplicates) || 1),
      stains: r.stains.trim(),
    }));
  }

  async function savePlan() {
    setBusy(true);
    await onSave(planOnly());
    setBusy(false);
    onClose();
  }

  async function sendSelected() {
    setBusy(true);
    await onSave(planOnly()); // persist the plan too
    await onSend(selected.map((r) => ({ duplicates: Math.max(1, r.duplicates), stains: r.stains.trim() })));
    setBusy(false);
    onClose();
  }

  return (
    <Modal title={`Sectioning Plan · ${sample.sample_code}`} onClose={onClose}>
      <p className="mb-3 text-xs text-ink-faint">
        {sample.sample_description ? `${sample.sample_description}` : "Plan the slides to cut for this block."}
      </p>

      {preselected && (
        <p className="mb-3 rounded-md bg-brand/10 px-2 py-1.5 text-xs text-brand">
          Preselected — the stains for this block are already requested ({sample.pending_stains}). Just confirm the cut.
        </p>
      )}

      <div className="mb-1 grid grid-cols-[1.5rem_1.25rem_auto_1fr_1.25rem] items-center gap-2 px-1 text-[11px] font-medium text-ink-faint">
        <span title="Cut this group">Cut</span>
        <span>#</span>
        <span>Dupes</span>
        <span>Stains (optional)</span>
        <span />
      </div>

      <div className="space-y-2">
        {rows.map((row, i) => (
          <div
            key={i}
            className="grid grid-cols-[1.5rem_1.25rem_auto_1fr_1.25rem] items-center gap-2"
          >
            <input
              type="checkbox"
              checked={row.cut}
              onChange={(e) => update(i, { cut: e.target.checked })}
              className="h-4 w-4 accent-[var(--color-brand)]"
            />
            <span className="text-sm text-ink-faint">{i + 1}.</span>
            <input
              type="number"
              value={row.duplicates}
              min={1}
              max={99}
              onChange={(e) => update(i, { duplicates: Number(e.target.value) })}
              className="w-16 rounded-lg border border-line bg-white px-3 py-1.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
            <input
              type="text"
              value={row.stains}
              placeholder="e.g. H&E, SafO"
              onChange={(e) => update(i, { stains: e.target.value })}
              className="w-full rounded-lg border border-line bg-white px-3 py-1.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
            <button
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              disabled={rows.length === 1}
              className="rounded-md p-1 text-ink-faint hover:bg-black/5 hover:text-ink disabled:opacity-30"
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>

      <Button
        variant="ghost"
        className="mt-3"
        onClick={() => setRows((rs) => [...rs, { duplicates: 1, stains: "", cut: false }])}
      >
        <Plus size={15} /> Add Section
      </Button>

      <p className="mt-3 text-xs text-ink-soft">
        {rows.length} {rows.length === 1 ? "section" : "sections"} · {totalSlides} planned{" "}
        {totalSlides === 1 ? "slide" : "slides"}
        {selected.length > 0 && (
          <span className="text-brand"> · {selected.length} selected to cut</span>
        )}
      </p>

      {batchCount > 1 && (
        <p className="mt-2 rounded-md bg-brand/10 px-2 py-1.5 text-xs text-brand">
          This plan will be sent to all {batchCount} selected embedded blocks.
        </p>
      )}
      {!canSend && (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
          Cutting unlocks once this block reaches Embedded Inventory. You can still save the plan now.
        </p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="subtle" onClick={savePlan} disabled={busy}>
          Save Plan
        </Button>
        <Button
          variant="primary"
          onClick={sendSelected}
          disabled={busy || selected.length === 0 || !canSend}
          title={!canSend ? "Embed this block before sending it to sectioning." : undefined}
        >
          <Scissors size={14} /> Send {selected.length || ""} to Sectioning
          {batchCount > 1 ? ` · ${batchCount} blocks` : ""}
        </Button>
      </div>
    </Modal>
  );
}
