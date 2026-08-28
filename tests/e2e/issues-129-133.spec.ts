import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";

/**
 * The four issues raised against 0.14.x.
 *
 * #132 and #131 are one change seen from two sides: the sidebar selection used
 * to mean two unrelated things at once — which project you are looking at, and
 * where new samples get filed — and neither was stated on screen. #132 takes the
 * filing decision out of it and asks; #131 makes what remains mean one thing.
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
  await page.getByLabel("Signed-in user").selectOption({ label: USER });
}

async function addProject(page: Page, code: string, name: string): Promise<void> {
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill(code);
  await page.locator('input[placeholder="Enthesis Engineering"]').fill(name);
  await page.getByRole("button", { name: "Save Project" }).click();
  await expect(page.getByRole("button", { name: "Save Project" })).toHaveCount(0);
}

test("#132: the New Sample dialog asks which project, and will not proceed without one", async ({
  page,
}) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addProject(page, "TT", "Tendon Testing");

  // Straight to New Sample. Nothing is selected in the sidebar on purpose —
  // before #132 this button was disabled until something was, which is the
  // coupling the issue is about.
  await page.getByRole("button", { name: "New Sample" }).click();

  const picker = page.getByLabel("Project for these samples");
  await expect(picker).toBeVisible();

  // Nothing preselected while there is a real choice, and the batch cannot be
  // created until the question is answered.
  await expect(picker).toHaveValue("");
  const create = page.getByRole("button", { name: /Create Sample/ });
  await expect(create).toBeDisabled();

  // Answering it fills in the ID preview, which is how you can see WHICH
  // project you picked without reading the dropdown back.
  await picker.selectOption({ label: "TT · Tendon Testing" });
  await expect(page.getByRole("textbox", { name: "Next Sample ID" })).toHaveValue(/^TT-/);

  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("filed by the dialog");
  await expect(create).toBeEnabled();
  await create.click();

  // It landed under the project the dialog asked for — not under EE, which is
  // what the sidebar would have supplied.
  const filed = await page.evaluate(() =>
    (
      (
        window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }
      ).__SHIM_SELECT__(
        `SELECT s.sample_code AS code, p.code AS project
           FROM samples s JOIN projects p ON p.id = s.project_id`,
      ) as Array<{ code: string; project: string }>
    )[0],
  );
  expect(filed.project).toBe("TT");
  expect(filed.code).toMatch(/^TT-/);
});

test("#132: a single-project lab is not asked a question with one answer", async ({ page }) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");

  await page.getByRole("button", { name: "New Sample" }).click();

  // The picker is still there — it says where the sample is going, which the
  // title bar used to say and nothing else did — but with nothing to choose
  // between, it is answered.
  const picker = page.getByLabel("Project for these samples");
  await expect(picker).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Next Sample ID" })).toHaveValue(/^EE-/);
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("only project");
  await expect(page.getByRole("button", { name: /Create Sample/ })).toBeEnabled();
});

test("#131: the sidebar selection filters the whole dashboard, and All Projects clears it", async ({
  page,
}) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addProject(page, "TT", "Tendon Testing");

  // One block in each project, both sitting in Pre-processing.
  for (const [project, label] of [
    ["EE · Enthesis Engineering", "ee block"],
    ["TT · Tendon Testing", "tt block"],
  ] as const) {
    await page.getByRole("button", { name: "New Sample" }).click();
    await page.getByLabel("Project for these samples").selectOption({ label: project });
    await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(label);
    await page.getByRole("button", { name: /Create Sample/ }).click();
    await expect(page.getByRole("button", { name: /Create Sample/ })).toHaveCount(0);
  }

  const preprocessing = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Pre-processing", exact: true }) })
    .last();

  // Both blocks are on the board to begin with, whichever project is selected —
  // the point being that the count below changes because of the SELECTION and
  // not because a block is missing.
  await page.getByRole("button", { name: "All projects" }).click();
  await expect(preprocessing.getByText("EE-1", { exact: true })).toBeVisible();
  await expect(preprocessing.getByText("TT-1", { exact: true })).toBeVisible();

  // Select EE in the sidebar: the column filters to it. Nothing was touched on
  // the column itself, which is the whole of #131.
  await page.getByRole("button", { name: /Enthesis Engineering/ }).first().click();
  await expect(preprocessing.getByText("EE-1", { exact: true })).toBeVisible();
  await expect(preprocessing.getByText("TT-1", { exact: true })).toHaveCount(0);

  // The column's own dropdown agrees — the selection SET it rather than
  // shadowing it, so what the control says is what the board is doing.
  const columnFilter = preprocessing.locator("select").first();
  await expect(columnFilter).not.toHaveValue("all");

  // Switching projects follows.
  await page.getByRole("button", { name: /Tendon Testing/ }).first().click();
  await expect(preprocessing.getByText("TT-1", { exact: true })).toBeVisible();
  await expect(preprocessing.getByText("EE-1", { exact: true })).toHaveCount(0);

  // And All Projects puts everything back.
  await page.getByRole("button", { name: "All projects" }).click();
  await expect(preprocessing.getByText("EE-1", { exact: true })).toBeVisible();
  await expect(preprocessing.getByText("TT-1", { exact: true })).toBeVisible();
  await expect(columnFilter).toHaveValue("all");

  // The OTHER kind of column.
  //
  // The six filters are not one kind of thing: four match `project_id`, and
  // Extras and Ready for Imaging match `project_code`. The first version of this
  // test only looked at a project_id column, so it passed while both code
  // columns were handed a numeric id no code can equal and rendered empty for
  // every selection. The sync specs caught that; this did not. So it checks one
  // of each now, through cards on screen rather than through the control.
  await page.evaluate(async () => {
    const db = (await import("/src/lib/db.ts")) as unknown as Record<string, Function>;
    const projects = (
      (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }).__SHIM_SELECT__(
        `SELECT id, code FROM projects ORDER BY id`,
      ) as Array<{ id: number; code: string }>
    );
    const stages = [
      "in_fixative", "fixative_removed", "in_ethanol", "processing_started",
      "processed", "picked_up", "needs_embedding", "embedded",
    ];
    for (const project of projects) {
      const id = (await db.addSample(
        {
          project_id: project.id, sample_description: `${project.code} extras`,
          processing_type: "Short", fixative_agent: "Z-Fix", needs_decalcification: 0,
          cut_notes: "", slide_notes: "", stains: "", preselected_stains: [], overall_notes: "",
        },
        project.code,
      )) as number;
      for (const stage of stages) await db.updateSampleStage(id, stage);
      const sections = (await db.createSectionRequests(id, [{ duplicates: 2, stains: "" }])) as number[];
      // Past the queue, so the extras are real glass and reach the inventory.
      await db.updateSectionStage(sections[0], "stain_requested");
    }
  });
  await page.goto("/");
  await expect(page.getByLabel("Signed-in user")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Signed-in user").selectOption({ label: USER });

  const extras = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Extras", exact: true }) })
    .last();

  await page.getByRole("button", { name: "All projects" }).click();
  await expect(extras.getByText("EE-2", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(extras.getByText("TT-2", { exact: true }).first()).toBeVisible();

  // Selecting EE must narrow a code-matched column exactly as it narrows an
  // id-matched one. Handed an id, this column showed nothing at all.
  await page.getByRole("button", { name: /Enthesis Engineering/ }).first().click();
  await expect(extras.getByText("EE-2", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(extras.getByText("TT-2", { exact: true })).toHaveCount(0);
});

test("#131: a stage with none of the selected project's work shows NOTHING", async ({ page }) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addProject(page, "TT", "Tendon Testing");

  // TT has a block in Pre-processing. EE has none anywhere.
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByLabel("Project for these samples").selectOption({ label: "TT · Tendon Testing" });
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("tt block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByRole("button", { name: /Create Sample/ })).toHaveCount(0);

  const preprocessing = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Pre-processing", exact: true }) })
    .last();
  await expect(preprocessing.getByText("TT-1", { exact: true })).toBeVisible({ timeout: 15_000 });

  // Select EE, which has nothing at all. The column must go EMPTY.
  //
  // It used to fall back to every project: each column offered only the projects
  // it held, and a guard dropped the filter to "all" the moment the selection
  // fell off that list — so asking for one project's work showed you everyone
  // else's. The selected project stays on the menu now, and an empty column is
  // allowed to be empty.
  await page.getByRole("button", { name: /Enthesis Engineering/ }).first().click();
  await expect(preprocessing.getByText("TT-1", { exact: true })).toHaveCount(0);

  // And the control still says EE rather than silently reading "All Projects" —
  // which is the #85 hazard the old guard existed to dodge, closed here by
  // keeping the option rather than by clearing the filter.
  const columnFilter = preprocessing.locator("select").first();
  await expect(columnFilter).not.toHaveValue("all");
  const label = await columnFilter.locator("option:checked").innerText();
  expect(label).toContain("EE");
});

test("#131: All Projects survives a reload", async ({ page }) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");

  // Restoring used to fall back to the first project whenever the stored
  // selection was absent, and "no project" had no way to be stored at all — so
  // choosing All Projects and reloading snapped back to a filtered board.
  await page.getByRole("button", { name: "All projects" }).click();
  await expect(page.getByRole("button", { name: "All projects" })).toHaveAttribute(
    "aria-current",
    "true",
  );

  // Navigate to "/" rather than reload(): boot() lands on "?freshdb=1", and
  // reloading that would wipe the database and take the projects with it — the
  // sidebar would then be empty for reasons that have nothing to do with #131.
  await page.goto("/");
  await expect(page.getByRole("button", { name: "All projects" })).toHaveAttribute(
    "aria-current",
    "true",
    { timeout: 20_000 },
  );
});

/** Three embedded blocks; the middle one owes somebody a cut. */
async function seedEmbedded(page: Page): Promise<void> {
  await page.evaluate(async () => {
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
    const ids: number[] = [];
    for (let i = 0; i < 3; i += 1) {
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
      ids.push(id);
    }
    // The MIDDLE block, deliberately: first or last would pass a sort that did
    // nothing but preserve or reverse the seed order.
    await db.requestStainForSample({ sampleId: ids[1], assayType: "stain", assayName: "H&E" });
  });
  await page.goto("/");
  await expect(page.getByLabel("Signed-in user")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Signed-in user").selectOption({ label: USER });
}

test("#129: Embedded Inventory sorts by what needs cutting", async ({ page }) => {
  await boot(page);
  await seedEmbedded(page);

  const embedded = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: "Embedded Inventory", exact: true }) })
    .last();
  const codes = async () =>
    (await embedded.locator("[aria-selected]").allInnerTexts()).map((t) => t.split(String.fromCharCode(10))[0].trim());

  // The flag is on screen, and the sort must agree with THIS — which is why they
  // share one predicate rather than each having their own.
  await expect(embedded.getByText("⚑ needs cut")).toHaveCount(1);
  await expect(async () => {
    expect((await codes()).length).toBe(3);
  }).toPass({ timeout: 15_000 });

  // Sorting brings the flagged block to the top WITHOUT hiding the other two.
  // That is the whole of the follow-up on this issue: a block that owes a cut is
  // a priority, not a category, and the drawer stays whole.
  await embedded.getByLabel("Sort embedded inventory").selectOption("needs_cut");
  await expect(async () => {
    const shown = await codes();
    expect(shown.length).toBe(3);
    expect(shown[0]).toContain("EE-2");
  }).toPass({ timeout: 15_000 });

  // And there is no filter beside it — 0.15.0 shipped one and it was the wrong
  // shape. Asserted so it cannot come back by habit.
  await expect(embedded.getByLabel("Filter embedded inventory by cutting status")).toHaveCount(0);
});

