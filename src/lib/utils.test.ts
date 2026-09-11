import { describe, expect, it } from "vitest";
import {
  CATALOG_SEP,
  formatAgent,
  parseAgent,
  compareSampleCodes,
  composeDescription,
  compareSlideCodes,
  displayCode,
  duplicateLabel,
  formatSampleCode,
  matchesSearch,
  parseSampleCode,
  sampleCodeVariants,
  slideCutAt,
} from "./utils";

describe("sample code formatting (#87)", () => {
  it("STORES codes zero-padded to four digits", () => {
    expect(formatSampleCode("ee", 1)).toBe("EE-0001");
    expect(formatSampleCode("EE", 22)).toBe("EE-0022");
    expect(formatSampleCode(" ee ", 100)).toBe("EE-0100");
  });

  it("DISPLAYS codes without their leading zeros", () => {
    expect(displayCode("EE-0001")).toBe("EE-1");
    expect(displayCode("EE-0022")).toBe("EE-22");
    expect(displayCode("EE-0100")).toBe("EE-100");
    expect(displayCode("EE-1000")).toBe("EE-1000");
  });

  it("strips the parent's zeros in a slide code but leaves the letter alone", () => {
    expect(displayCode("EE-0001-A")).toBe("EE-1-A");
    expect(displayCode("EE-0022-AA")).toBe("EE-22-AA");
  });

  it("is retroactive: a legacy stored code displays short with no data change", () => {
    // This is the whole point — old samples gain the short form for free.
    const storedLastYear = "EE-0007";
    expect(displayCode(storedLastYear)).toBe("EE-7");
    expect(storedLastYear).toBe("EE-0007"); // storage untouched
  });

  it("leaves anything that is not a code alone", () => {
    expect(displayCode("")).toBe("");
    expect(displayCode("Batch 1")).toBe("Batch 1");
    expect(displayCode("no-code-here")).toBe("no-code-here");
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

describe("composeDescription (#86)", () => {
  it("joins the shared description and the per-sample one", () => {
    // The reported defect: filling in both threw the shared half away, so a
    // shared description "did nothing".
    expect(composeDescription("2 week PLA", "left femur")).toBe("2 week PLA | left femur");
  });

  it("uses whichever half is present on its own", () => {
    expect(composeDescription("2 week PLA", "")).toBe("2 week PLA");
    expect(composeDescription("", "left femur")).toBe("left femur");
  });

  it("trims, and reports nothing when both halves are blank (#88's rule)", () => {
    expect(composeDescription("  2 week PLA  ", "  left femur ")).toBe("2 week PLA | left femur");
    expect(composeDescription("   ", "")).toBe("");
  });
});

describe("slideCutAt (#95)", () => {
  const base = { stage_cut_at: null, created_at: "2026-07-20 09:00" };

  it("reports no cut while the group is still queued for sectioning", () => {
    expect(slideCutAt({ ...base, section_stage: "needs_sectioning" })).toBe("");
  });

  it("ignores a creation-time stamp written by an older build", () => {
    // Builds up to 0.7.4 stamped stage_cut_at at INSERT, so rows already in the
    // live database claim a cut that has not happened.
    expect(
      slideCutAt({
        stage_cut_at: "2026-07-20 09:00",
        created_at: "2026-07-20 09:00",
        section_stage: "needs_sectioning",
      }),
    ).toBe("");
  });

  it("reports the stamp once the group has left the queue", () => {
    expect(
      slideCutAt({ stage_cut_at: "2026-07-24 11:00", created_at: "x", section_stage: "stain_requested" }),
    ).toBe("2026-07-24 11:00");
  });

  it("still falls back to created_at for slides that never had a stamp", () => {
    expect(slideCutAt({ ...base, section_stage: "stained" })).toBe("2026-07-20 09:00");
  });
});

describe("matchesSearch (#120)", () => {
  const block = ["OG-0011", "left femur", "OG", "Safranin O"];

  it("finds a padded code from the short spelling, and the reverse", () => {
    // The reported failure: typing OG-11 returned nothing for OG-0011.
    expect(matchesSearch("OG-11", block)).toBe(true);
    expect(matchesSearch("OG-0011", ["OG-11", "left femur"])).toBe(true);
  });

  it("requires every term, in any order", () => {
    expect(matchesSearch("safranin femur", block)).toBe(true);
    expect(matchesSearch("femur safranin", block)).toBe(true);
    expect(matchesSearch("femur cd31", block)).toBe(false);
  });

  it("matches a term against any one field, not the joined string", () => {
    // "OG-11 femur" only appears adjacent if you happen to join in that order;
    // a substring test over the joined haystack got this wrong.
    expect(matchesSearch("OG-11 femur", block)).toBe(true);
  });

  it("an empty query matches everything, and blanks are ignored", () => {
    expect(matchesSearch("", block)).toBe(true);
    expect(matchesSearch("   ", block)).toBe(true);
    expect(matchesSearch("femur", [null, undefined, "", "left femur"])).toBe(true);
  });
});

describe("agent pairs", () => {
  it("round-trips both encodings", () => {
    expect(formatAgent("stain", "PAS")).toBe("stain:PAS");
    expect(formatAgent("ihc", "CD31", CATALOG_SEP)).toBe("ihc::CD31");
    expect(parseAgent("stain:PAS")).toEqual({ assayType: "stain", assayName: "PAS" });
    expect(parseAgent("ihc::CD31", CATALOG_SEP)).toEqual({ assayType: "ihc", assayName: "CD31" });
  });

  it("keeps a separator that is part of the agent NAME", () => {
    // The bug this replaces: `const [type, name] = value.split("::")` drops
    // everything after the second separator, so an agent the lab named with one
    // in it silently became a different agent. Splitting at the first occurrence
    // only cannot truncate.
    expect(parseAgent("stain:CD31: clone 2")).toEqual({
      assayType: "stain",
      assayName: "CD31: clone 2",
    });
    expect(parseAgent("ihc::CD31::clone2", CATALOG_SEP)).toEqual({
      assayType: "ihc",
      assayName: "CD31::clone2",
    });
    // And the round trip survives it, which is what the select depends on.
    const name = "CD31: clone 2";
    expect(parseAgent(formatAgent("stain", name)).assayName).toBe(name);
  });

  it("is total on a value with no separator", () => {
    // "extra" is a real option value in these selects and must not throw.
    expect(parseAgent("extra")).toEqual({ assayType: "extra", assayName: "" });
  });
});
