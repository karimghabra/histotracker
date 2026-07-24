import { useRef, useState } from "react";
import { Plus, Scissors, X } from "lucide-react";
import { Button, Modal } from "./ui";
import type { Sample } from "../lib/types";

// A single slide the technician plans to cut: either a plain Extra or a slide
// carrying one stain/IHC agent. Encoded as "extra" or "<type>::<name>".
type SlideRow = { key: number; value: string };

interface Group {
  duplicates: number;
  stains?: string;
  assay_type?: string;
  assay_name?: string;
}

/** Expand a saved sectioning plan (grouped) into one row per slide. */
function planToRows(raw: string): SlideRow[] {
  let key = 0;
  const rows: SlideRow[] = [];
  try {
    const plan = JSON.parse(raw) as Group[];
    if (Array.isArray(plan)) {
      for (const g of plan) {
        const n = Math.max(1, Number(g.duplicates) || 1);
        const value = g.assay_name ? `${g.assay_type || "stain"}::${g.assay_name}` : "extra";
        for (let i = 0; i < n; i += 1) rows.push({ key: key++, value });
      }
    }
  } catch {
    /* fall through to default below */
  }
  return rows;
}

/** Aggregate per-slide rows back into homogeneous cut groups. */
function rowsToGroups(rows: SlideRow[]): Group[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.value, (counts.get(row.value) ?? 0) + 1);
  const groups: Group[] = [];
  // Stains first, then a single extras group — mirrors the auto-plan shape.
  for (const [value, n] of counts) {
    if (value === "extra") continue;
    const [assay_type, assay_name] = value.split("::");
    groups.push({ duplicates: n, stains: assay_name, assay_type, assay_name });
  }
  const extras = counts.get("extra") ?? 0;
  if (extras > 0) groups.push({ duplicates: extras, stains: "" });
  return groups;
}

export function SectioningPlanDialog({
  sample,
  catalog = [],
  batchCount = 1,
  onSave,
  onSend,
  onClose,
}: {
  sample: Sample;
  /** Stain/IHC agents the technician can attach to a slide. */
  catalog?: Array<{ assay_type: string; name: string }>;
  /** When > 1, the same plan is sent to that many selected embedded blocks (#8). */
  batchCount?: number;
  onSave: (plan: Group[]) => Promise<void>;
  onSend: (groups: Group[]) => Promise<void>;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<SlideRow[]>(() => {
    const existing = planToRows(sample.sectioning_plan);
    // Default cut: four extras (issue #4 — at least four slides, two extra).
    return existing.length
      ? existing
      : [0, 1, 2, 3].map((key) => ({ key, value: "extra" }));
  });
  const [busy, setBusy] = useState(false);
  const nextKey = useRef(1000);

  const stainCount = rows.filter((r) => r.value !== "extra").length;
  const extraCount = rows.length - stainCount;
  // Cutting is only allowed once the block is embedded (issue #7).
  const canSend = sample.current_stage === "embedded";
  const preselected = Boolean(sample.pending_stains);

  function setRow(key: number, value: string) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, value } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, { key: (nextKey.current += 1), value: "extra" }]);
  }
  function removeRow(key: number) {
    setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : rs));
  }

  async function savePlan() {
    setBusy(true);
    await onSave(rowsToGroups(rows));
    setBusy(false);
    onClose();
  }

  async function sendForCutting() {
    setBusy(true);
    const groups = rowsToGroups(rows);
    await onSave(groups); // keep the plan in sync
    await onSend(groups);
    setBusy(false);
    onClose();
  }

  return (
    <Modal title={`Send for Cutting · ${sample.sample_code}`} onClose={onClose}>
      <p className="mb-3 text-xs text-ink-faint">
        How many slides to cut, and which carry a stain? Everything else is an extra.
      </p>

      {preselected && (
        <p className="mb-3 rounded-md bg-brand/10 px-2 py-1.5 text-xs text-brand">
          Prefilled from this block's preselected stains ({sample.pending_stains}). Adjust if needed, then send.
        </p>
      )}

      <div className="mb-1 grid grid-cols-[1.5rem_auto_1.25rem] items-center gap-2 px-1 text-[11px] font-medium text-ink-faint">
        <span>#</span>
        <span>Slide</span>
        <span />
      </div>

      <div className="max-h-72 space-y-2 overflow-y-auto thin-scroll">
        {rows.map((row, i) => (
          <div key={row.key} className="grid grid-cols-[1.5rem_auto_1.25rem] items-center gap-2">
            <span className="text-sm text-ink-faint">{i + 1}.</span>
            <select
              value={row.value}
              onChange={(e) => setRow(row.key, e.target.value)}
              className="w-full rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            >
              <option value="extra">Extra (no stain)</option>
              <optgroup label="Stains">
                {catalog.filter((c) => c.assay_type === "stain").map((c) => (
                  <option key={`stain-${c.name}`} value={`stain::${c.name}`}>{c.name}</option>
                ))}
              </optgroup>
              <optgroup label="IHC">
                {catalog.filter((c) => c.assay_type === "ihc").map((c) => (
                  <option key={`ihc-${c.name}`} value={`ihc::${c.name}`}>{c.name}</option>
                ))}
              </optgroup>
            </select>
            <button
              onClick={() => removeRow(row.key)}
              disabled={rows.length === 1}
              className="rounded-md p-1 text-ink-faint hover:bg-black/5 hover:text-ink disabled:opacity-30"
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>

      <Button variant="ghost" className="mt-3" onClick={addRow}>
        <Plus size={15} /> Add Slide
      </Button>

      <p className="mt-3 text-xs text-ink-soft">
        {rows.length} {rows.length === 1 ? "slide" : "slides"} · {stainCount} stained ·{" "}
        {extraCount} extra
      </p>

      {batchCount > 1 && (
        <p className="mt-2 rounded-md bg-brand/10 px-2 py-1.5 text-xs text-brand">
          This cut will be sent to all {batchCount} selected embedded blocks.
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
          onClick={sendForCutting}
          disabled={busy || rows.length === 0 || !canSend}
          title={!canSend ? "Embed this block before sending it to sectioning." : undefined}
        >
          <Scissors size={14} /> Send for Cutting
          {batchCount > 1 ? ` · ${batchCount} blocks` : ""}
        </Button>
      </div>
    </Modal>
  );
}