test("#133: slides can be reassigned and removed from the Logs", async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const db = (await import("/src/lib/db.ts")) as unknown as Record<string, Function>;
    const projectId = (await db.addProject({
      code: "EE", name: "Enthesis Engineering", team_lead: "", is_active: true, lead_user_id: 0,
    })) as number;
    const stages = [
      "in_fixative", "fixative_removed", "in_ethanol", "processing_started",
      "processed", "picked_up", "needs_embedding", "embedded",
    ];
    const id = (await db.addSample(
      {
        project_id: projectId, sample_description: "logs actions", processing_type: "Short",
        fixative_agent: "Z-Fix", needs_decalcification: 0, cut_notes: "", slide_notes: "",
        stains: "", preselected_stains: [], overall_notes: "",
      },
      "EE",
    )) as number;
    for (const stage of stages) await db.updateSampleStage(id, stage);
    const sections = (await db.createSectionRequests(id, [
      { duplicates: 2, stains: "H&E", assay_type: "stain", assay_name: "H&E" },
    ])) as number[];
    // Past the queue, so the glass exists and can actually be worked on (#95).
    await db.updateSectionStage(sections[0], "stain_requested");
  });
  await page.goto("/");
  await expect(page.getByLabel("Signed-in user")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Signed-in user").selectOption({ label: USER });

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  const sampleCell = page.getByRole("cell", { name: "EE-1", exact: true });
  await expect(sampleCell).toBeVisible({ timeout: 15_000 });
  await sampleCell.click();
  await expect(page.getByText("Sample timeline")).toBeVisible();

  // ---- reassign, from the Logs -------------------------------------------
  await page.getByLabel("Select slide EE-1-A").check();
  await expect(page.getByText(/1 slide selected/)).toBeVisible();
  await page.getByLabel("Reassign the selected slides").selectOption("stain:PAS");

  await expect(async () => {
    const agents = (await page.evaluate(() =>
      (
        (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }).__SHIM_SELECT__(
          `SELECT slide_code AS code, assay_name AS agent FROM slides
            WHERE purpose = 'stain' ORDER BY slide_code`,
        )
      ) as Array<{ code: string; agent: string }>,
    )) ;
    expect(agents.find((a) => a.code.endsWith("-A"))?.agent).toBe("PAS");
  }).toPass({ timeout: 15_000 });

  // ---- remove, from the Logs, with a reason -------------------------------
  await page.getByLabel("Select slide EE-1-B").check();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("textbox", { name: /reason/i }).fill("dropped at the bench");
  await page.getByRole("button", { name: /Remove 1 slide/ }).click();

  // Removed, not deleted — the row survives with its reason attached (#83).
  await expect(async () => {
    const row = (await page.evaluate(() =>
      (
        (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }).__SHIM_SELECT__(
          `SELECT current_stage AS stage FROM slides WHERE slide_code LIKE '%-B'`,
        )
      ) as Array<{ stage: string }>,
    ))[0];
    expect(row.stage).toBe("removed");
  }).toPass({ timeout: 15_000 });

  // The reason lives in the slide's own panel, so it has to be opened — the
  // flag on the row is the affordance that opens it (#83).
  await page.getByLabel("Show removed").check();
  const removedRow = page.getByRole("button", { name: /EE-1-B/ });
  await expect(removedRow).toBeVisible();
  await removedRow.click();
  await expect(page.getByText("dropped at the bench")).toBeVisible();
});

