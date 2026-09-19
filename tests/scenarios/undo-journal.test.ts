// The undo journal restores the database exactly (ht-undo-snapshot-on-write-path prototype).
//
// For each step of a lab's work on the real db.ts, including the ones that DELETE rows and the
// ones whose deletes cascade: every table is read before and after, the journal is replayed back
// to the step's mark and every table must read exactly as before, then replayed forward (redo)
// and every table must read exactly as after. Row for row, rowid included, audit trail included.
// Only the session and bookkeeping tables undo has never rewound are left out.
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

const NOT_COMPARED = new Set(["undo_journal", "sqlite_sequence", "users", "app_settings", "_sqlx_migrations", "schema_meta"]);

function dump(l: Lab): Record<string, unknown[]> {
  const tables = l.rows(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).map((r) => String(r.name));
  return Object.fromEntries(
    tables.filter((t) => !NOT_COMPARED.has(t)).map((t) => [t, l.rows(`SELECT rowid AS __rowid, * FROM "${t}" ORDER BY rowid`)]),
  );
}

it("replaying the journal back to a mark, and forward again, reproduces every table exactly", async () => {
  lab = await openLab();
  const l = lab;
  const db = l.db;
  const project = (await db.listProjects()).find((p: { code: string }) => p.code === "EE");
  const now = "2026-09-18 10:00";
  const ctx: Record<string, number> = {};

  const steps: Array<[string, () => Promise<unknown>]> = [
    ["add a block and take it to embedded", async () => (ctx.a = await l.sample("block A", "embedded", { cut_notes: "5 um" }))],
    ["add a second block to ethanol", async () => (ctx.b = await l.sample("block B", "in_ethanol"))],
    ["start a processing run", async () => (ctx.batch = await db.startProcessingBatch({ sampleIds: [ctx.b], processingType: "Short", operatorName: "KG", startedAt: now, checklistLabels: ["Loaded", "Started"] }))],
    ["empty the run (deletes it, its members and checklist)", () => db.updateBatchMembers(ctx.batch, [])],
    ["cut two groups", async () => ([ctx.g1, ctx.g2] = await db.createSectionRequests(ctx.a, [
      { duplicates: 3, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
      { duplicates: 2, stains: "PAS", assay_type: "stain", assay_name: "PAS" },
    ]))],
    ["section one", () => db.updateSectionStage(ctx.g1, "sectioned")],
    ["note a slide", async () => db.setSlideNotes((await db.listSlidesForSample(ctx.a))[0].id, "fold at edge")],
    ["tag depth", async () => db.setSlidesDepthTag((await db.listSlidesForSample(ctx.a)).map((s: { id: number }) => s.id), "L2", "deep")],
    ["remove a group", () => db.removeSectionRequest(ctx.g2, "wrong stain")],
    ["tick a checklist step", async () => {
      const items = await db.ensureChecklist({ scopeType: "sample", scopeId: ctx.a, stageKey: "in_fixative", protocolName: "Fix", labels: ["one", "two"] });
      await db.setChecklistItemComplete(items[0].id, true, "KG");
    }],
    ["add an assay", async () => (ctx.assay = await db.addAssay({ assay_type: "stain", name: "Trichrome" }))],
    ["delete the assay", () => db.deleteAssay(ctx.assay)],
    ["add a project", () => db.addProject({ code: "ZZ", name: "Scratch", team_lead: "", is_active: true, lead_user_id: 0 })],
    ["delete the project", async () => db.deleteProject((await db.listProjects()).find((p: { code: string }) => p.code === "ZZ").id)],
    ["exhaust and archive", async () => (await db.setBlockExhausted(ctx.a, true), await db.setSampleArchived(ctx.b, true))],
    ["remove a sample", () => db.removeSamples([ctx.b], "duplicate")],
  ];
  expect(project).toBeTruthy();

  const done: string[] = [];
  for (const [name, step] of steps) {
    const before = dump(l);
    const mark = await db.journalHead();
    await step();
    const after = dump(l);
    expect(after, `${name} changed nothing, so it proves nothing`).not.toEqual(before);

    const redo = await db.revertJournalRange(mark);
    expect(dump(l), `undo of: ${name}`).toEqual(before);
    await db.revertJournalRange(redo.from, redo.to);
    expect(dump(l), `redo of: ${name}`).toEqual(after);
    done.push(name);
  }
  expect(done).toHaveLength(steps.length);

  // And all of it at once, back to the empty lab, then forward to the end.
  const end = dump(l);
  const everything = await db.revertJournalRange(0);
  expect(l.rows(`SELECT COUNT(*) AS n FROM samples`)[0].n).toBe(0);
  await db.revertJournalRange(everything.from, everything.to);
  expect(dump(l)).toEqual(end);
});
