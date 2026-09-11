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
    embedding_notes: "",
    preselected_stains: "",
    ...over,
  }) as unknown as Sample;

/** The stored shape of an assigned-but-uncut stain (#136). */
const assigned = (...agents: Array<[string, string]>) =>
  JSON.stringify(agents.map(([assay_type, assay_name]) => ({ assay_type, assay_name })));

/** Split a CSV line on commas that are not inside a quoted cell. */
const cells = (line: string) =>
  (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [])
    .map((c) => c.replace(/,$/, ""))
    .slice(0, -1)
    .map((c) => (c.startsWith('"') ? c.slice(1, -1).replace(/""/g, '"') : c));

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
    // Codes are STORED padded ("EE-0001-A") but exported in the display form
    // users see in the app (#87).
    expect(lines[1]).toContain("EE-1-A");
    expect(lines[2]).toContain("EE-1-B");
    expect(csv).not.toContain("EE-0001");
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
    expect(lines[1]).toContain("EE-2");
  });

  // #136 — "the current fixing TE8-12 samples have SafO assigned but I cannot
  // tell that from the log." The exported log is still the log.
  describe("assigned but unsectioned stains (#136)", () => {
    it("names a stain assigned to a block that has no slides at all", () => {
      const csv = buildLogsCsv([
        {
          sample: sample({
            sample_code: "TE-0008",
            current_stage: "in_fixative",
            preselected_stains: assigned(["stain", "Safranin O"]),
          }),
          slides: [],
        },
      ]);
      const lines = csv.trim().split("\n");
      expect(lines).toHaveLength(2);
      const row = cells(lines[1]);
      const header = cells(lines[0]);
      expect(row[header.indexOf("Sample ID")]).toBe("TE-8");
      expect(row[header.indexOf("Stain / IHC")]).toBe("Safranin O");
      expect(row[header.indexOf("Assay Type")]).toBe("stain");
      // No glass exists, and the row has to say so rather than look like a slide.
      expect(row[header.indexOf("Slide")]).toBe("");
      expect(row[header.indexOf("Cut")]).toBe("");
      expect(row[header.indexOf("Slide Stage")]).toBe("requested (not cut)");
    });

    it("names a second stain still assigned to a block that already has slides", () => {
      const csv = buildLogsCsv([
        {
          sample: sample({
            preselected_stains: assigned(["stain", "Safranin O"]),
          }),
          slides: [
            slide({ assay_name: "Alcian Blue" }),
            slide({ slide_code: "EE-0001-B", purpose: "extra", assay_name: "", assay_type: "" }),
          ],
        },
      ]);
      const lines = csv.trim().split("\n");
      // Two slides, then the outstanding request — dropping it silently is the
      // bug: the block's own rows named every agent EXCEPT the one still owed.
      expect(lines).toHaveLength(4);
      expect(lines[1]).toContain("Alcian Blue");
      expect(lines[2]).toContain("Extra");
      const header = cells(lines[0]);
      const row = cells(lines[3]);
      expect(row[header.indexOf("Stain / IHC")]).toBe("Safranin O");
      expect(row[header.indexOf("Slide")]).toBe("");
      expect(row[header.indexOf("Slide Stage")]).toBe("requested (not cut)");
    });

    it("keeps one row per outstanding request, so two of an agent are two slides owed", () => {
      const csv = buildLogsCsv([
        {
          sample: sample({ preselected_stains: assigned(["ihc", "CD68"], ["ihc", "CD68"]) }),
          slides: [],
        },
      ]);
      expect(csv.trim().split("\n")).toHaveLength(3);
    });

    it("writes no request row for a block removed before it was cut", () => {
      const safO = assigned(["stain", "Safranin O"]);
      const csv = buildLogsCsv([
        { sample: sample({ sample_code: "EE-0001", preselected_stains: safO }), slides: [] },
        {
          sample: sample({ sample_code: "EE-0002", current_stage: "removed", preselected_stains: safO }),
          slides: [],
        },
      ]);
      const lines = csv.trim().split("\n");
      const header = cells(lines[0]);
      expect(lines).toHaveLength(3);
      const live = cells(lines[1]);
      expect(live[header.indexOf("Sample ID")]).toBe("EE-1");
      expect(live[header.indexOf("Slide Stage")]).toBe("requested (not cut)");
      const removed = cells(lines[2]);
      expect(removed[header.indexOf("Sample ID")]).toBe("EE-2");
      expect(removed[header.indexOf("Stain / IHC")]).toBe("");
      expect(removed[header.indexOf("Slide Stage")]).toBe("");
    });
  });

  it("carries the block's embedding notes on every one of its rows (#137)", () => {
    const csv = buildLogsCsv([
      {
        sample: sample({ embedding_notes: "cut face down", preselected_stains: assigned(["stain", "PAS"]) }),
        slides: [slide({})],
      },
    ]);
    const lines = csv.trim().split("\n");
    const header = cells(lines[0]);
    expect(header).toContain("Embedding Notes");
    for (const line of lines.slice(1)) {
      expect(cells(line)[header.indexOf("Embedding Notes")]).toBe("cut face down");
    }
  });

  it("labels an unstained extra and RFC-escapes commas/quotes", () => {
    const csv = buildLogsCsv([
      { sample: sample({ sample_description: 'a, "b"' }), slides: [slide({ purpose: "extra", assay_name: "", assay_type: "" })] },
    ]);
    expect(csv).toContain('"a, ""b"""');
    expect(csv).toContain("Extra");
  });
});
