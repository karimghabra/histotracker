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
  // Every action the view calls, in order, as [name, ...args].
  calls: [] as Array<[string, ...unknown[]]>,
}));

vi.mock("../hooks/useData", () => ({
  useAllSamples: () => ({ data: data.samples }),
  useAllSlides: () => ({ data: data.slides }),
  useAssayCatalog: () => ({ data: data.catalog }),
  useSlideRemovals: () => ({ data: [] }),
  useSampleRemovals: () => ({ data: [] }),
}));
vi.mock("../hooks/useActions", () => ({
  useActions: () =>
    new Proxy(
      {},
      {
        get:
          (_t, name: string) =>
          (...args: unknown[]) => {
            data.calls.push([name, ...args]);
          },
      },
    ),
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
    embedding_notes: "",
    cut_notes: "",
    slide_notes: "",
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
  data.calls = [];
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

describe("LogsView — a block removed before it was cut", () => {
  // A removed block cannot be cut, so nothing it was assigned is still owed.
  it("names no assigned stain in its row or its expanded row", async () => {
    const safO = assigned(["stain", "Safranin O"]);
    data.samples = [
      sample({ sample_code: "EE-0005", current_stage: "fixation", preselected_stains: safO }),
      sample({ sample_code: "EE-0006", current_stage: "removed", preselected_stains: safO }),
    ];
    render(<LogsView />);
    await userEvent.click(screen.getByLabelText("Show removed"));

    expect(stainsCell("EE-5").textContent).toMatch(/Safranin O.*assigned/);
    const removedCell = stainsCell("EE-6");
    expect(removedCell.textContent).not.toMatch(/Safranin O|assigned/);

    await userEvent.click(screen.getByText("EE-5"));
    expect(screen.getAllByText(/Assigned — not cut yet/)).toHaveLength(1);
    await userEvent.click(screen.getByText("EE-5"));
    await userEvent.click(screen.getByText("EE-6"));
    expect(screen.queryByText(/Assigned — not cut yet/)).toBeNull();
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

/**
 * "add a correction path. i should be able to edit all notes.. especially in
 * the logs" — the Logs row is where a wrong note is noticed, so it is where all
 * four of a sample's notes have to be correctable. The round trip through the
 * real database is proved end to end by tests/e2e/notes-correction.spec.ts and
 * at the data layer by the workflow harness; what is proved here is the wiring:
 * each box shows its OWN note, and saving it writes that one field.
 */
describe("LogsView — correcting a sample's notes", () => {
  const FOUR: Array<[string, string, string]> = [
    ["Embedding notes", "embedding_notes", "cut face down"],
    ["Cut notes", "cut_notes", "10 um"],
    ["Slide notes", "slide_notes", "two sections per slide"],
    ["Sample notes", "overall_notes", "decal ran long"],
  ];

  const withNotes = () =>
    sample({
      sample_code: "EE-0001",
      embedding_notes: "cut face down",
      cut_notes: "10 um",
      slide_notes: "two sections per slide",
      overall_notes: "decal ran long",
    });

  it("offers an editor for each of the four notes, showing what was written", async () => {
    data.samples = [withNotes()];
    render(<LogsView />);
    await userEvent.click(screen.getByText("EE-1"));

    for (const [label, , written] of FOUR) {
      expect(
        screen.getByLabelText(`${label} for EE-1`),
        `${label} is editable in the expanded row`,
      ).toHaveValue(written);
    }
  });

  it("writes the corrected text to that note alone", async () => {
    data.samples = [withNotes()];
    render(<LogsView />);
    await userEvent.click(screen.getByText("EE-1"));

    const box = screen.getByLabelText("Cut notes for EE-1");
    await userEvent.clear(box);
    await userEvent.type(box, "8 um");
    await userEvent.tab(); // save on blur, the same as the description

    expect(data.calls).toEqual([["editSampleNote", 1, "cut_notes", "8 um"]]);
  });

  // A blank note is the other half of getting one wrong: the box has to be
  // there to fill in, unlike the read-only display it replaced, which vanished.
  it("offers the editor for a note that was never written", async () => {
    data.samples = [sample({ sample_code: "EE-0002" })];
    render(<LogsView />);
    await userEvent.click(screen.getByText("EE-2"));

    for (const [label] of FOUR) {
      expect(screen.getByLabelText(`${label} for EE-2`)).toHaveValue("");
    }
  });

  // Reading a note is focus-and-blur. That must not write, or the undo stack
  // fills with entries that changed nothing.
  it("does not write when the text was not changed", async () => {
    data.samples = [withNotes()];
    render(<LogsView />);
    await userEvent.click(screen.getByText("EE-1"));

    await userEvent.click(screen.getByLabelText("Sample notes for EE-1"));
    await userEvent.tab();
    expect(data.calls).toEqual([]);
  });

  // The collapsed row's 📝 marker says the block carries notes. This row is now
  // where all four are written, so a marker drawn from the general note alone
  // reads "no notes" about a note this very view just saved.
  it("marks a block whose only note is one of the other three", async () => {
    data.samples = [
      sample({ sample_code: "EE-0001", cut_notes: "wedge the block, it is tilting" }),
      sample({ sample_code: "EE-0002" }),
    ];
    render(<LogsView />);

    const marked = screen.getByText("EE-1").closest("tr")!;
    const unmarked = screen.getByText("EE-2").closest("tr")!;
    expect(within(marked).getByTitle("Has notes")).toBeTruthy();
    expect(within(unmarked).queryByTitle("Has notes")).toBeNull();
  });

  // The refetch that follows a save is what puts the corrected note on screen;
  // the editor must adopt it rather than keep showing the old text.
  it("shows the corrected note after the data is read back", async () => {
    data.samples = [withNotes()];
    const { rerender } = render(<LogsView />);
    await userEvent.click(screen.getByText("EE-1"));
    expect(screen.getByLabelText("Embedding notes for EE-1")).toHaveValue("cut face down");

    data.samples = [{ ...data.samples[0], embedding_notes: "cut face UP" }];
    rerender(<LogsView />);
    expect(screen.getByLabelText("Embedding notes for EE-1")).toHaveValue("cut face UP");
  });
});
