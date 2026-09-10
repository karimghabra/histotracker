import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Sample, Slide } from "../lib/types";

// LogsView reads its data through react-query hooks and its mutations through
// useActions; both are replaced so the real component renders against fixtures.
const data = vi.hoisted(() => ({
  samples: [] as Sample[],
  slides: [] as Slide[],
  catalog: [] as Array<{ id: number; assay_type: string; name: string; is_active: number }>,
}));

vi.mock("../hooks/useData", () => ({
  useAllSamples: () => ({ data: data.samples }),
  useAllSlides: () => ({ data: data.slides }),
  useAssayCatalog: () => ({ data: data.catalog }),
  useSlideRemovals: () => ({ data: [] }),
  useSampleRemovals: () => ({ data: [] }),
}));
vi.mock("../hooks/useActions", () => ({
  useActions: () => new Proxy({}, { get: () => () => undefined }),
}));

const { LogsView } = await import("./LogsView");

const assigned = (...agents: Array<[string, string]>) =>
  JSON.stringify(agents.map(([assay_type, assay_name]) => ({ assay_type, assay_name })));

let nextId = 1;
const sample = (over: Partial<Sample>): Sample =>
  ({
    id: nextId++,
    sample_code: "EE-0001",
    sample_description: "block",
    project_code: "EE",
    processing_type: "Short",
    current_stage: "embedded",
    date_added: "2026-07-24 10:00",
    overall_notes: "",
    preselected_stains: "",
    ...over,
  }) as unknown as Sample;

const slide = (parent_code: string, assay_type: string, assay_name: string): Slide =>
  ({
    id: nextId++,
    parent_code,
    slide_code: `${parent_code}-A`,
    assay_type,
    assay_name,
    purpose: "assay",
    current_stage: "staining",
    section_stage: "staining",
    stage_cut_at: "2026-07-25 09:00",
    notes: "",
  }) as unknown as Slide;

/** The "Stains / IHC" cell of the row for a block, by its displayed code. */
function stainsCell(code: string): HTMLElement {
  const row = screen.getByText(code).closest("tr");
  if (!row) throw new Error(`no row for ${code}`);
  return within(row).getAllByRole("cell")[6];
}

beforeEach(() => {
  localStorage.clear();
  nextId = 1;
  data.samples = [];
  data.slides = [];
  data.catalog = [
    { id: 1, assay_type: "stain", name: "H&E", is_active: 1 },
    { id: 2, assay_type: "stain", name: "Alcian Blue", is_active: 1 },
    { id: 3, assay_type: "ihc", name: "CD68", is_active: 1 },
  ];
});

describe("LogsView — the Stains / IHC cell", () => {
  // The compact wording means "this block has no glass at all". Cutting a block
  // and then re-requesting the same agents leaves every entry outstanding
  // again, which is NOT the same condition — the slides exist.
  it("does not say a block is all assigned when it already has slides", () => {
    data.samples = [
      sample({ sample_code: "EE-0001", preselected_stains: assigned(["stain", "H&E"], ["stain", "Alcian Blue"]) }),
    ];
    data.slides = [
      slide("EE-0001", "stain", "H&E"),
      slide("EE-0001", "stain", "Alcian Blue"),
    ];
    render(<LogsView />);
    const cell = stainsCell("EE-1");
    expect(cell.textContent).toContain("H&E");
    expect(cell.textContent).toContain("Alcian Blue");
    expect(cell.textContent).not.toMatch(/all assigned/);
  });

  it("says all assigned for a block that has not been cut at all (#136)", () => {
    data.samples = [
      sample({
        sample_code: "EE-0002",
        current_stage: "fixation",
        preselected_stains: assigned(["stain", "Safranin O"], ["stain", "Alcian Blue"]),
      }),
    ];
    render(<LogsView />);
    expect(stainsCell("EE-2").textContent).toMatch(/all assigned/);
  });
});

describe("LogsView — the Assay Type filter", () => {
  // #136 for the type filter: an IHC that is assigned but not yet cut is named
  // in the Stains cell and found by the stain filter, so "IHC" must find it too.
  it("finds a block whose only IHC is assigned but not yet cut", async () => {
    data.samples = [
      sample({
        sample_code: "EE-0003",
        current_stage: "fixation",
        preselected_stains: assigned(["ihc", "CD68"]),
      }),
      sample({
        sample_code: "EE-0004",
        current_stage: "fixation",
        preselected_stains: assigned(["stain", "Safranin O"]),
      }),
    ];
    render(<LogsView />);
    await userEvent.selectOptions(screen.getByDisplayValue("Any type"), "ihc");
    expect(screen.queryByText("EE-3")).not.toBeNull();
    expect(screen.queryByText("EE-4")).toBeNull();
  });
});
