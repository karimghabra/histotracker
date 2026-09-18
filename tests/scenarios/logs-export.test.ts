// What the Logs export writes today, pinned cell by cell against the record it was built from.
//
// Replaces xlsx-exports.spec.ts:111's "compared by eye". Whether the Logs export should also carry
// cut notes and the sample's slide-plan notes (the Logs screen shows four notes since #155) is the
// captain's open format question; this pins today's answer so any change to it is a deliberate,
// visible edit here, never a silent one. CSV and XLSX share logRowCells (src/lib/export.ts), so
// the CSV is the cells both files hold.
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

const HEADERS_TODAY = [
  "Project", "Sample ID", "Description", "Processing", "Sample Stage", "Exhausted", "Date Added",
  "Slide", "Assay Type", "Stain / IHC", "Slide Stage",
  "Cut", "Stained", "Coverslipped", "Imaged", "Analyzed",
  "Slide Notes", "Embedding Notes", "Sample Notes",
];

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), (i += 1);
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some(Boolean));
}

it("the Logs export's note cells each come from their own field, as today", async () => {
  lab = await openLab();
  // A distinct sentinel per field, so a swapped or dropped column cannot pass by coincidence.
  const block = await lab.sample("export block", "embedded", {
    embedding_notes: "EMB-7f3",
    cut_notes: "CUT-7f3",
    slide_notes: "PLAN-7f3",
    overall_notes: "GEN-7f3, with a comma",
  });
  await lab.db.createSectionRequests(block, [{ duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" }]);
  const [slide] = await lab.db.listSlidesForSample(block);
  await lab.db.setSlideNotes(slide.id, 'SLIDE-7f3 "quoted"');

  const sample = ((await lab.db.listAllSamples()) as Array<{ id: number }>).find((s) => s.id === block);
  const csv: string = lab.app.exporter.buildLogsCsv([{ sample, slides: await lab.db.listSlidesForSample(block) }]);
  const [header, ...rows] = parseCsv(csv);
  expect(header.join(" | "), "Logs export headers").toBe(HEADERS_TODAY.join(" | "));

  const at = (r: string[], h: string) => r[header.indexOf(h)];
  const notes = rows.map(
    (r) => `${at(r, "Slide") ? "slide row" : "no slide"}: slide=${at(r, "Slide Notes")} embedding=${at(r, "Embedding Notes")} sample=${at(r, "Sample Notes")}`,
  );
  expect(notes.join("; "), "note cells per exported row").toBe(
    'slide row: slide=SLIDE-7f3 "quoted" embedding=EMB-7f3 sample=GEN-7f3, with a comma',
  );
  const absent = ["CUT-7f3", "PLAN-7f3"].filter((s) => csv.includes(s));
  expect(absent.join(",") || "neither", "cut and slide-plan notes in the export (not carried today)").toBe("neither");
});
