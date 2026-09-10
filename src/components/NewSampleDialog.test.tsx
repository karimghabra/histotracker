import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "../lib/types";

/**
 * Embedding notes for a batch (#137 follow-up): "one note for all" and "a note
 * for each" are two modes, and switching between them must never lose what was
 * typed. These pin the dialog's half — what it shows and exactly what it hands
 * to createSamples. That the stored notes reach the drawer, the Logs and both
 * exports is driven end to end in tests/e2e/bulk-embedding-notes.spec.ts.
 */

const createSamples = vi.fn().mockResolvedValue([]);
vi.mock("../hooks/useActions", () => ({ useActions: () => ({ createSamples }) }));
vi.mock("../hooks/useData", () => ({
  useAssayCatalog: () => ({ data: [] }),
  useAppSettings: () => ({ data: undefined }),
}));
vi.mock("../lib/db", () => ({ nextSampleCode: () => Promise.resolve("EE-0001") }));

const { NewSampleDialog } = await import("./NewSampleDialog");

const project = { id: 1, code: "EE", name: "Enthesis Engineering" } as Project;

// A controlled number input clamps "" to 1, so typing into it appends to that
// 1; set the value the way a paste would.
const setQuantity = (n: number) =>
  fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: String(n) } });

async function openBatch(quantity: number) {
  const user = userEvent.setup();
  render(<NewSampleDialog project={project} onClose={() => {}} />);
  // The preview code resolves asynchronously; the rows are labelled by it.
  await screen.findByDisplayValue("EE-1");
  setQuantity(quantity);
  await user.type(screen.getByPlaceholderText(/added to every sample below/), "TE8 batch");
  return user;
}

const mode = (name: RegExp) => screen.getByRole("radio", { name });
const noteFor = (code: string) => screen.getByLabelText(`Embedding note for ${code}`);

beforeEach(() => createSamples.mockClear());

describe("NewSampleDialog — embedding notes for a batch", () => {
  it("offers no mode switch for a single sample", async () => {
    render(<NewSampleDialog project={project} onClose={() => {}} />);
    await screen.findByDisplayValue("EE-1");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByLabelText("Embedding Notes")).toBeInstanceOf(HTMLTextAreaElement);
  });

  it("defaults to one note for all, and saves that note on every sample", async () => {
    const user = await openBatch(3);
    expect(mode(/One note for all 3/)).toHaveAttribute("aria-checked", "true");
    expect(mode(/A note for each/)).toHaveAttribute("aria-checked", "false");

    await user.type(screen.getByLabelText("Embedding Notes"), "cut face down");
    await user.click(screen.getByRole("button", { name: "Create 3 Samples" }));

    expect(createSamples).toHaveBeenCalledTimes(1);
    const [input, , quantity, each] = createSamples.mock.calls[0];
    expect(quantity).toBe(3);
    expect(input.embedding_notes).toBe("cut face down");
    // No per-sample list goes out, so createSamples applies the one note to all.
    expect(each.embeddingNotes).toBeUndefined();
  });

  it("saves a separate note per sample, blanks included, in code order", async () => {
    const user = await openBatch(3);
    await user.click(mode(/A note for each/));
    expect(mode(/A note for each/)).toHaveAttribute("aria-checked", "true");
    // The shared box is gone; one row per sample code replaces it.
    expect(screen.queryByLabelText("Embedding Notes")).toBeNull();

    await user.type(noteFor("EE-1"), "cut face down");
    await user.type(noteFor("EE-3"), "bisect through the enthesis");
    await user.click(screen.getByRole("button", { name: "Create 3 Samples" }));

    const [input, , , each] = createSamples.mock.calls[0];
    expect(each.embeddingNotes).toEqual(["cut face down", "", "bisect through the enthesis"]);
    // The shared value is not sent alongside, so it cannot leak onto EE-2.
    expect(input.embedding_notes).toBe("");
  });

  it("starts the rows from a shared note already typed, so one edit splits it", async () => {
    const user = await openBatch(3);
    await user.type(screen.getByLabelText("Embedding Notes"), "cut face down");
    await user.click(mode(/A note for each/));

    for (const code of ["EE-1", "EE-2", "EE-3"]) {
      expect(noteFor(code)).toHaveValue("cut face down");
    }
    // Every row still carries the shared note, so nothing is set aside.
    expect(screen.queryByText(/kept aside/)).toBeNull();
  });

  it("switching modes never discards typed notes, and says what will not be saved", async () => {
    const user = await openBatch(3);
    await user.type(screen.getByLabelText("Embedding Notes"), "cut face down");
    await user.click(mode(/A note for each/));
    await user.clear(noteFor("EE-2"));
    await user.type(noteFor("EE-2"), "proximal end left");

    // Back to one note: the shared note is exactly as typed, and the row that
    // differs is named rather than silently dropped.
    await user.click(mode(/One note for all/));
    expect(screen.getByLabelText("Embedding Notes")).toHaveValue("cut face down");
    expect(
      screen.getByText('1 separate note is kept aside — not saved unless you switch to "A note for each".'),
    ).toBeInTheDocument();

    // And forward again: the edited row is still there.
    await user.click(mode(/A note for each/));
    expect(noteFor("EE-1")).toHaveValue("cut face down");
    expect(noteFor("EE-2")).toHaveValue("proximal end left");
    expect(noteFor("EE-3")).toHaveValue("cut face down");

    // Rows that no longer carry the shared note anywhere: now IT is set aside.
    for (const code of ["EE-1", "EE-3"]) {
      await user.clear(noteFor(code));
      await user.type(noteFor(code), "other");
    }
    expect(
      screen.getByText(
        'Your note for all samples is kept aside — not saved unless you switch back to "One note for all 3".',
      ),
    ).toBeInTheDocument();

    // Whatever mode is showing is what gets saved.
    await user.click(mode(/One note for all/));
    await user.click(screen.getByRole("button", { name: "Create 3 Samples" }));
    const [input, , , each] = createSamples.mock.calls[0];
    expect(input.embedding_notes).toBe("cut face down");
    expect(each.embeddingNotes).toBeUndefined();
  });

  it("dropping to one sample keeps the batch rows, and saves the box that is shown", async () => {
    const user = await openBatch(2);
    await user.click(mode(/A note for each/));
    await user.type(noteFor("EE-1"), "cut face down");

    setQuantity(1);
    // One sample, one box — and the row typed for the batch is named, not lost.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByLabelText("Embedding Notes")).toHaveValue("");
    expect(
      screen.getByText("1 separate note is kept aside for a batch — not saved for a single sample."),
    ).toBeInTheDocument();
    setQuantity(2);
    expect(noteFor("EE-1")).toHaveValue("cut face down");

    // Saved at one sample, it is the visible box that counts, as for descriptions.
    setQuantity(1);
    await user.type(screen.getByLabelText("Embedding Notes"), "orient anterior up");
    await user.click(screen.getByRole("button", { name: "Create Sample" }));
    const [input, , quantity, each] = createSamples.mock.calls[0];
    expect(quantity).toBe(1);
    expect(input.embedding_notes).toBe("orient anterior up");
    expect(each).toBeUndefined();
  });
});
