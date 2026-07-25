import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BatchStartDialog } from "./BatchStartDialog";
import type { Sample } from "../lib/types";

function sample(id: number): Sample {
  return { id, sample_code: `EE-000${id}`, sample_description: "d", processing_type: "Short" } as Sample;
}

describe("BatchStartDialog — plan flow (issues #4, #24, #42)", () => {
  it("infers a planned run from a future start time (no separate tab) and routes to onPlan", async () => {
    const onPlan = vi.fn().mockResolvedValue(undefined);
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(
      <BatchStartDialog
        samples={[sample(1)]}
        activeOperator="Tech"
        onStart={onStart}
        onPlan={onPlan}
        onClose={() => {}}
      />,
    );
    const user = userEvent.setup();

    // A future start time is what makes it a planned run — there is no mode tab.
    const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
    fireEvent.change(screen.getByLabelText(/Planned Start|Processing Started/i), {
      target: { value: future },
    });

    await user.click(screen.getByRole("button", { name: /Plan Batch/i }));
    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
    expect(onPlan.mock.calls[0][0]).toHaveProperty("plannedStartAt");
  });

  it("starts immediately when the start time is now/past", async () => {
    const onPlan = vi.fn().mockResolvedValue(undefined);
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(
      <BatchStartDialog
        samples={[sample(1)]}
        activeOperator="Tech"
        onStart={onStart}
        onPlan={onPlan}
        onClose={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Start Batch/i }));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onPlan).not.toHaveBeenCalled();
  });
});
