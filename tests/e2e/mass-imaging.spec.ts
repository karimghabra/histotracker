import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";

/**
 * #150: several slides marked imaged in one action.
 *
 * The rack drawer's selection (the tick list that moves, splits and removes slides) also marks
 * imaged, where the checkbox on each row did it one slide at a time. Each ticked slide must end
 * up recorded as if it had been marked alone, a slide the single-slide rule refuses is left
 * alone and listed, and the whole action is one undo step.
 *
 * The rack is built through `db.ts`; the rest is driven the way a user drives it. Every
 * assertion is on text or on rows, never on a picture.
 */

const USER = "Alex Rivera";

type Rows = Array<Record<string, unknown>>;
const select = (page: Page, sql: string) =>
  page.evaluate(
    (q) => (window as unknown as { __SHIM_SELECT__: (s: string) => Rows }).__SHIM_SELECT__(q),
    sql,
  );

async function boot(page: Page): Promise<void> {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill(USER);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Signed-in user").locator("option", { hasText: USER })).toHaveCount(1);
  await page.keyboard.press("Escape");
  const overlay = page.locator("div.fixed.inset-0.z-50");
  if (await overlay.count()) await overlay.first().click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
  await page.getByLabel("Signed-in user").selectOption({ label: USER });
}

/** One or more blocks cut into H&E slides (one cut group per size given, one block per entry
 *  in `samples`), each rack taken through staining to Ready for Imaging. Several blocks land
 *  on the SAME staining rack (a cross-sample loading rack for the agent) but each gets its own
 *  per-sample imaging rack once staining finishes, so `samples > 1` seeds several separate
 *  Ready-for-Imaging racks (EE-1, EE-2, …) in one staining pass. */
