import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SectionCard } from "./SectionCard";
import type { SectionRequest } from "../lib/types";

function section(id: number): SectionRequest {
  return {
    id,
    sample_id: 1,
    parent_code: "EE-0001",
    current_stage: "needs_sectioning",
    duplicates: 1,
    slide_count: 2,
  } as SectionRequest;
}

describe("SectionCard — real checkbox multi-select (issue #37)", () => {
  it("ticking the checkbox toggles the whole group without a modifier key", async () => {
    const onToggle = vi.fn();
    const onSelectGroup = vi.fn();
    const group = [section(1), section(2)];
    render(
      <SectionCard
        section={group[0]}
        groupedSections={group}
        onToggle={onToggle}
        onSelectGroup={onSelectGroup}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /Select EE-0001/i }));
    // A plain checkbox tick accumulates selection (onToggle), and must NOT fall
    // through to the card's replace-select (onSelectGroup).
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle.mock.calls[0][0]).toEqual([1, 2]);
    expect(onSelectGroup).not.toHaveBeenCalled();
  });
});
