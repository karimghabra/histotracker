import { describe, it, expect } from "vitest";
import { SAMPLE_NOTES, sampleNoteLabel } from "./sampleNotes";

// The intake form, the Logs and the sample drawer all take their labels from
// this list, so this is the one place the wording is pinned. Each surface has
// its own test that it shows these words.
describe("sample note labels", () => {
  it("uses the intake wording for the four note fields", () => {
    expect(SAMPLE_NOTES.map((n) => [n.field, n.label])).toEqual([
      ["embedding_notes", "Embedding Notes"],
      ["cut_notes", "Sectioning / Cut Notes"],
      ["slide_notes", "Slide Notes"],
      ["overall_notes", "General Notes"],
    ]);
    expect(sampleNoteLabel("cut_notes")).toBe("Sectioning / Cut Notes");
  });
});