async function seedRackAtImaging(page: Page, groups: number[] = [3], samples = 1): Promise<void> {
  await page.evaluate(
    async ({ sizes, sampleCount }) => {
      const db = (await import("/src/lib/db.ts")) as unknown as Record<string, Function>;
      const projectId = (await db.addProject({
        code: "EE",
        name: "Enthesis Engineering",
        team_lead: "",
        is_active: true,
        lead_user_id: 0,
      })) as number;
      for (let i = 0; i < sampleCount; i += 1) {
        const id = (await db.addSample(
          {
            project_id: projectId,
            sample_description: "imaging block",
            processing_type: "Short",
            fixative_agent: "Z-Fix",
            needs_decalcification: 0,
            cut_notes: "",
            slide_notes: "",
            embedding_notes: "",
            stains: "",
            preselected_stains: [],
            overall_notes: "",
          },
          "EE",
        )) as number;
        for (const stage of [
          "in_fixative", "fixative_removed", "in_ethanol", "processing_started",
          "processed", "picked_up", "needs_embedding", "embedded",
        ]) {
          await db.updateSampleStage(id, stage);
        }
        const made = (await db.createSectionRequests(
          id,
          sizes.map((duplicates: number) => ({ duplicates, stains: "H&E", assay_type: "stain", assay_name: "H&E" })),
        )) as number[];
        for (const group of made) {
          await db.updateSectionStage(group, "sectioned");
          await db.updateSectionStage(group, "stain_requested");
        }
      }
    },
    { sizes: groups, sampleCount: samples },
  );
  await page.goto("/");
  await expect(page.getByLabel("Signed-in user")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Signed-in user").selectOption({ label: USER });

  // Run the stain protocol the way the bench does. Finishing it moves the rack to Ready for
  // Imaging, which is what hands the glass to a per-sample imaging rack (as in workflow.spec.ts).
  // One pass covers every sample seeded above: they share the same staining rack (the agent's
  // cross-sample loading rack), so finishing it scatters them onto their own imaging racks.
  const staining = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Staining / IHC", exact: true }) });
  await staining.getByText("H&E").first().click();
  for (const step of ["Stained", "Coverslipped"]) {
    await page.getByRole("button", { name: step, exact: true }).click();
  }
}

const drawer = (page: Page) =>
  page.locator("div.border-l").filter({ has: page.getByText("Assay slides") }).last();

async function openImagingRack(page: Page): Promise<void> {
  const imaging = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Ready for Imaging", exact: true }) });
  await imaging.getByText("EE-1", { exact: true }).first().click();
  await expect(page.getByText("Assay slides").first()).toBeVisible();
  await page.getByRole("button", { name: "Select slides" }).click();
}

/** Ctrl-click several Ready-for-Imaging racks together, the board's own multi-select gesture
 *  (Board.tsx handleSelectStack), then open the drawer on that selection. */
async function selectImagingRacks(page: Page, codes: string[]): Promise<void> {
  const imaging = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Ready for Imaging", exact: true }) });
  await imaging.getByText(codes[0], { exact: true }).first().click();
  for (const code of codes.slice(1)) {
    await imaging.getByText(code, { exact: true }).first().click({ modifiers: ["Control"] });
  }
  await expect(page.getByText("Assay slides").first()).toBeVisible();
}

const picked = (page: Page) =>
  select(
    page,
    `SELECT slide_code, current_stage, stage_pictures_taken_at AS at FROM slides
      WHERE purpose = 'stain' ORDER BY slide_ordinal, id`,
  );

test("#150: ticked slides are marked imaged in one action, each with its own record, and one undo takes them back", async ({
  page,
}) => {
  await boot(page);
  await seedRackAtImaging(page);
  await openImagingRack(page);

  const boxes = drawer(page).locator('input[type="checkbox"][aria-label^="Select EE-"]');
  await expect(boxes).toHaveCount(3);
  const markButton = page.getByRole("button", { name: /Tick the slides to mark imaged/ });
  await expect(markButton).toBeDisabled();

  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.getByRole("button", { name: "Mark 2 slides imaged" }).click();

  await expect(async () => {
    const rows = await picked(page);
    expect(rows.filter((r) => r.at).length).toBe(2);
  }).toPass({ timeout: 15_000 });
  const rows = await picked(page);
  expect(rows.map((r) => [r.current_stage, Boolean(r.at)])).toEqual([
    ["pictures_taken", true],
    ["pictures_taken", true],
    ["ready_for_imaging", false],
  ]);
  // Each slide has its own audit record, attributed to the signed-in user.
  const audit = await select(
    page,
    `SELECT entity_id, COUNT(*) AS n FROM audit_events
      WHERE entity_type = 'slide' AND action = 'update' AND details = 'stage=pictures_taken'
        AND user_id IS NOT NULL
      GROUP BY entity_id`,
  );
  expect(audit).toHaveLength(2);
  expect(audit.every((r) => r.n === 1)).toBe(true);
  // The selection closed, and the rack reads the new count.
  await expect(page.getByText("2/3 imaged")).toBeVisible();

  // One undo step for the whole action.
  await page.getByTitle("Undo (Ctrl+Z)").click();
  await expect(async () => {
    expect((await picked(page)).filter((r) => r.at)).toHaveLength(0);
  }).toPass({ timeout: 15_000 });
});

test("#150: a slide the single-slide rule refuses is left untouched and listed, and the rest are marked", async ({
  page,
}) => {
  await boot(page);
  await seedRackAtImaging(page, [2, 1]);
  // The UI cannot put glass that was never cut in an imaging rack, so plant it: the second cut
  // group is put back to waiting to be cut, which is what the data layer refuses (#167).
  const [{ slide_code: refusedCode, section_request_id }] = (await select(
    page,
    `SELECT slide_code, section_request_id FROM slides WHERE purpose = 'stain' ORDER BY id DESC LIMIT 1`,
  )) as Array<{ slide_code: string; section_request_id: number }>;
  await page.evaluate(
    (group) =>
      (window as unknown as { __SHIM_SQL__: (s: string, p: unknown[]) => void }).__SHIM_SQL__(
        `UPDATE section_requests SET current_stage = 'needs_sectioning' WHERE id = ?`,
        [group],
      ),
    section_request_id,
  );
  await page.goto("/");
  await page.getByLabel("Signed-in user").selectOption({ label: USER });
  await openImagingRack(page);

  const boxes = drawer(page).locator('input[type="checkbox"][aria-label^="Select EE-"]');
  await expect(boxes).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) await boxes.nth(i).check();
  await page.getByRole("button", { name: "Mark 3 slides imaged" }).click();

  const notice = drawer(page).getByRole("status");
  await expect(notice).toContainText("Marked 2 slides as imaged");
  await expect(notice).toContainText("1 refused and left untouched");
  await expect(notice).toContainText("still waiting to be cut");

  const rows = (await picked(page)) as Array<{ slide_code: string; at: string | null }>;
  expect(rows.find((r) => r.slide_code === refusedCode)?.at ?? null, "the refused slide is untouched").toBeNull();
  expect(rows.filter((r) => r.at)).toHaveLength(2);
  // The refused slide stays ticked so it is on the screen; the marked ones are cleared.
  await expect(drawer(page).locator('input[type="checkbox"][aria-label^="Select EE-"]:checked')).toHaveCount(1);

  // Asking again for only the refused slide changes nothing and says why, as an error.
  await page.getByRole("button", { name: "Mark 1 slide imaged" }).click();
  await expect(drawer(page)).toContainText("1 refused and left untouched");
  expect((await picked(page)).filter((r) => r.at)).toHaveLength(2);
});

