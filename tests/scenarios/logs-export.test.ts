// What the Logs export writes, pinned cell by cell against the record it was built from.
//
// Replaces xlsx-exports.spec.ts:111's "compared by eye". The Logs screen shows four notes (#155),
// so the export carries all four, each under the label the intake form and the screen use
// (src/lib/sampleNotes.ts), plus the physical slide's own note under its own name. The captain's
// ruling: "3c, nothing reads currently" - the columns are renamed to match the screen. Any change
// to the format is a deliberate, visible edit here, never a silent one. CSV and XLSX share
// logRowCells (src/lib/export.ts), so the CSV is the cells both files hold.
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

const HEADERS = [
  "Project", "Sample ID", "Description", "Processing", "Sample Stage", "Exhausted", "Date Added",
  "Slide", "Assay Type", "Stain / IHC", "Slide Stage",
  "Cut", "Stained", "Coverslipped", "Imaged", "Analyzed",
  "This Slide's Notes", "Embedding Notes", "Sectioning / Cut Notes", "Slide Notes", "General Notes",
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

it("the Logs export carries all four notes, each in the column its on-screen label names", async () => {
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
  expect(header.join(" | "), "Logs export headers").toBe(HEADERS.join(" | "));

  const at = (r: string[], h: string) => r[header.indexOf(h)];
  const notes = rows.map(
    (r) =>
      `${at(r, "Slide") ? "slide row" : "no slide"}: ` +
      `embedding=${at(r, "Embedding Notes")} | cut=${at(r, "Sectioning / Cut Notes")} | ` +
      `slide=${at(r, "Slide Notes")} | general=${at(r, "General Notes")} | this slide=${at(r, "This Slide's Notes")}`,
  );
  expect(notes.join("; "), "note cells per exported row").toBe(
    'slide row: embedding=EMB-7f3 | cut=CUT-7f3 | slide=PLAN-7f3 | general=GEN-7f3, with a comma | this slide=SLIDE-7f3 "quoted"',
  );
});
