import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Plus, Scissors, X } from "lucide-react";
import { Button, Modal } from "./ui";
import { parsePreselectedStains } from "../lib/db";
import type { Sample } from "../lib/types";
import { cn, displayCode } from "../lib/utils";

// A single slide the technician plans to cut: either a plain Extra or a slide
// carrying one stain/IHC agent. Encoded as "extra" or "<type>::<name>".
type SlideRow = { key: number; value: string };

export interface Group {
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

/** The rows a block should start with: outstanding requested stains first
 *  (#41), else its saved plan, else four extras (#4). */
function effectiveRows(sample: Sample): SlideRow[] {
  const pending = parsePreselectedStains(sample.pending_stains);
  if (pending.length) {
    const extras = Math.max(2, 4 - pending.length);
    let key = 0;
    return [
      ...pending.map((a) => ({ key: key++, value: `${a.assay_type}::${a.assay_name}` })),
      ...Array.from({ length: extras }, () => ({ key: key++, value: "extra" })),
    ];
  }
  const existing = planToRows(sample.sectioning_plan);
  return existing.length ? existing : [0, 1, 2, 3].map((key) => ({ key, value: "extra" }));
}

/** Aggregate per-slide rows back into homogeneous cut groups. */
function rowsToGroups(rows: SlideRow[]): Group[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.value, (counts.get(row.value) ?? 0) + 1);
  const groups: Group[] = [];
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
  batchSamples,
  onSendPlans,
  onSave,
  onClose,
}: {
  sample: Sample;
  /** Stain/IHC agents the technician can attach to a slide. */
  catalog?: Array<{ assay_type: string; name: string }>;
  /** The selected embedded blocks when sending a batch (includes `sample`). */
  batchSamples?: Sample[];
  /** Cut every block by its own (reviewed/edited) plan. */
  onSendPlans: (entries: Array<{ sampleId: number; groups: Group[] }>) => Promise<void>;
  /** Save the shown block's plan as a draft (single-block only). */
  onSave?: (sampleId: number, plan: Group[]) => Promise<void>;
  onClose: () => void;
}) {
  const blocks = batchSamples && batchSamples.length > 0 ? batchSamples : [sample];
  const isBatch = blocks.length > 1;
  const [index, setIndex] = useState(0);
  const active = Math.min(index, blocks.length - 1);
  const current = blocks[active] ?? sample;
  // One editable plan per block, each seeded from that block's effective plan.
  const [plans, setPlans] = useState<SlideRow[][]>(() => blocks.map(effectiveRows));
  const [busy, setBusy] = useState(false);
  const nextKey = useRef(1000);
  const rows = plans[active] ?? [];

  const stainCount = rows.filter((r) => r.value !== "extra").length;
  const extraCount = rows.length - stainCount;
  const canSend = blocks.every((b) => b.current_stage === "embedded");
  const preselected = Boolean(current.pending_stains);

  function updateRows(fn: (rs: SlideRow[]) => SlideRow[]) {
    setPlans((ps) => ps.map((p, i) => (i === active ? fn(p) : p)));
  }
  function setRow(key: number, value: string) {
    updateRows((rs) => rs.map((r) => (r.key === key ? { ...r, value } : r)));
  }
  function addRow() {
    updateRows((rs) => [...rs, { key: (nextKey.current += 1), value: "extra" }]);
  }
  function removeRow(key: number) {
    updateRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : rs));
  }
  function copyToAll() {
    setPlans((ps) => ps.map(() => rows.map((r, i) => ({ key: i, value: r.value }))));
  }

  async function send() {
    setBusy(true);
    const entries = blocks.map((b, i) => ({ sampleId: b.id, groups: rowsToGroups(plans[i]) }));
    await onSendPlans(entries);
    setBusy(false);
    onClose();
  }
  async function saveDraft() {
    if (!onSave) return;
    setBusy(true);
    await onSave(current.id, rowsToGroups(rows));
    setBusy(false);
    onClose();
  }

  return (
    <Modal
      title={isBatch ? `Send for Cutting · ${blocks.length} blocks` : `Send for Cutting · ${displayCode(current.sample_code)}`}
      onClose={onClose}
    >
      {isBatch && (
        <div className="mb-3 flex items-center gap-1">
          <Button variant="ghost" className="shrink-0 px-1.5" disabled={active === 0} onClick={() => setIndex(active - 1)}>
            <ChevronLeft size={15} />
          </Button>
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto thin-scroll">
            {blocks.map((b, i) => {
              const hasStain = (plans[i] ?? []).some((r) => r.value !== "extra");
              return (
                <button
                  key={b.id}
                  onClick={() => setIndex(i)}
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
                    i === active ? "bg-brand text-white" : "bg-surface text-ink-soft hover:bg-brand/10",
                  )}
                >
                  {displayCode(b.sample_code)}
                  <span className={cn("h-1.5 w-1.5 rounded-full", hasStain ? "bg-amber-400" : "bg-transparent")} />
                </button>
              );
            })}
          </div>
          <Button variant="ghost" className="shrink-0 px-1.5" disabled={active === blocks.length - 1} onClick={() => setIndex(active + 1)}>
            <ChevronRight size={15} />
          </Button>
        </div>
      )}

      <p className="mb-2 text-xs text-ink-faint">
        {isBatch && (
          <>
            Plan for <strong className="text-ink-soft">{displayCode(current.sample_code)}</strong> · block {active + 1} of{" "}
            {blocks.length}
            {current.sample_description ? ` — ${current.sample_description}` : ""}. <br />
          </>
        )}
        How many slides to cut, and which carry a stain? Everything else is an extra.
      </p>

      {preselected && (
        <p className="mb-3 rounded-md bg-brand/10 px-2 py-1.5 text-xs text-brand">
          Prefilled from {displayCode(current.sample_code)}'s preselected stains ({current.pending_stains}).
        </p>
      )}

      <div className="mb-1 grid grid-cols-[1.5rem_auto_1.25rem] items-center gap-2 px-1 text-[11px] font-medium text-ink-faint">
        <span>#</span>
        <span>Slide</span>
        <span />
      </div>

      <div className="max-h-64 space-y-2 overflow-y-auto thin-scroll">
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
        {rows.length} {rows.length === 1 ? "slide" : "slides"} · {stainCount} stained · {extraCount} extra
      </p>

      {isBatch && (
        <p className="mt-2 rounded-md bg-brand/10 px-2 py-1.5 text-xs text-brand">
          Each block is cut by its own plan — page through the blocks above to review or edit them. Sending cuts all {blocks.length}.
        </p>
      )}
      {!canSend && (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
          Cutting unlocks once every block reaches Embedded Inventory.
        </p>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {isBatch ? (
          <Button variant="subtle" onClick={copyToAll} disabled={busy} title="Copy this block's plan to every selected block">
            <Copy size={14} /> Copy to all blocks
          </Button>
        ) : (
          onSave && (
            <Button variant="subtle" onClick={saveDraft} disabled={busy}>
              Save Plan
            </Button>
          )
        )}
        <Button
          variant="primary"
          onClick={send}
          disabled={busy || rows.length === 0 || !canSend}
          title={!canSend ? "Embed the block(s) before sending to sectioning." : undefined}
        >
          <Scissors size={14} /> Send for Cutting
          {isBatch ? ` · ${blocks.length} blocks` : ""}
        </Button>
      </div>
    </Modal>
  );
}