test("#150: nobody signed in cannot select or mark slides, and nothing changes", async ({ page }) => {
  await boot(page);
  await seedRackAtImaging(page);
  await page.getByLabel("Signed-in user").selectOption("");
  const keepReading = page.getByRole("button", { name: "Keep reading" });
  if (await keepReading.count()) await keepReading.click();

  const imaging = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Ready for Imaging", exact: true }) });
  await imaging.getByText("EE-1", { exact: true }).first().click();
  await expect(page.getByText("Assay slides").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Select slides" })).toHaveCount(0);
  expect((await picked(page)).filter((r) => r.at)).toHaveLength(0);
});

/**
 * #150 follow-up: several RACKS marked imaged in one action.
 *
 * #173 gave the tick list inside one open rack a bulk "mark imaged" — this is the gap the
 * reporter came back with: selecting several racks together (the same gesture "Complete
 * Imaging" already spans) still made you open each rack's drawer and tick its slides one rack
 * at a time. The fix reuses the same per-slide db.ts call (markSlidesImaged) across every
 * selected rack's slides, so it is the same guarantees, just a bigger input.
 */
test("#150: several selected racks are marked imaged in one action, and one undo takes them all back", async ({
  page,
}) => {
  await boot(page);
  await seedRackAtImaging(page, [3], 2);
  await selectImagingRacks(page, ["EE-1", "EE-2"]);

  const markButton = drawer(page).getByRole("button", { name: /Mark \d+ Slides? Imaged/ });
  await expect(markButton).toHaveText("Mark 6 Slides Imaged");
  await markButton.click();

  await expect(async () => {
    const rows = await picked(page);
    expect(rows.filter((r) => r.at).length).toBe(6);
  }).toPass({ timeout: 15_000 });
  const rows = await picked(page);
  expect(rows.every((r) => r.current_stage === "pictures_taken" && r.at)).toBe(true);
  // Each of the 6 slides has its own audit record, exactly as marking it alone would.
  const audit = await select(
    page,
    `SELECT entity_id, COUNT(*) AS n FROM audit_events
      WHERE entity_type = 'slide' AND action = 'update' AND details = 'stage=pictures_taken'
        AND user_id IS NOT NULL
      GROUP BY entity_id`,
  );
  expect(audit).toHaveLength(6);
  expect(audit.every((r) => r.n === 1)).toBe(true);

  // One undo step for the whole action, across both racks.
  await page.getByTitle("Undo (Ctrl+Z)").click();
  await expect(async () => {
    expect((await picked(page)).filter((r) => r.at)).toHaveLength(0);
  }).toPass({ timeout: 15_000 });
});

test("#150: across several selected racks, a slide the single-slide rule refuses is left untouched and listed, and the rest across both racks are marked", async ({
  page,
}) => {
  await boot(page);
  // Each of the two racks gets a 2-slide and a 1-slide cut group (as the single-rack refusal
  // test above does for its one rack), so reverting only the smallest group leaves that rack
  // with a MIX — 2 fine slides plus 1 that cannot be imaged even alone — beside the other
  // rack's 3 untouched slides.
  await seedRackAtImaging(page, [2, 1], 2);
  // Same plant as the single-rack refusal test above: put one cut group back to waiting to be
  // cut, which is what the data layer refuses (#167), so one slide in one of the two selected
  // racks cannot take the step even alone.
  const [{ slide_code: refusedCode, section_request_id }] = (await select(
    page,
    `SELECT slide_code, section_request_id FROM slides WHERE purpose = 'stain' ORDER BY id DESC LIMIT 1`,
  )) as Array<{ slide_code: string; section_request_id: number }>;
  await page.evaluate(
    (group) =>
      (window as unknown as { __SHIM_SQL__: (s: string, p: unknown[]) => void }).__SHIM_SQL__(
        `UPDATE section_requests SET current_stage = 'needs_sectioning' WHERE id = ?`,
        [group],
      ),
    section_request_id,
  );
  await page.goto("/");
  await page.getByLabel("Signed-in user").selectOption({ label: USER });
  await selectImagingRacks(page, ["EE-1", "EE-2"]);

  await drawer(page).getByRole("button", { name: /Mark \d+ Slides? Imaged/ }).click();

  const notice = drawer(page).getByRole("status");
  await expect(notice).toContainText("Marked 5 slides as imaged");
  await expect(notice).toContainText("1 refused and left untouched");
  await expect(notice).toContainText("still waiting to be cut");

  const rows = (await picked(page)) as Array<{ slide_code: string; at: string | null }>;
  expect(rows.find((r) => r.slide_code === refusedCode)?.at ?? null, "the refused slide is untouched").toBeNull();
  expect(rows.filter((r) => r.at)).toHaveLength(5);

  // Asking again changes nothing and says why, as an error — the refused slide stays refused.
  await drawer(page).getByRole("button", { name: "Mark 1 Slide Imaged" }).click();
  await expect(drawer(page)).toContainText("1 refused and left untouched");
  expect((await picked(page)).filter((r) => r.at)).toHaveLength(5);
});
