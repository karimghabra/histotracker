import { describe, it, expect } from "vitest";
import { buildLogsCsv } from "./export";
import type { Sample, Slide } from "./types";

// buildLogsCsv only reads a handful of fields, so cast minimal partials.
const sample = (over: Partial<Sample>): Sample =>
  ({
    sample_code: "EE-0001",
    project_code: "EE",
    sample_description: "block",
    current_stage: "embedded",
    date_added: "2026-07-24 10:00",
    overall_notes: "",
    ...over,
  }) as unknown as Sample;

const slide = (over: Partial<Slide>): Slide =>
  ({
    slide_code: "EE-0001-A",
    purpose: "stain",
    assay_type: "stain",
    assay_name: "H&E",
    current_stage: "analyzed",
    stage_cut_at: "2026-07-24 11:00",
    created_at: "2026-07-24T18:00",
    stage_stained_at: "2026-07-24 12:00",
    stage_coverslipped_at: null,
    stage_pictures_taken_at: null,
    stage_analyzed_at: "2026-07-24 13:00",
    notes: "",
    ...over,
  }) as unknown as Slide;

describe("buildLogsCsv", () => {
  it("emits a header row plus one row per slide", () => {
    const csv = buildLogsCsv([{ sample: sample({}), slides: [slide({}), slide({ slide_code: "EE-0001-B" })] }]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("Sample ID");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("EE-0001-A");
    expect(lines[2]).toContain("EE-0001-B");
    expect(lines[1]).toContain("H&E");
    expect(lines[1]).toContain("2026-07-24 13:00"); // Analyzed stamp present
  });

  it("prefers stage_cut_at but falls back to created_at for Cut", () => {
    const withStamp = buildLogsCsv([{ sample: sample({}), slides: [slide({})] }]);
    expect(withStamp).toContain("2026-07-24 11:00"); // stage_cut_at wins
    const withoutStamp = buildLogsCsv([
      { sample: sample({}), slides: [slide({ stage_cut_at: null, created_at: "2026-07-20 09:00" })] },
    ]);
    expect(withoutStamp).toContain("2026-07-20 09:00"); // created_at fallback
  });

  it("emits a single row for a sample with no slides", () => {
    const csv = buildLogsCsv([{ sample: sample({ sample_code: "EE-0002" }), slides: [] }]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("EE-0002");
  });

  it("labels an unstained extra and RFC-escapes commas/quotes", () => {
    const csv = buildLogsCsv([
      { sample: sample({ sample_description: 'a, "b"' }), slides: [slide({ purpose: "extra", assay_name: "", assay_type: "" })] },
    ]);
    expect(csv).toContain('"a, ""b"""');
    expect(csv).toContain("Extra");
  });
});
