import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Board } from "./Board";
import type { ProcessingBatch } from "../lib/types";

const noop = () => {};

function plannedBatch(): ProcessingBatch {
  return {
    id: 7,
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
    member_count: 1,
    member_ids: [1],
    member_codes: ["EE-0001"],
    checklist_completed: 0,
    checklist_total: 0,
  } as ProcessingBatch;
}

describe("Board — a planned run appears in the Processor window (issues #4, #24)", () => {
  it("renders the planned batch tile with its PLANNED FOR tag", () => {
    render(
      <Board
        samples={[]}
        sections={[]}
        stacks={[]}
        batches={[plannedBatch()]}
        extraSlides={[]}
        selectedSampleId={null}
        selectedSectionId={null}
        selectedStackId={null}
        onSelectSample={noop}
        onSampleSelectionChange={noop}
        onSelectSection={noop}
        onSectionSelectionChange={noop}
        onSelectStack={noop}
        onStackSelectionChange={noop}
        onCloseDrawers={noop}
        onSelectExtraSlideSample={noop}
        onMoveSamples={noop}
        onMoveSections={noop}
        onMoveStacks={noop}
        onRequestProcessingBatch={noop}
        onMoveProcessingBatch={noop}
        onSelectProcessingBatch={noop}
        onConfirmProcessingBatchStart={noop}
        onToggleSamplePriority={noop}
      />,
    );
    expect(screen.getByText(/PLANNED FOR 08:00/)).toBeInTheDocument();
  });
});
