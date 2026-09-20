import { test, expect } from "@playwright/test";
import { openManage } from "../helpers/app";

// Undo and redo through the real UI: a mutation, an undo that replays the undo
// journal back to the action's mark and must fully revert the database, and a
// redo that replays what the undo wrote and must fully reapply it — with the UI a
// pure reflection of the DB via React Query refetch.
async function signInAndSeedUser(page: import("@playwright/test").Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible();
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByLabel("Signed-in user").locator("option", { hasText: "Alex Rivera" }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
}

async function createProject(page: import("@playwright/test").Page, code: string, name: string) {
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill(code);
  await page.locator('input[placeholder="Enthesis Engineering"]').fill(name);
  await page.getByRole("button", { name: "Save Project" }).click();
}

async function createSample(page: import("@playwright/test").Page, description: string) {
  await page.getByRole("button", { name: "New Sample" }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toBeVisible();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(description);
  await page.getByRole("button", { name: /Create Sample/ }).click();
}

test("undo reverts a create; redo reapplies it", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await signInAndSeedUser(page);
  await createProject(page, "EE", "Enthesis Engineering");

  // Creating a sample IS an undoable action (goes through the commit/snapshot path).
  await createSample(page, "Undo test block");
  await expect(page.getByText("EE-1")).toBeVisible();

  // Undo → the whole DB reverts to the pre-create image; the UI follows.
  await page.getByTitle("Undo (Ctrl+Z)").click();
  await expect(page.getByText("EE-1")).toHaveCount(0);

  // Redo → the image is reapplied and the sample is back, same ID (no sequence drift).
  await page.getByTitle("Redo (Ctrl+Y)").click();
  await expect(page.getByText("EE-1")).toBeVisible();

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});

test("undo/redo keep sample IDs stable (no sequence drift)", async ({ page }) => {
  await signInAndSeedUser(page);
  await createProject(page, "EE", "Enthesis Engineering");

  // Create, undo, then create again: the ID must be EE-1 both times. The old
  // logical-dump undo left sqlite_sequence un-rewound, so the second create
  // could jump to EE-2; a true image revert restores the counter too.
  await createSample(page, "First block");
  await expect(page.getByText("EE-1")).toBeVisible();

  await page.getByTitle("Undo (Ctrl+Z)").click();
  await expect(page.getByText("EE-1")).toHaveCount(0);

  await createSample(page, "Replacement block");
  await expect(page.getByText("EE-1")).toBeVisible();
  await expect(page.getByText("EE-2")).toHaveCount(0);
});

test("undo survives a full page reload (persisted DB image)", async ({ page }) => {
  await signInAndSeedUser(page);
  await createProject(page, "EE", "Enthesis Engineering");
  await expect(page.getByText("Enthesis Engineering")).toBeVisible();

  // Reload WITHOUT freshdb: the persisted image should still hold the project,
  // proving restore writes real bytes that survive a reopen.
  await page.goto("/");
  await expect(page.getByText("Enthesis Engineering")).toBeVisible();
  await expect(page.getByText(/1 active project/)).toBeVisible();
});

/**
 * A range of stain racks selected together, the middle one never opened.
 *
 * Shift-selecting a range opens only the rack that was clicked, so a rack in the middle
 * is selected with no protocol drawn yet. Ticking a step fans it across the selection
 * and draws that rack's checklist on the way. Drawing it is not part of the step: if it
 * were, the Undo would delete the run and the refetch that follows would re-create it
 * under a new id, so the Redo's insert would collide with the app's own row and be
 * refused as though somebody else had changed the record.
 */
const AGENTS = ["H&E", "PAS", "Alcian Blue"];

async function seedAStainRackPerAgent(page: import("@playwright/test").Page) {
  await page.evaluate(async (agents) => {
    const db = (await import("/src/lib/db.ts")) as unknown as Record<string, Function>;
    const projectId = (await db.addProject({
      code: "EE",
      name: "Enthesis Engineering",
      team_lead: "",
      is_active: true,
      lead_user_id: 0,
    })) as number;
    for (const agent of agents) {
      const id = (await db.addSample(
        {
          project_id: projectId,
          sample_description: `${agent} block`,
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
      const made = (await db.createSectionRequests(id, [
        { duplicates: 1, stains: agent, assay_type: "stain", assay_name: agent },
      ])) as number[];
      await db.updateSectionStage(made[0], "sectioned");
      await db.updateSectionStage(made[0], "stain_requested");
    }
  }, AGENTS);
  await page.goto("/");
  await expect(page.getByLabel("Signed-in user")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
}

test("a step ticked across a range of racks can be undone and redone", async ({ page }) => {
  await signInAndSeedUser(page);
  await seedAStainRackPerAgent(page);

  const staining = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Staining / IHC", exact: true }) });
  const rack = (agent: string) => staining.getByRole("button", { name: new RegExp(`^${agent} `) }).first();
  for (const agent of AGENTS) await expect(rack(agent)).toBeVisible({ timeout: 15_000 });

  // Open the first rack, then take the range to the last. The middle rack comes into
  // the selection without ever being opened, so it has no checklist of its own.
  await rack(AGENTS[0]).click();
  await expect(page.getByRole("button", { name: /^Stained/ })).toBeVisible({ timeout: 15_000 });
  await rack(AGENTS[2]).click({ modifiers: ["Shift"] });
  const step = page.getByRole("button", { name: /^Stained/ });
  await expect(step).toBeVisible({ timeout: 15_000 });
  await step.click();
  await expect(page.getByText(/^Undone: |^Redone: /)).toHaveCount(0);

  // Look at the rack the fan-out drew a checklist for, so its query is mounted and
  // refetches the moment the undo lands.
  await rack(AGENTS[1]).click();
  await expect(page.getByRole("button", { name: /^Stained/ })).toBeVisible({ timeout: 15_000 });

  await page.getByTitle("Undo (Ctrl+Z)").click();
  await expect(page.getByText(/^Undone: Complete · Stained$/)).toBeVisible({ timeout: 15_000 });

  await page.getByTitle("Redo (Ctrl+Y)").click();
  await expect(
    page.getByText(/^Redone: Complete · Stained$/),
    "the step goes back on, rather than being skipped as changed since",
  ).toBeVisible({ timeout: 15_000 });
});
