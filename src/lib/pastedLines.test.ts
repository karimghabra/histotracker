import { describe, expect, it } from "vitest";
import { normalizePastedLines } from "./utils";

// #86 — the per-sample rows and the "N line(s) pasted for M sample(s)" warning
// must agree on what a line is. They did not: the splitter mapped positionally
// while the warning counted only non-empty lines, so a blank line shifted every
// description onto the wrong sample AND kept the warning silent.
describe("normalizePastedLines", () => {
  it("keeps a leading blank in place instead of closing the gap", () => {
    // Sample 1 genuinely has no description; 'Liver' belongs to sample 2.
    expect(normalizePastedLines("\nLiver\nKidney")).toEqual(["", "Liver", "Kidney"]);
  });

  it("keeps an interior blank in place", () => {
    expect(normalizePastedLines("Liver\n\nKidney")).toEqual(["Liver", "", "Kidney"]);
  });

  it("drops the trailing newline a spreadsheet column copy carries", () => {
    // Must be 3, not 4 — otherwise the commonest real paste warns spuriously.
    expect(normalizePastedLines("Liver\nKidney\nSpleen\n")).toEqual([
      "Liver",
      "Kidney",
      "Spleen",
    ]);
  });

  it("drops several trailing blanks but no interior ones", () => {
    expect(normalizePastedLines("A\n\nB\n\n\n")).toEqual(["A", "", "B"]);
  });

  it("trims each line and treats an all-blank paste as empty", () => {
    expect(normalizePastedLines("  Liver  \n Kidney ")).toEqual(["Liver", "Kidney"]);
    expect(normalizePastedLines("\n\n  \n")).toEqual([]);
    expect(normalizePastedLines("")).toEqual([]);
  });

  it("counts a blank line, so a 3-line paste for 3 samples that MISALIGNS warns", () => {
    // The exact reported case: a leading blank with 3 non-empty lines for 3
    // samples. Counting non-empty lines gave 3 === 3 and stayed silent while
    // 'Spleen' was silently discarded. The normalized length is 4, so it warns.
    expect(normalizePastedLines("\nLiver\nKidney\nSpleen")).toHaveLength(4);
  });
});
