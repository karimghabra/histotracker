import { useState } from "react";
import { Plus, Scissors, X } from "lucide-react";
import { Button, Modal } from "./ui";
import type { Sample } from "../lib/types";

interface Row {
  depth_um: number;
  duplicates: number;
  cut: boolean;
}

const DEPTH_SUGGESTIONS = [50, 100, 150, 200, 250, 500];

function parsePlan(raw: string): Row[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((r) => ({
      depth_um: Number(r.depth_um) || 0,
      duplicates: Math.max(1, Number(r.duplicates) || 1),
      cut: false,
    }));
  } catch {
    return [];
  }
}

export function SectioningPlanDialog({
  sample,
  onSave,
  onSend,
  onClose,
}: {
  sample: Sample;
  onSave: (plan: Array<{ depth_um: number; duplicates: number }>) => Promise<void>;
  onSend: (groups: Array<{ depth_um: number; duplicates: number }>) => Promise<void>;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => {
    const existing = parsePlan(sample.sectioning_plan);
    return existing.length ? existing : [{ depth_um: 100, duplicates: 1, cut: false }];
  });
  const [busy, setBusy] = useState(false);

  const selected = rows.filter((r) => r.cut);
  const totalSlides = rows.reduce((sum, r) => sum + Math.max(1, r.duplicates), 0);

  function update(index: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function planOnly(): Array<{ depth_um: number; duplicates: number }> {
    return rows.map((r) => ({
      depth_um: Number(r.depth_um) || 0,
      duplicates: Math.max(1, Number(r.duplicates) || 1),
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
    await onSend(
      selected.map((r) => ({ depth_um: Number(r.depth_um) || 0, duplicates: Math.max(1, r.duplicates) })),
    );
    setBusy(false);
    onClose();
  }

  return (
    <Modal title={`Sectioning Plan · ${sample.sample_code}`} onClose={onClose}>
      <p className="mb-3 text-xs text-ink-faint">
        {sample.sample_description ? `${sample.sample_description} · ` : ""}
        Deepest cut requested so far:{" "}
        <span className="font-medium text-ink-soft">
          {sample.max_cut_depth_um != null ? `${sample.max_cut_depth_um}µm` : "none yet"}
        </span>
      </p>

      <datalist id="depth-suggestions">
        {DEPTH_SUGGESTIONS.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>

      <div className="mb-1 grid grid-cols-[1.5rem_1.25rem_1fr_auto_1.25rem] items-center gap-2 px-1 text-[11px] font-medium text-ink-faint">
        <span title="Cut this group">Cut</span>
        <span>#</span>
        <span>Depth (µm)</span>
        <span>Dupes</span>
        <span />
      </div>

      <div className="space-y-2">
        {rows.map((row, i) => (
          <div
            key={i}
            className="grid grid-cols-[1.5rem_1.25rem_1fr_auto_1.25rem] items-center gap-2"
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
              list="depth-suggestions"
              value={row.depth_um}
              min={0}
              onChange={(e) => update(i, { depth_um: Number(e.target.value) })}
              className="w-full rounded-lg border border-line bg-white px-3 py-1.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
            <input
              type="number"
              value={row.duplicates}
              min={1}
              max={99}
              onChange={(e) => update(i, { duplicates: Number(e.target.value) })}
              className="w-16 rounded-lg border border-line bg-white px-3 py-1.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
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
        onClick={() => setRows((rs) => [...rs, { depth_um: 100, duplicates: 1, cut: false }])}
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

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="subtle" onClick={savePlan} disabled={busy}>
          Save Plan
        </Button>
        <Button variant="primary" onClick={sendSelected} disabled={busy || selected.length === 0}>
          <Scissors size={14} /> Send {selected.length || ""} to Sectioning
        </Button>
      </div>
    </Modal>
  );
}
