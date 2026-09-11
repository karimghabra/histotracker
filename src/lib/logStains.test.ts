import { describe, it, expect } from "vitest";
import { logAgents, outstandingStains } from "./logStains";
import type { Sample, Slide } from "./types";

// These read a handful of fields, so cast minimal partials.
const sample = (over: Partial<Sample>): Sample =>
  ({ sample_code: "TE-0008", preselected_stains: "", ...over }) as unknown as Sample;
const slide = (assay_name: string): Slide => ({ assay_name }) as unknown as Slide;
const assigned = (...names: string[]) =>
  JSON.stringify(names.map((assay_name) => ({ assay_type: "stain", assay_name })));

describe("outstandingStains", () => {
  it("reads the stored column", () => {
    expect(outstandingStains(sample({ preselected_stains: assigned("Safranin O") }))).toEqual([
      { assay_type: "stain", assay_name: "Safranin O" },
    ]);
  });

  it("is empty for a block that owes nothing", () => {
    expect(outstandingStains(sample({}))).toEqual([]);
  });

  it("is empty for a block that can no longer be cut", () => {
    const safO = assigned("Safranin O");
    expect(outstandingStains(sample({ preselected_stains: safO, current_stage: "removed" }))).toEqual([]);
    expect(outstandingStains(sample({ preselected_stains: safO, block_exhausted: 1 }))).toEqual([]);
  });

  it("keeps the requests of an archived block, which can still be cut", () => {
    expect(
      outstandingStains(sample({ preselected_stains: assigned("Safranin O"), archived_at: "2026-09-01 10:00" })),
    ).toEqual([{ assay_type: "stain", assay_name: "Safranin O" }]);
  });
});

describe("logAgents", () => {
  // The literal ask in #136: a fixing block with a stain assigned and no slides
  // reads as having that stain, exactly as the board card and drawer do.
  it("names a stain assigned to a block with no slides", () => {
    const agents = logAgents(sample({ preselected_stains: assigned("Safranin O") }), []);
    expect(agents).toEqual([{ name: "Safranin O", requested: true }]);
  });

  it("lists cut glass first, then what is still only assigned", () => {
    const agents = logAgents(
      sample({ preselected_stains: assigned("Safranin O") }),
      [slide("Alcian Blue")],
    );
    expect(agents).toEqual([
      { name: "Alcian Blue", requested: false },
      { name: "Safranin O", requested: true },
    ]);
  });

  it("marks an agent that was cut AND requested again — the request is what is left to do", () => {
    const agents = logAgents(
      sample({ preselected_stains: assigned("H&E") }),
      [slide("H&E")],
    );
    expect(agents).toEqual([{ name: "H&E", requested: true }]);
  });

  it("matches agent names case-insensitively so one stain is not listed twice", () => {
    const agents = logAgents(
      sample({ preselected_stains: assigned("safranin o") }),
      [slide("Safranin O")],
    );
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("Safranin O"); // the glass's spelling wins
  });

  it("keeps a removed block's cut glass but drops what it was still owed", () => {
    const agents = logAgents(
      sample({ preselected_stains: assigned("Safranin O"), current_stage: "removed" }),
      [slide("Alcian Blue")],
    );
    expect(agents).toEqual([{ name: "Alcian Blue", requested: false }]);
  });

  it("ignores slides with no agent — an extra is not a stain", () => {
    expect(logAgents(sample({}), [slide("")])).toEqual([]);
  });
});
