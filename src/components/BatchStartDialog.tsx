import { useMemo, useState } from "react";
import type { ProcessingType, Sample } from "../lib/types";
import { nowTimestamp } from "../lib/utils";
import { Button, Field, Modal, TextArea, TextInput } from "./ui";

export function BatchStartDialog({
  samples,
  activeOperator,
  onStart,
  onPlan,
  onClose,
}: {
  samples: Sample[];
  activeOperator: string;
  onStart: (input: {
    sampleIds: number[];
    processingType: ProcessingType;
    operatorName: string;
    startedAt: string;
    checklistLabels: string[];
    notes?: string;
  }) => Promise<void>;
  onPlan: (input: {
    sampleIds: number[];
    processingType: ProcessingType;
    operatorName: string;
    plannedStartAt: string;
    notes?: string;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const processingType = samples[0]?.processing_type ?? "Short";
  const incompatible = samples.some((sample) => sample.processing_type !== processingType);
  const [startedAt, setStartedAt] = useState(nowTimestamp().replace(" ", "T"));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memberSummary = useMemo(() => samples.map((sample) => sample.sample_code).join(", "), [samples]);

  // A run is "planned" when its start time is in the future, otherwise it starts
  // now — inferred from the single start-time field, not a separate mode tab
  // (issue #42). A one-minute grace keeps "now" from flipping to planned while
  // the dialog sits open (issues #4, #24 handle the planned-run lifecycle).
  const startMs = new Date(startedAt).getTime();
  const isPlanned = Number.isFinite(startMs) && startMs > Date.now() + 60_000;
  const mode = isPlanned ? "plan" : "now";

  async function start() {
    if (!activeOperator) {
      setError("Sign in before starting a processing batch.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const timestamp = startedAt.replace("T", " ").slice(0, 16);
      if (mode === "plan") {
        await onPlan({
          sampleIds: samples.map((sample) => sample.id),
          processingType,
          operatorName: activeOperator,
          plannedStartAt: timestamp,
          notes: notes.trim(),
        });
      } else {
        // Two runs may overlap freely — the technician decides (issue #23).
        await onStart({
          sampleIds: samples.map((sample) => sample.id),
          processingType,
          operatorName: activeOperator,
          startedAt: timestamp,
          // The technician loads the processor away from the app, so no
          // load-time checklist is recorded here (see issue #3).
          checklistLabels: [],
          notes: notes.trim(),
        });
      }
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${mode === "plan" ? "Plan" : "Start"} ${processingType} Processing Batch`} onClose={onClose} width="max-w-xl">
      <div className="mb-4 rounded-lg border border-line bg-surface px-3 py-2">
        <div className="text-xs font-semibold text-ink">{samples.length} selected samples</div>
        <div className="mt-1 max-h-20 overflow-y-auto text-xs text-ink-soft thin-scroll">
          {memberSummary}
        </div>
      </div>

      {incompatible && (
        <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          The selection mixes Short and Long protocols. Start separate batches.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Active Operator">
          <div className={`rounded-lg border px-3 py-2 text-sm ${activeOperator ? "border-line bg-surface text-ink" : "border-amber-300 bg-amber-50 text-amber-800"}`}>
            {activeOperator || "No user signed in"}
          </div>
        </Field>
        <Field label={mode === "plan" ? "Planned Start" : "Processing Started"}>
          <TextInput
            type="datetime-local"
            value={startedAt}
            onChange={(event) => setStartedAt(event.target.value)}
          />
        </Field>
      </div>
      <p className="mb-3 text-xs text-ink-faint">
        {mode === "plan"
          ? "Future start time — this run is scheduled and won't enter the processor until you confirm it."
          : "Set a future start time to schedule the run for later instead of starting it now."}
      </p>

      <Field label="Batch Notes (optional)">
        <TextArea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </Field>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {(!activeOperator || incompatible) && (
        <p className="mb-2 text-right text-xs text-amber-700">
          {incompatible
            ? "Separate Short and Long samples into different batches."
            : "Sign in from the header before starting the batch."}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          onClick={() => start()}
          disabled={busy || incompatible || !activeOperator}
        >
          {mode === "plan" ? "Plan Batch" : "Start Batch"}
        </Button>
      </div>
    </Modal>
  );
}
