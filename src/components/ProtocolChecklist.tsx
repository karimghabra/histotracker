import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";
import { ensureChecklist, setChecklistItemComplete } from "../lib/db";
import { cn } from "../lib/utils";

export function ProtocolChecklist({
  scopeType,
  scopeId,
  stageKey,
  protocolName,
  labels,
  onStepChange,
}: {
  scopeType: string;
  scopeId: number;
  stageKey: string;
  protocolName: string;
  labels: string[];
  onStepChange?: (sortOrder: number, complete: boolean) => Promise<void>;
}) {
  const qc = useQueryClient();
  const queryKey = ["protocol-checklist", scopeType, scopeId, stageKey];
  const { data: items = [] } = useQuery({
    queryKey,
    queryFn: () => ensureChecklist({ scopeType, scopeId, stageKey, protocolName, labels }),
  });
  const [operator, setOperator] = useState(
    () => window.localStorage.getItem("histometer-active-operator") ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const complete = items.filter((item) => item.is_complete === 1).length;

  async function toggle(itemId: number, value: boolean) {
    if (!operator.trim()) {
      setError("Enter the active operator before completing protocol steps.");
      return;
    }
    setError(null);
    window.localStorage.setItem("histometer-active-operator", operator.trim());
    await setChecklistItemComplete(itemId, value, operator.trim());
    const item = items.find((candidate) => candidate.id === itemId);
    if (item && onStepChange) await onStepChange(item.sort_order, value);
    await qc.invalidateQueries({ queryKey });
    await qc.invalidateQueries({ queryKey: ["open-sections"] });
    await qc.invalidateQueries({ queryKey: ["section-slides"] });
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
        <input
          value={operator}
          onChange={(event) => setOperator(event.target.value)}
          placeholder="Operator"
          aria-label="Active operator"
          className="w-24 rounded border border-line bg-panel px-2 py-1 text-xs text-ink outline-none focus:border-brand"
        />
      </div>
      {!operator.trim() && (
        <p className="mb-2 text-[11px] text-amber-700">
          Enter an operator before checking workflow steps.
        </p>
      )}
      <ol className="space-y-1.5">
        {items.map((item) => {
          const done = item.is_complete === 1;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => void toggle(item.id, !done)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition",
                  done
                    ? "border-brand/30 bg-brand/5 text-ink"
                    : "border-line bg-panel text-ink hover:border-brand/50",
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
