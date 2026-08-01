import { describe, expect, it } from "vitest";
import {
  compareSampleCodes,
  compareSlideCodes,
  duplicateLabel,
  formatSampleCode,
  parseSampleCode,
  sampleCodeVariants,
} from "./utils";

describe("sample code formatting (#87)", () => {
  it("mints codes without leading zeros", () => {
    expect(formatSampleCode("ee", 1)).toBe("EE-1");
    expect(formatSampleCode("EE", 22)).toBe("EE-22");
    expect(formatSampleCode(" ee ", 100)).toBe("EE-100");
  });

  it("parses both the padded and unpadded spellings", () => {
    expect(parseSampleCode("EE-0001")).toEqual({ prefix: "EE", number: 1 });
    expect(parseSampleCode("EE-1")).toEqual({ prefix: "EE", number: 1 });
    expect(parseSampleCode("not a code")).toBeNull();
  });

  it("treats both spellings as the same identity", () => {
    const padded = sampleCodeVariants("EE-0001");
    const bare = sampleCodeVariants("EE-1");
    expect(padded).toContain("EE-1");
    expect(padded).toContain("EE-0001");
    expect(new Set(bare)).toEqual(new Set(padded));
  });

  it("does not conflate different numbers", () => {
    expect(sampleCodeVariants("EE-2")).not.toContain("EE-1");
  });

  it("sorts sample codes numerically across both spellings", () => {
    const codes = ["EE-10", "EE-2", "EE-0001", "EE-9"];
    expect([...codes].sort(compareSampleCodes)).toEqual(["EE-0001", "EE-2", "EE-9", "EE-10"]);
  });

  it("is NOT interchangeable with compareSlideCodes for bare sample codes", () => {
    // compareSlideCodes compares the tail by LENGTH first, which is right for
    // slide letters (Z before AA) but wrong for numbers — guard the distinction.
    const codes = ["EE-10", "EE-2", "EE-0001"];
    expect([...codes].sort(compareSlideCodes)).not.toEqual(
      [...codes].sort(compareSampleCodes),
    );
  });

  it("still orders slide codes correctly with unpadded parents", () => {
    const codes = ["EE-2-AA", "EE-10-A", "EE-2-B", "EE-2-Z", "EE-2-A"];
    expect([...codes].sort(compareSlideCodes)).toEqual([
      "EE-2-A",
      "EE-2-B",
      "EE-2-Z",
      "EE-2-AA",
      "EE-10-A",
    ]);
  });
});

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
