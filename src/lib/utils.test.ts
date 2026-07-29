import { describe, expect, it } from "vitest";
import { compareSlideCodes, duplicateLabel } from "./utils";

describe("compareSlideCodes (#75)", () => {
  it("orders a sample's slides A, B, C…", () => {
    const codes = ["EE-0001-C", "EE-0001-A", "EE-0001-B"];
    expect([...codes].sort(compareSlideCodes)).toEqual(["EE-0001-A", "EE-0001-B", "EE-0001-C"]);
  });

  it("keeps Z before AA instead of sorting AA next to A", () => {
    const codes = ["EE-0001-AA", "EE-0001-B", "EE-0001-Z", "EE-0001-A"];
    expect([...codes].sort(compareSlideCodes)).toEqual([
      "EE-0001-A",
      "EE-0001-B",
      "EE-0001-Z",
      "EE-0001-AA",
    ]);
  });

  it("groups by parent code first, numerically", () => {
    const codes = ["EE-0010-A", "EE-0002-B", "EE-0002-A"];
    expect([...codes].sort(compareSlideCodes)).toEqual(["EE-0002-A", "EE-0002-B", "EE-0010-A"]);
  });

  it("agrees with the generated label sequence for the first 30 slides", () => {
    const generated = Array.from({ length: 30 }, (_, i) =>
      `EE-0001-${duplicateLabel(i + 1).toUpperCase()}`,
    );
    // Shuffling then sorting must reproduce creation order exactly.
    const shuffled = [...generated].reverse();
    expect([...shuffled].sort(compareSlideCodes)).toEqual(generated);
  });

  it("is stable for codes with no suffix", () => {
    expect(compareSlideCodes("EE-0001", "EE-0001")).toBe(0);
  });
});
