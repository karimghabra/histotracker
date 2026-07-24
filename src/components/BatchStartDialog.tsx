import { useMemo, useState } from "react";
import { ProcessorBusyError } from "../lib/db";
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
    allowConcurrent?: boolean;
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
  // "now" starts the run immediately; "plan" schedules it for a future start
  // that the technician confirms later (issues #4, #24).
  const [mode, setMode] = useState<"now" | "plan">("now");
  const [startedAt, setStartedAt] = useState(nowTimestamp().replace(" ", "T"));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When the processor is already busy we don't block — we warn and let the
  // technician start a second run simultaneously if they choose (issue #23).
  const [busyConflict, setBusyConflict] = useState<string | null>(null);
  const memberSummary = useMemo(() => samples.map((sample) => sample.sample_code).join(", "), [samples]);

  async function start(allowConcurrent = false) {
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
        await onStart({
          sampleIds: samples.map((sample) => sample.id),
          processingType,
          operatorName: activeOperator,
          startedAt: timestamp,
          // The technician loads the processor away from the app, so no
          // load-time checklist is recorded here (see issue #3).
          checklistLabels: [],
          notes: notes.trim(),
          allowConcurrent,
        });
      }
      onClose();
    } catch (reason) {
      if (reason instanceof ProcessorBusyError) {
        setBusyConflict(reason.message);
      } else {
        setError(String(reason));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${mode === "plan" ? "Plan" : "Start"} ${processingType} Processing Batch`} onClose={onClose} width="max-w-xl">
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg border border-line bg-panel p-0.5 text-xs">
        <button
          type="button"
          onClick={() => { setMode("now"); setBusyConflict(null); }}
          className={`rounded-md px-2 py-1.5 font-medium ${mode === "now" ? "bg-brand text-white" : "text-ink-soft hover:bg-surface"}`}
        >
          Start now
        </button>
        <button
          type="button"
          onClick={() => { setMode("plan"); setBusyConflict(null); }}
          className={`rounded-md px-2 py-1.5 font-medium ${mode === "plan" ? "bg-brand text-white" : "text-ink-soft hover:bg-surface"}`}
        >
          Plan for later
        </button>
      </div>
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
            onChange={(event) => {
              setStartedAt(event.target.value);
              setBusyConflict(null);
            }}
          />
        </Field>
      </div>

      <Field label="Batch Notes (optional)">
        <TextArea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </Field>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {busyConflict && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {busyConflict} You can start this run simultaneously anyway.
        </div>
      )}
      {(!activeOperator || incompatible) && (
        <p className="mb-2 text-right text-xs text-amber-700">
          {incompatible
            ? "Separate Short and Long samples into different batches."
            : "Sign in from the header before starting the batch."}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {busyConflict ? (
          <Button
            variant="primary"
            onClick={() => start(true)}
            disabled={busy || incompatible || !activeOperator}
          >
            Start anyway
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => start(false)}
            disabled={busy || incompatible || !activeOperator}
          >
            {mode === "plan" ? "Plan Batch" : "Start Batch"}
          </Button>
        )}
      </div>
    </Modal>
  );
}
