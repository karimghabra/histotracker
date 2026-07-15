import { Check } from "lucide-react";
import type { Sample } from "../lib/types";
import { cn } from "../lib/utils";

interface Step {
  key: string;
  label: string;
  column: keyof Sample;
  decalcOnly?: boolean;
}

const STEPS: Step[] = [
  { key: "in_fixative", label: "Placed in fixative", column: "fixative_placed_at" },
  { key: "fixative_removed", label: "Removed from fixative", column: "fixative_removed_at" },
  { key: "decalcified", label: "Decalcification complete", column: "decalc_completed_at", decalcOnly: true },
  { key: "in_ethanol", label: "Placed in ethanol", column: "ethanol_placed_at" },
];

export function PreprocessingChecklist({
  samples,
  onCheck,
}: {
  samples: Sample[];
  onCheck: (stageKey: string, sampleIds: number[]) => void;
}) {
  const steps = STEPS.filter(
    (step) => !step.decalcOnly || samples.some((sample) => sample.needs_decalcification === 1),
  );

  return (
    <div className="mb-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Pre-processing
      </h3>
      <ol className="space-y-1.5">
        {steps.map((step, index) => {
          const relevant = samples.filter(
            (sample) => !step.decalcOnly || sample.needs_decalcification === 1,
          );
          const incomplete = relevant.filter((sample) => !sample[step.column]);
          const blocked = incomplete.filter((sample) => {
            if (index === 0) return false;
            const previous = steps[index - 1];
            return !sample[previous.column];
          });
          const completedCount = relevant.length - incomplete.length;
          const done = relevant.length > 0 && incomplete.length === 0;
          const partial = completedCount > 0 && !done;
          const gated = incomplete.length > 0 && blocked.length > 0;
          const disabled = done || incomplete.length === 0 || gated;
          const timestamps = relevant
            .map((sample) => sample[step.column] as string | null)
            .filter((value): value is string => Boolean(value))
            .sort();
          const latestTimestamp = timestamps[timestamps.length - 1];

          return (
            <li key={step.key}>
              <button
                onClick={() =>
                  !disabled && onCheck(step.key, incomplete.map((sample) => sample.id))
                }
                disabled={disabled}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition",
                  done
                    ? "border-brand/30 bg-brand/5"
                    : gated
                      ? "cursor-not-allowed border-line bg-surface opacity-60"
                      : "border-line bg-white hover:border-brand/50 hover:bg-brand/5",
                )}
              >
                <span
                  className={cn(
                    "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border",
                    done
                      ? "border-brand bg-brand text-white"
                      : partial
                        ? "border-brand bg-brand/20 text-brand"
                        : "border-ink-faint/40",
                  )}
                >
                  {(done || partial) && <Check size={12} strokeWidth={3} />}
                </span>
                <span className="flex-1 text-ink">{step.label}</span>
                {relevant.length > 1 && (
                  <span className="text-[11px] text-ink-faint">
                    {completedCount}/{relevant.length}
                  </span>
                )}
                {relevant.length === 1 && latestTimestamp && (
                  <span className="text-[11px] text-ink-faint">{latestTimestamp}</span>
                )}
                {gated && (
                  <span className="text-[11px] text-amber-600">
                    previous step
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
