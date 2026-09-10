import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildLogsXlsxBytes } from "./export";
import type { Sample, Slide } from "./types";

// The Logs Excel export is a shipped file format: an `.xlsx` is a ZIP of
// SpreadsheetML parts. These helpers decode the bytes we hand the user back
// into the grid Excel would show, so the assertions below are about what the
// technician reads in the workbook — not about how export.ts is written.
// (A shape mistake in the writer call is accepted silently and produces a
// workbook with no cells at all, which only reading the bytes can catch.)

/** Read a ZIP archive into { path -> bytes } via its central directory. */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a ZIP archive: no end-of-central-directory record");

  const files = new Map<string, Uint8Array>();
  let entry = view.getUint32(eocd + 16, true);
  for (let i = view.getUint16(eocd + 10, true); i > 0; i--) {
    const method = view.getUint16(entry + 10, true);
    const compressedSize = view.getUint32(entry + 20, true);
    const nameLength = view.getUint16(entry + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(entry + 46, entry + 46 + nameLength));
    const local = view.getUint32(entry + 42, true);
    const start =
      local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + compressedSize);
    files.set(name, method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw);
    entry += 46 + nameLength + view.getUint16(entry + 30, true) + view.getUint16(entry + 32, true);
  }
  return files;
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** "C" -> 2, "AB" -> 27: the 0-based column of a cell reference. */
const columnIndex = (ref: string) =>
  [...(ref.match(/^[A-Z]+/)?.[0] ?? "A")].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

/** Decode the first worksheet of a workbook into rows of cell text. */
function readSheet(workbook: Uint8Array): string[][] {
  const files = unzip(workbook);
  const part = (name: string) => new TextDecoder().decode(files.get(name) ?? new Uint8Array());

  const shared = [...part("xl/sharedStrings.xml").matchAll(/<si>(.*?)<\/si>/gs)].map(([, si]) =>
    [...si.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(([, t]) => unescapeXml(t)).join(""),
  );

  return [...part("xl/worksheets/sheet1.xml").matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map(
    ([, row]) => {
      const cells: string[] = [];
      for (const [, attrs, value] of row.matchAll(/<c([^>]*)(?:\/>|>(.*?)<\/c>)/gs)) {
        const at = columnIndex(attrs.match(/r="([A-Z]+\d+)"/)?.[1] ?? "A1");
        while (cells.length < at) cells.push("");
        const inline = value?.match(/<t[^>]*>(.*?)<\/t>/s)?.[1];
        const v = value?.match(/<v>(.*?)<\/v>/s)?.[1];
        cells[at] = / t="s"/.test(attrs)
          ? (shared[Number(v)] ?? "")
          : unescapeXml(inline ?? v ?? "");
      }
      return cells;
    },
  );
}

const sample = (over: Partial<Sample>): Sample =>
  ({
    sample_code: "EE-0001",
    project_code: "EE",
    sample_description: "TE8-12 fixing sample",
    processing_type: "Short",
    current_stage: "received",
    date_added: "2026-09-10 10:00",
    overall_notes: "",
    embedding_notes: "",
    preselected_stains: "",
    ...over,
  }) as unknown as Sample;

const slide = (over: Partial<Slide>): Slide =>
  ({
    slide_code: "EE-0001-A",
    purpose: "stain",
    assay_type: "stain",
    assay_name: "H&E",
    current_stage: "stained",
    stage_cut_at: "2026-09-09 11:00",
    created_at: "2026-09-09T11:00",
    stage_stained_at: "2026-09-09 12:00",
    stage_coverslipped_at: null,
    stage_pictures_taken_at: null,
    stage_analyzed_at: null,
    notes: "",
    ...over,
  }) as unknown as Slide;

/** The stored shape of an assigned-but-uncut agent (#136). */
const assigned = (...agents: Array<[string, string]>) =>
  JSON.stringify(agents.map(([assay_type, assay_name]) => ({ assay_type, assay_name })));

/** The cells of the exported row naming `agent`, or undefined if it has none. */
const rowFor = (grid: string[][], agent: string) =>
  grid.slice(1).find((cells) => cells[9] === agent);

describe("buildLogsXlsxBytes", () => {
  it("writes a real sheet: a header row plus one row per slide", async () => {
    const grid = readSheet(
      await buildLogsXlsxBytes([{ sample: sample({}), slides: [slide({})] }]),
    );

    expect(grid[0]).toContain("Sample ID");
    expect(grid[0]).toContain("Stain / IHC");
    expect(grid).toHaveLength(2);
    // Codes are stored padded but exported in the display form (#87).
    expect(grid[1][1]).toBe("EE-1");
    expect(grid[1][7]).toBe("EE-1-A");
    expect(grid[1][9]).toBe("H&E");
  });

  it("carries a stain assigned to a block with no slides at all (#136)", async () => {
    const grid = readSheet(
      await buildLogsXlsxBytes([
        { sample: sample({ preselected_stains: assigned(["stain", "Safranin O"]) }), slides: [] },
      ]),
    );

    const row = rowFor(grid, "Safranin O");
    expect(row).toBeDefined();
    expect(row?.[1]).toBe("EE-1");
    expect(row?.[7]).toBe(""); // no slide exists yet
    expect(row?.[10]).toBe("requested (not cut)");
  });

  it("carries a still-assigned stain on a block that already has glass (#136)", async () => {
    const grid = readSheet(
      await buildLogsXlsxBytes([
        {
          sample: sample({
            embedding_notes: "Embed cut side down",
            // H&E has been cut, so it is no longer outstanding; SafO still is.
            preselected_stains: assigned(["stain", "Safranin O"]),
          }),
          slides: [slide({}), slide({ slide_code: "EE-0001-B" })],
        },
      ]),
    );

    // Two slide rows, plus the one agent that is still only assigned.
    expect(grid).toHaveLength(4);
    expect(rowFor(grid, "Safranin O")?.[10]).toBe("requested (not cut)");
    // The embedding note (#137) rides along on every row of the block.
    expect(grid.slice(1).map((cells) => cells[17])).toEqual([
      "Embed cut side down",
      "Embed cut side down",
      "Embed cut side down",
    ]);
  });
});
