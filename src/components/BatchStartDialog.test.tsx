import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BatchStartDialog } from "./BatchStartDialog";
import type { Sample } from "../lib/types";

function sample(id: number): Sample {
  return { id, sample_code: `EE-000${id}`, sample_description: "d", processing_type: "Short" } as Sample;
}

describe("BatchStartDialog — plan flow (issues #4, #24)", () => {
  it("has a discoverable 'Plan for later' option that routes to onPlan", async () => {
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
    await user.click(screen.getByRole("button", { name: /Plan for later/i }));
    await user.click(screen.getByRole("button", { name: /Plan Batch/i }));
    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
    expect(onPlan.mock.calls[0][0]).toHaveProperty("plannedStartAt");
  });
});
