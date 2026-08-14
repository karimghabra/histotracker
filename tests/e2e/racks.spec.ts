import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";

/**
 * Racks as physical objects: a fixed capacity (#123), split and merge (#124),
 * and moving a whole selection at once (#126).
 *
 * All three come from the same complaint — the app treated "the H&E rack" as an
 * unbounded bucket, so what the board showed and what a technician could pick up
 * and carry drifted apart the moment a busy morning produced more than one
 * rack's worth of glass.
 *
 * The board is built through `db.ts` rather than by clicking a dozen blocks all
 * the way to staining: the thing under test is the rack controls, and spending
 * the wall clock on setup would mean testing fewer of them. Everything after the
 * seed is driven the way a user drives it.
 */

const USER = "Alex Rivera";

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
  // Signing in FIRST, because since #128 nothing below it would be allowed to
  // write anything.
  await page.getByLabel("Signed-in user").selectOption({ label: USER });
}

/** N blocks, each cut for one H&E slide and sent into staining. */
async function seedStainedBlocks(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    const db = (await import("/src/lib/db.ts")) as unknown as Record<string, Function>;
    // Reuse the project if this is a second call — a repeat addProject would
    // die on the UNIQUE project code, which says nothing about racks.
    const existing = (
      (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }).__SHIM_SELECT__(
        `SELECT id FROM projects WHERE code = 'EE'`,
      ) as Array<{ id: number }>
    )[0];
    const projectId =
      existing?.id ??
      ((await db.addProject({
        code: "EE",
        name: "Enthesis Engineering",
        team_lead: "",
        is_active: true,
        lead_user_id: 0,
      })) as number);
    const stages = [
      "in_fixative", "fixative_removed", "in_ethanol", "processing_started",
      "processed", "picked_up", "needs_embedding", "embedded",
    ];
    for (let i = 0; i < n; i += 1) {
      const id = (await db.addSample(
        {
          project_id: projectId,
          sample_description: `rack block ${i + 1}`,
          processing_type: "Short",
          fixative_agent: "Z-Fix",
          needs_decalcification: 0,
          cut_notes: "",
          slide_notes: "",
          stains: "",
          preselected_stains: [],
          overall_notes: "",
        },
        "EE",
      )) as number;
      for (const stage of stages) await db.updateSampleStage(id, stage);
      const sections = (await db.createSectionRequests(id, [
        { duplicates: 1, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
      ])) as number[];
      await db.updateSectionStage(sections[0], "stain_requested");
    }
  }, count);
  // The seed went straight to the data layer, so nothing invalidated React
  // Query — reload rather than assert against a cache filled before the seed.
  await page.goto("/");
  await expect(page.getByLabel("Signed-in user")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Signed-in user").selectOption({ label: USER });
}

/** The rack panel. Scoped, because the board cards carry "Select EE-1" too. */
const drawer = (page: Page) =>
  page.locator("div.border-l").filter({ has: page.getByText("Assay slides") }).last();

const staining = (page: Page) =>
  page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Staining / IHC", exact: true }) })
    .last();

async function rackCount(page: Page): Promise<number> {
  return staining(page).locator("[aria-selected]").count();
}

test("#123: a rack fills to its configured capacity and then a second one opens", async ({
  page,
}) => {
  await boot(page);

  // Two slides per rack, so the ceiling is reached without seeding two dozen.
  await openManage(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Slides per staining rack").fill("2");
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(settings.getByText("Saved.")).toBeVisible();
  await page.keyboard.press("Escape");

  await seedStainedBlocks(page, 5);

  // Five slides, two to a rack — three racks, not one rack of five.
  await expect(async () => {
    expect(await rackCount(page)).toBe(3);
  }).toPass({ timeout: 15_000 });
});

test("#124 + #126: a rack can be split, moved in bulk, and merged back", async ({ page }) => {
  await boot(page);
  await seedStainedBlocks(page, 3);

  // One rack holding all three to begin with.
  await expect(async () => {
    expect(await rackCount(page)).toBe(1);
  }).toPass({ timeout: 15_000 });

  await staining(page).locator("[aria-selected]").first().click();
  await expect(page.getByText("Assay slides").first()).toBeVisible();

  // ---- split ---------------------------------------------------------------
  await page.getByRole("button", { name: "Select slides" }).click();
  const checkboxes = drawer(page).locator('input[type="checkbox"][aria-label^="Select EE-"]');
  await checkboxes.first().check();
  await page.getByRole("button", { name: /Split 1 slide into a new rack/ }).click();

  await expect(async () => {
    expect(await rackCount(page)).toBe(2);
  }).toPass({ timeout: 15_000 });

  // ---- merge ---------------------------------------------------------------
  // Close the panel first: the split leaves it open on the source rack, and
  // re-clicking the rack that is already open DE-selects it and shuts the panel
  // (#61) — so selecting "both" would quietly end up selecting one.
  await drawer(page).locator("button:has(svg.lucide-x)").first().click();
  await expect(drawer(page)).toHaveCount(0);

  const cards = staining(page).locator("[aria-selected]");
  await cards.nth(0).click();
  await cards.nth(1).click({ modifiers: ["Control"] });
  await page.getByRole("button", { name: /Merge 2/ }).click();

  await expect(async () => {
    expect(await rackCount(page)).toBe(1);
  }).toPass({ timeout: 15_000 });

  // Nothing was destroyed on the way — all three slides are still there, in one
  // rack, which is the whole promise of a merge.
  const live = await page.evaluate(() =>
    (
      (
        window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }
      ).__SHIM_SELECT__(
        `SELECT COUNT(*) AS n FROM slides WHERE purpose = 'stain' AND current_stage <> 'removed'`,
      ) as Array<{ n: number }>
    )[0].n,
  );
  expect(live).toBe(3);
});

