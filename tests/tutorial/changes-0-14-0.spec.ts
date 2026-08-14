import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";

/**
 * Screenshots of what 0.14.0 changed (#121–#128). Not part of CI:
 *   npx playwright test --config playwright.showcase.config.ts changes-0-14-0
 *
 * One shot per issue, framed on the thing that moved rather than the whole
 * window, so the difference is the subject rather than something to hunt for.
 */

const IMG = "docs/changes/0.14.0";
const USER = "Alex Rivera";

async function shot(page: Page, name: string, locator?: ReturnType<Page["locator"]>) {
  await page.waitForTimeout(300);
  if (locator) await locator.screenshot({ path: `${IMG}/${name}.png` });
  else await page.screenshot({ path: `${IMG}/${name}.png` });
}

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

async function seed(page: Page, count: number): Promise<void> {
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
      "in_fixative", "fixative_removed", "in_ethanol", "processing_started",
      "processed", "picked_up", "needs_embedding", "embedded",
    ];
    const descriptions = [
      "2 week stretch PLA", "4 week static PLA", "8 week stretch PCL",
      "control, unloaded", "12 week stretch PLA",
    ];
    for (let i = 0; i < n; i += 1) {
      const id = (await db.addSample(
        {
          project_id: projectId,
          sample_description: descriptions[i % descriptions.length],
          processing_type: i % 2 ? "Long" : "Short",
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
        { duplicates: 2, stains: "" },
      ])) as number[];
      await db.updateSectionStage(sections[0], "stain_requested");
    }
  }, count);
  await page.goto("/");
  await expect(page.getByLabel("Signed-in user")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Signed-in user").selectOption({ label: USER });
  await page.waitForTimeout(400);
}

const staining = (page: Page) =>
  page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Staining / IHC", exact: true }) })
    .last();

const drawer = (page: Page) =>
  page.locator("div.border-l").filter({ has: page.getByText("Assay slides") }).last();

test("0.14.0 — the changes", async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);

  // ---- #123: the new rack settings ---------------------------------------
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByRole("heading", { name: "Racks" })).toBeVisible();
  await shot(page, "123-rack-settings", settings);

  // Two per rack, so a screenshot can show the ceiling doing something.
  await settings.getByLabel("Slides per staining rack").fill("2");
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(settings.getByText("Saved.")).toBeVisible();
  await page.keyboard.press("Escape");

  await seed(page, 5);

  // ---- #123: five slides, three racks -------------------------------------
  await expect(async () => {
    expect(await staining(page).locator("[aria-selected]").count()).toBe(3);
  }).toPass({ timeout: 15_000 });
  await shot(page, "123-racks-fill-and-open", staining(page));

  // ---- #122 + #124 + #126: the rack panel ---------------------------------
  await staining(page).locator("[aria-selected]").first().click();
  await expect(page.getByText("Assay slides").first()).toBeVisible();
  await shot(page, "122-checklist-above-slides", drawer(page));

  await page.getByRole("button", { name: "Select slides to remove" }).click();
  await drawer(page).locator('input[type="checkbox"][aria-label^="Select EE-"]').first().check();
  await shot(page, "124-126-split-and-bulk-move", drawer(page));

  // ---- #124: the merge control -------------------------------------------
  await drawer(page).locator("button:has(svg.lucide-x)").first().click();
  await expect(drawer(page)).toHaveCount(0);
  const cards = staining(page).locator("[aria-selected]");
  await cards.nth(0).click();
  await cards.nth(1).click({ modifiers: ["Control"] });
  await expect(page.getByRole("button", { name: /Merge 2/ })).toBeVisible();
  await shot(page, "124-merge-button", drawer(page));

  // ---- #125: a stain requested on a block already queued for cutting ------
  const sectioning = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Needs Sectioning", exact: true }) })
    .last();
  // Read the queued cut BEFORE leaving the board — the column is not rendered
  // while the Logs are open.
  const before = (await sectioning.locator("[aria-selected]").first().innerText()).trim();

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await expect(page.getByPlaceholder(/Search code/)).toBeVisible();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();
  await page.waitForTimeout(400);

  // ---- #121: the slide panel, with no refile control ----------------------
  // Absence is a weak thing to photograph, so this frames WHERE it used to be:
  // open a slide in the Logs drill-down — the panel that carried "Wrong block?
  // Refile this slide…" — and assert it is gone before the shutter.
  await page.getByRole("button", { name: /^EE-1-A/ }).first().click();
  await page.waitForTimeout(300);
  await expect(page.getByText(/Wrong block/)).toHaveCount(0);
  await shot(page, "121-logs-no-refile", page.locator("tbody").first());

  // EE-1 still has an uncut group in the queue, so asking for another agent
  // here is exactly the case #125 is about.
  await page.getByRole("combobox", { name: /Add a stain/i }).first().selectOption("stain::PAS");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(page.getByText(/added to the cut already waiting/)).toBeVisible();
  await shot(page, "125-joins-the-waiting-cut", page.locator("tbody").first());

  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  await expect(async () => {
    const after = (await sectioning.locator("[aria-selected]").first().innerText()).trim();
    expect(after).not.toBe(before);
  }).toPass({ timeout: 10_000 });
  await shot(page, "125-cut-already-queued", sectioning);

  // ---- #127 + #128: signed out --------------------------------------------
  await page.getByLabel("Signed-in user").selectOption("");
  const keepReading = page.getByRole("button", { name: "Keep reading" });
  await expect(keepReading).toBeVisible();
  await shot(page, "128-sign-in-prompt");
  await keepReading.click();
  await expect(keepReading).toHaveCount(0);

  await expect(page.getByRole("button", { name: "New Sample" })).toBeDisabled();
  await shot(page, "128-signed-out-board");

  // The checklist, greyed, with the message that names the fix.
  const embedded = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Embedded Inventory", exact: true }) })
    .last();
  await embedded.locator("[aria-selected]").first().click();
  await expect(page.getByText("Sign in before making modifications.").first()).toBeVisible();
  await shot(
    page,
    "127-checklist-signed-out",
    page.locator("div.border-l").filter({ has: page.getByText("Sign in before making") }).last(),
  );
});
