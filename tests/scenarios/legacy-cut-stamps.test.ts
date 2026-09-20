// #182 — glass that WAS cut, by a build that never stamped it.
//
// The builds before 0.2.3 inserted extras with no cut date at all, and before
// 0.8.0 a group dragged from Needs Sectioning straight past it was never
// recorded as cut either (#95, docs/issue_remediation_plan.md). Those rows are
// real glass sitting in a box on the bench. That was harmless while the cut date
// was only ever displayed; it is not harmless now that the date decides whether
// a slide may be stained, so the one-time backfill in getDb() gives each such
// slide its group's own record of when it left the queue — and invents nothing
// for a group that records no such moment.
//
// On the real db.ts, on a real SQLite file, back-filled at open the way the app
// back-fills it: the rows are written into the file while nothing is running,
// exactly as an older build left them, and the lab is relaunched.
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";
import { launch, quit, type App } from "../compat/app";
import { currentBuild } from "../compat/builds";
import { DatabaseSync } from "../compat/sqlite";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let running: App | null = null;
afterEach(async () => {
  if (running) await quit(running);
  running = null;
});

interface LegacyGroup {
  stage: string;
  stamps: Record<string, string>;
}

/**
 * Write cut groups an older build would have written — slides with no cut date —
 * into the lab's file, then open it again. The backfill marker is cleared with
 * them: an image that predates the stamp has never been back-filled.
 */
async function reopenWithLegacyRows(
  lab: Lab,
  sampleId: number,
  groups: LegacyGroup[],
): Promise<{ app: App; slides: number[] }> {
  const machine = lab.app.machine;
  await quit(lab.app);

  const file = new DatabaseSync(machine.dbFile);
  const slides: number[] = [];
  try {
    file.exec(`DELETE FROM schema_meta WHERE key = 'slide_cut_stamps_backfilled'`);
    for (const group of groups) {
      const columns = Object.keys(group.stamps);
      const groupId = Number(
        file
          .prepare(
            `INSERT INTO section_requests (sample_id, duplicates, stains, current_stage${columns
              .map((c) => `, ${c}`)
              .join("")})
             VALUES (?, 1, '', ?${columns.map(() => ", ?").join("")})`,
          )
          .run(sampleId, group.stage, ...columns.map((c) => group.stamps[c])).lastInsertRowid,
      );
      slides.push(
        Number(
          file
            .prepare(
              `INSERT INTO slides
                (section_request_id, slide_ordinal, slide_code, purpose, assignment_saved, current_stage)
               VALUES (?, 1, ?, 'extra', 1, 'extra')`,
            )
            .run(groupId, `EE-0001-Z${groupId}`).lastInsertRowid,
        ),
      );
    }
  } finally {
    file.close();
  }

  running = await launch(currentBuild(), machine);
  return { app: running, slides };
}

const cutDateOf = (app: App, slide: number): string | null => {
  const file = new DatabaseSync(app.machine.dbFile, { readOnly: true });
  try {
    return (file.prepare(`SELECT stage_cut_at FROM slides WHERE id = ?`).get(slide) as Any)
      .stage_cut_at;
  } finally {
    file.close();
  }
};

it("gives unstamped glass its group's own cut date, and invents none", async () => {
  const lab = await openLab();
  running = lab.app;
  const block = await lab.sample("a block cut by an older build");

  const { app, slides } = await reopenWithLegacyRows(lab, block, [
    // A pre-0.2.3 extra: its group was sectioned, the slide was never stamped.
    {
      stage: "stain_requested",
      stamps: {
        stage_needs_sectioning_at: "2023-01-01 09:00",
        stage_sectioned_at: "2023-01-02 10:00",
        stage_stain_requested_at: "2023-01-03 11:00",
      },
    },
    // A pre-0.8.0 group dragged straight to Ready for Imaging: no sectioned stamp.
    {
      stage: "ready_for_imaging",
      stamps: {
        stage_needs_sectioning_at: "2023-02-01 09:00",
        stage_ready_for_imaging_at: "2023-02-02 10:00",
      },
    },
    // Still queued: it has not been cut, and must stay that way.
    { stage: "needs_sectioning", stamps: { stage_needs_sectioning_at: "2023-03-01 09:00" } },
    // Past the queue but recording no moment it left — nothing honest to say.
    { stage: "sectioned", stamps: {} },
  ]);
  const [sectioned, straightToImaging, stillQueued, undated] = slides;

  expect(cutDateOf(app, sectioned), "the sectioned group's own stamp is the cut date").toBe(
    "2023-01-02 10:00",
  );
  expect(
    cutDateOf(app, straightToImaging),
    "a group with no sectioned stamp gives the earliest moment it records past the queue",
  ).toBe("2023-02-02 10:00");
  expect(cutDateOf(app, stillQueued), "a slide still waiting to be cut is left alone").toBeNull();
  expect(cutDateOf(app, undated), "and no date is invented for a group that records none").toBeNull();

  // What that means on the bench: the glass is back in the inventory, and a
  // stain request uses it instead of cutting the block again for a section that
  // already exists.
  const inventory = (await app.db.listExtraSlides()) as Array<{ id: number }>;
  expect(
    inventory.map((slide) => slide.id).filter((id) => slides.includes(id)),
    "the back-filled glass is offered again; the unstamped rows are not",
  ).toEqual([sectioned, straightToImaging]);
  expect(
    (
      await app.db.requestStainForSample({
        sampleId: block,
        assayType: "stain",
        assayName: "PAS",
      })
    ).target,
    "a stain request takes the back-filled extra rather than cutting the block again",
  ).toBe("extra");
});