test("#134: blocks switch between the Short and Long runs, in bulk, before the processor", async ({
  page,
}) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");

  // Three blocks on the Short run, sitting in Pre-processing.
  for (const label of ["one", "two", "three"]) {
    await page.getByRole("button", { name: "New Sample" }).click();
    await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(label);
    await page.getByRole("button", { name: /Create Sample/ }).click();
    await expect(page.getByRole("button", { name: /Create Sample/ })).toHaveCount(0);
  }

  // Select two of them and move both to Long in one action — the "in batches"
  // half of the issue.
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByText("EE-2", { exact: true }).first().click({ modifiers: ["Control"] });
  await page.getByRole("button", { name: "Switch to the Long run" }).click();

  await expect(async () => {
    const rows = (await page.evaluate(() =>
      (
        (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }).__SHIM_SELECT__(
          `SELECT sample_code AS code, processing_type AS run FROM samples ORDER BY sample_code`,
        )
      ) as Array<{ code: string; run: string }>,
    )) as Array<{ code: string; run: string }>;
    expect(rows.map((r) => `${r.code.replace(/-0*/, "-")}:${r.run}`)).toEqual([
      "EE-1:Long",
      "EE-2:Long",
      "EE-3:Short",
    ]);
  }).toPass({ timeout: 15_000 });

  // The switch is on the record, naming both ends — a block that was processed
  // Short and now reads Long, with nothing saying when it changed, is the silent
  // rewrite #83 forbids.
  const events = (await page.evaluate(() =>
    (
      (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }).__SHIM_SELECT__(
        `SELECT summary FROM sample_timeline_events WHERE event_type = 'processing_type'`,
      )
    ) as Array<{ summary: string }>,
  )) as Array<{ summary: string }>;
  expect(events).toHaveLength(2);
  expect(events[0].summary).toContain("from Short to Long");
});