test("#126: a selection moves to another agent in one action", async ({ page }) => {
  await boot(page);
  await seedStainedBlocks(page, 3);

  await expect(async () => {
    expect(await rackCount(page)).toBe(1);
  }).toPass({ timeout: 15_000 });

  await staining(page).locator("[aria-selected]").first().click();
  await page.getByRole("button", { name: "Select slides" }).click();

  const checkboxes = drawer(page).locator('input[type="checkbox"][aria-label^="Select EE-"]');
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await page.getByLabel("Reassign the selected slides").selectOption("stain:Safranin O");

  // Two slides on Safranin O, one still on H&E — two racks, one action.
  await expect(async () => {
    const rows = (await page.evaluate(() =>
      (
        window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }
      ).__SHIM_SELECT__(
        `SELECT assay_name AS agent, COUNT(*) AS n FROM slides
          WHERE purpose = 'stain' AND current_stage <> 'removed'
          GROUP BY assay_name ORDER BY assay_name`,
      ),
    )) as Array<{ agent: string; n: number }>;
    expect(rows).toEqual([
      { agent: "H&E", n: 1 },
      { agent: "Safranin O", n: 2 },
    ]);
  }).toPass({ timeout: 15_000 });
});

test("racks are numbered per agent, and the number does not move", async ({ page }) => {
  await boot(page);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Slides per staining rack").fill("1");
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(settings.getByText("Saved.")).toBeVisible();
  await page.keyboard.press("Escape");

  // One slide per rack, so three blocks make H&E 1, 2 and 3.
  await seedStainedBlocks(page, 3);
  await expect(async () => {
    expect(await rackCount(page)).toBe(3);
  }).toPass({ timeout: 15_000 });

  // Read what the BOARD renders, not a second copy of the query.
  //
  // The first version of this computed the ordinal itself in SQL and compared
  // that against SQL — so it passed happily against a deliberately unstable
  // implementation, because both sides were the test. The numbers on the cards
  // are the only thing a technician sees, so they are the only thing worth
  // asserting.
  const shown = async (): Promise<string[]> =>
    (await staining(page).locator("[title$='for this agent']").allTextContents()).map((n) =>
      n.trim(),
    );

  expect(await shown()).toEqual(["1", "2", "3"]);

  // Retire the FIRST rack. This is the whole point of counting closed racks
  // too: if the number were "which of the open racks is this", rack 2 would
  // silently become rack 1 — and a technician who wrote "H&E 2" on the side of
  // a real rack in marker would now be holding something the app calls H&E 1.
  await page.evaluate(async () => {
    const db = (await import("/src/lib/db.ts")) as unknown as Record<string, Function>;
    await db.removeSlidesForStack(1, "finished");
    await db.closeSlideStackIfEmpty(1);
  });
  await page.goto("/");
  await page.getByLabel("Signed-in user").selectOption({ label: USER });
  await page.waitForTimeout(400);

  // The two survivors keep the numbers they had. Under open-only counting they
  // would renumber to 1 and 2 — which is the failure this test exists for.
  expect(await shown()).toEqual(["2", "3"]);

  // And a rack opened afterwards continues the sequence rather than reusing 1.
  await seedStainedBlocks(page, 1);
  await expect(async () => {
    expect(await shown()).toEqual(["2", "3", "4"]);
  }).toPass({ timeout: 15_000 });
});
