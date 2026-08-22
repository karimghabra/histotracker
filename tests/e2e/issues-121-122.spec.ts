import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";

/**
 * The two 0.14.0 issues that shipped with no automated coverage at all.
 *
 * Both are changes to what is on the screen and nothing else — one control
 * deleted (#121) and one block of markup moved (#122) — which is exactly the
 * kind of change that looks self-evidently done in a diff and quietly comes back
 * the next time somebody edits the file around it. Neither had a gate, a spec or
 * a unit test until this file; "I read the JSX" was the whole of the
 * verification, and that is not verification.
 *
 * Both tests below were revert-verified: each was watched failing with its
 * change undone, because a test for an ABSENCE that has never been seen to fail
 * is indistinguishable from a test that cannot fail.
 */

const USER = "Alex Rivera";

async function boot(page: Page): Promise<void> {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await openManage(page);
  await page.getByPlaceholder(USER).fill(USER);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Signed-in user").locator("option", { hasText: USER })).toHaveCount(1);
  await page.keyboard.press("Escape");
  const overlay = page.locator("div.fixed.inset-0.z-50");
  if (await overlay.count()) await overlay.first().click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
  // Signed in before anything is written — since #128 an unsigned session is a
  // viewer, so a seed run before this line would be refused, not merely slow.
  await page.getByLabel("Signed-in user").selectOption({ label: USER });
}

/**
 * N blocks, each cut for one H&E slide and pushed into staining, straight
 * through `db.ts`.
 *
 * The thing under test in both specs is a layout decision, so the wall clock is
 * better spent on the assertions than on dragging a dozen cards across the
 * board — those journeys are already covered by `workflow.spec.ts`.
 */
async function seedStainedBlocks(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    const db = (await import("/src/lib/db.ts")) as unknown as Record<string, Function>;
    const projectId = (await db.addProject({
      code: "EE",
      name: "Enthesis Engineering",
      team_lead: "",
      is_active: true,
      lead_user_id: 0,
    })) as number;
    const stages = [
      "in_fixative",
      "fixative_removed",
      "in_ethanol",
      "processing_started",
      "processed",
      "picked_up",
      "needs_embedding",
      "embedded",
    ];
    for (let i = 0; i < n; i += 1) {
      const id = (await db.addSample(
        {
          project_id: projectId,
          sample_description: `block ${i + 1}`,
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
  // The seed bypassed useActions, so nothing invalidated React Query. Reload
  // rather than assert against a cache filled before the seed existed.
  await page.goto("/");
  await expect(page.getByLabel("Signed-in user")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Signed-in user").selectOption({ label: USER });
}

test("#121: the Logs offer no way to refile a slide onto another block", async ({ page }) => {
  await boot(page);
  await seedStainedBlocks(page, 2);

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  const sampleCell = page.getByRole("cell", { name: "EE-1", exact: true });
  await expect(sampleCell).toBeVisible({ timeout: 15_000 });
  await sampleCell.click();
  await expect(page.getByText("Sample timeline")).toBeVisible();

  const slideRow = page.getByRole("button", { name: /EE-1-A/ });
  await expect(slideRow).toBeVisible();
  await slideRow.click();

  // The positive anchor, and it has to come first. Asserting that something is
  // ABSENT passes just as happily when the panel failed to render at all, so the
  // panel is proved open before anything is claimed about what it lacks.
  await expect(page.getByPlaceholder("Notes about this slide…")).toBeVisible();

  // Now the actual assertion. Four locators because the removed control was
  // several things — a block picker, a reason box, a Refile button and the
  // disclosure that opened them — and a partial restoration is as much a
  // regression as a whole one.
  await expect(page.getByLabel(/to another block/)).toHaveCount(0);
  await expect(page.getByLabel(/is being moved/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Refile/i })).toHaveCount(0);
  await expect(page.getByText(/Wrong block/i)).toHaveCount(0);

  // #121 removed the AFFORDANCE, not the capability: the lab still wants
  // mislabelled glass corrected, just by hand rather than by a one-click control
  // in the everyday log view. If anyone ever satisfies the assertions above by
  // deleting `relabelSlideToSample` itself, this fails and says which it was.
  const stillThere = await page.evaluate(async () => {
    const db = (await import("/src/lib/db.ts")) as unknown as Record<string, unknown>;
    return typeof db.relabelSlideToSample === "function";
  });
  expect(stillThere, "relabelSlideToSample is deliberately kept in db.ts").toBe(true);
});

test("#122: the stain checklist sits above the slide list, not below it", async ({ page }) => {
  await boot(page);
  // Enough glass that the ordering is a real scrolling question rather than a
  // two-row curiosity — which is the complaint the issue actually makes.
  await seedStainedBlocks(page, 8);

  const staining = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Staining / IHC", exact: true }) })
    .last();
  await expect(staining.locator("[aria-selected]").first()).toBeVisible({ timeout: 15_000 });
  await staining.locator("[aria-selected]").first().click();

  const drawer = page.locator("div.border-l").filter({ has: page.getByText("Assay slides") }).last();
  await expect(drawer).toBeVisible();

  // Both anchors present before any claim about their order.
  const checklist = drawer.getByRole("heading", { name: "Stain workflow" });
  await expect(checklist).toBeVisible();
  // The slide CODES, not the selection checkboxes: those only exist once you
  // have clicked "Select slides", and #122 is about what the panel looks like
  // when you open it, before entering any mode.
  const slideRows = drawer.locator("span.block.truncate.text-xs.font-semibold");
  await expect(slideRows).toHaveCount(8);

  const checklistBox = await checklist.boundingBox();
  expect(checklistBox, "the checklist heading has no box to compare").toBeTruthy();

  // Above EVERY row, not merely above the first: a checklist that had drifted
  // into the middle of the list would still clear a first-row-only check.
  for (let i = 0; i < 8; i += 1) {
    const rowBox = await slideRows.nth(i).boundingBox();
    expect(rowBox, `slide row ${i} has no box`).toBeTruthy();
    expect(
      checklistBox!.y,
      `the checklist must sit above slide row ${i} — that is the whole of #122`,
    ).toBeLessThan(rowBox!.y);
  }

  // And the steps themselves are reachable without scrolling past the glass,
  // which is what "move it to the top" was actually asking for.
  const firstStep = drawer.getByRole("button", { name: /Stained/ }).first();
  await expect(firstStep).toBeVisible();
  const stepBox = await firstStep.boundingBox();
  const firstRowBox = await slideRows.first().boundingBox();
  expect(stepBox!.y).toBeLessThan(firstRowBox!.y);
});