test("#134: a block past the processor is not offered the switch", async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const db = (await import("/src/lib/db.ts")) as unknown as Record<string, Function>;
    const projectId = (await db.addProject({
      code: "EE", name: "Enthesis Engineering", team_lead: "", is_active: true, lead_user_id: 0,
    })) as number;
    const id = (await db.addSample(
      {
        project_id: projectId, sample_description: "embedded already", processing_type: "Short",
        fixative_agent: "Z-Fix", needs_decalcification: 0, cut_notes: "", slide_notes: "",
        stains: "", preselected_stains: [], overall_notes: "",
      },
      "EE",
    )) as number;
    for (const stage of [
      "in_fixative", "fixative_removed", "in_ethanol", "processing_started",
      "processed", "picked_up", "needs_embedding", "embedded",
    ]) await db.updateSampleStage(id, stage);
  });
  await page.goto("/");
  await expect(page.getByLabel("Signed-in user")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Signed-in user").selectOption({ label: USER });

  await page.getByText("EE-1", { exact: true }).first().click();
  // The drawer is open on a block that has been through the machine…
  await expect(page.getByRole("heading", { name: "EE-1" })).toBeVisible();
  // …and the control is not there at all. Its duration belongs to a run that has
  // already happened.
  await expect(page.getByRole("button", { name: "Switch to the Long run" })).toHaveCount(0);
});
