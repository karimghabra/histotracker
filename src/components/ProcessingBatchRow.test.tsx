import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { ProcessingBatchRow } from "./ProcessingBatchRow";
import type { ProcessingBatch } from "../lib/types";

function makeBatch(overrides: Partial<ProcessingBatch>): ProcessingBatch {
  return {
    id: 1,
    processing_type: "Short",
    operator_name: "Tech",
    status: "planned",
    started_at: "2026-08-01 08:00",
    planned_start_at: "2026-08-01 08:00",
    ready_at: "2026-08-02 02:00",
    notes: "",
    collected_at: null,
    completed_at: null,
    created_at: "2026-07-30 10:00",
    current_stage: "processing_started",
    member_count: 2,
    member_ids: [10, 11],
    member_codes: ["EE-0001", "EE-0002"],
    checklist_completed: 0,
    checklist_total: 0,
    ...overrides,
  } as ProcessingBatch;
}

function renderRow(batch: ProcessingBatch) {
  return render(
    <DndContext>
      <ProcessingBatchRow batch={batch} onConfirmStart={() => {}} />
    </DndContext>,
  );
}

describe("ProcessingBatchRow — planned run (issues #4, #24)", () => {
  it("shows a PLANNED FOR tag with the scheduled time, not a running timer", () => {
    renderRow(makeBatch({ status: "planned", planned_start_at: "2026-08-01 08:00" }));
    // The tile must advertise the scheduled start.
    expect(screen.getByText(/PLANNED FOR 08:00/)).toBeInTheDocument();
    // And must offer the confirm-start step.
    expect(screen.getByText(/Confirm start/)).toBeInTheDocument();
  });

  it("does not show the PLANNED tag once the run is actually processing", () => {
    renderRow(makeBatch({ status: "processing", current_stage: "processing_started" }));
    expect(screen.queryByText(/PLANNED FOR/)).not.toBeInTheDocument();
  });
});
