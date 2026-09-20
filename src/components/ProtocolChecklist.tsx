import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";
import { ensureChecklist, setChecklistItemComplete, snapshotDb } from "../lib/db";
import { useActiveUser } from "../hooks/useData";
import { readOnlyMessage, useReadOnly, useReadOnlyReason } from "../lib/readOnly";
import { useUndoStore } from "../lib/undo";
import { cn } from "../lib/utils";

export function ProtocolChecklist({
  scopeType,
  scopeId,
  stageKey,
  protocolName,
  labels,
  batchScopeIds = [],
  onStepChange,
}: {
  scopeType: string;
  scopeId: number;
  stageKey: string;
  protocolName: string;
  labels: string[];
  batchScopeIds?: number[];
  onStepChange?: (sortOrder: number, complete: boolean, scopeIds: number[]) => Promise<void>;
}) {
  const qc = useQueryClient();
  const queryKey = ["protocol-checklist", scopeType, scopeId, stageKey];
  const { data: items = [] } = useQuery({
    queryKey,
    queryFn: () => ensureChecklist({ scopeType, scopeId, stageKey, protocolName, labels }),
  });
  // The operator IS the signed-in user (#127).
  //
  // There used to be a free-text "Operator" box here, and a localStorage mirror
  // of the signed-in user's name to prefill it — a second, editable identity
  // sitting beside the real one. It could be typed over, it could go stale, and
  // it was the only thing standing between an unsigned session and a completed
  // protocol step. The user directory is the answer to "who did this"; there is
  // no reason for a second one.
  const { data: activeUser = null } = useActiveUser();
  const readOnly = useReadOnly();
  const reason = useReadOnlyReason();
  const operator = activeUser?.name ?? "";
  const [error, setError] = useState<string | null>(null);
  const record = useUndoStore((s) => s.record);
  const complete = items.filter((item) => item.is_complete === 1).length;
  // Two ways to be locked out, one greyed-out checklist, and the message says
  // which: a viewer is told to use the workstation, an unsigned user to sign in.
  const gateReason = readOnly ? reason : operator.trim() ? null : "signed-out";
  const disabled = gateReason !== null;

  async function toggle(itemId: number, value: boolean) {
    if (disabled) {
      setError(readOnlyMessage(gateReason));
      return;
    }
    setError(null);
    const item = items.find((candidate) => candidate.id === itemId);
    const scopeIds = [...new Set([scopeId, ...batchScopeIds])];
    try {
      // Snapshot BEFORE the step so Undo peels back one protocol step (and the
      // staining→imaging scatter it triggers) at a time, instead of jumping to
      // the last board-level action (#56).
      const before = await snapshotDb();
      await setChecklistItemComplete(itemId, value, operator.trim());
      if (item) {
        for (const targetScopeId of scopeIds) {
          if (targetScopeId === scopeId) continue;
          const targetItems = await ensureChecklist({
            scopeType,
            scopeId: targetScopeId,
            stageKey,
            protocolName,
            labels,
          });
          const targetItem = targetItems.find((candidate) => candidate.sort_order === item.sort_order);
          if (targetItem) await setChecklistItemComplete(targetItem.id, value, operator.trim());
        }
        if (onStepChange) await onStepChange(item.sort_order, value, scopeIds);
        record({ label: `${value ? "Complete" : "Undo"} · ${item.label}`, snapshot: before });
      }
    } catch (err) {
      // Never fail silently: a step whose stage write throws (e.g. a DB opened
      // on an image missing a stage column) must surface, not look like a dead
      // checkbox (#58). The refresh below still runs so the UI reflects DB truth.
      setError(err instanceof Error ? err.message : "Could not record this step.");
    }
    // Always refresh — even after a failure — so the checkbox mirrors what
    // actually persisted rather than a stale render.
    await qc.invalidateQueries({ queryKey });
    await Promise.all(scopeIds.map((id) => qc.invalidateQueries({ queryKey: ["protocol-checklist", scopeType, id, stageKey] })));
    await qc.invalidateQueries({ queryKey: ["open-sections"] });
    await qc.invalidateQueries({ queryKey: ["open-slide-stacks"] });
    await qc.invalidateQueries({ queryKey: ["section-slides"] });
    await qc.invalidateQueries({ queryKey: ["stack-slides"] });
  }

  return (
    <section className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {protocolName}
          </h3>
          <p className="text-[10px] text-ink-faint">Protocol v1 · {complete}/{items.length} complete</p>
        </div>
        {operator && (
          <span
            className="truncate text-[11px] text-ink-faint"
            title="Steps are recorded under this name"
          >
            {operator}
          </span>
        )}
      </div>
      {disabled && <p className="mb-2 text-[11px] text-amber-700">{readOnlyMessage(gateReason)}</p>}
      <ol className="space-y-1.5">
        {items.map((item) => {
          const done = item.is_complete === 1;
          return (
            <li key={item.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void toggle(item.id, !done)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition",
                  done
                    ? "border-brand/30 bg-brand/5 text-ink"
                    : "border-line bg-panel text-ink",
                  // Greyed rather than merely inert, so the message above reads
                  // as the explanation for something visibly unavailable (#127).
                  disabled ? "cursor-not-allowed opacity-50" : "hover:border-brand/50",
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                    done ? "border-brand bg-brand text-white" : "border-ink-faint/40",
                  )}
                >
                  {done && <Check size={10} strokeWidth={3} />}
                </span>
                <span className="flex-1">{item.label}</span>
                {done && <span className="text-[10px] text-ink-faint">{item.completed_by}</span>}
              </button>
            </li>
          );
        })}
      </ol>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </section>
  );
}
