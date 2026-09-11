import { test, expect, type Page } from "@playwright/test";
import { openManage, openNewSample } from "../helpers/app";

/**
 * #77 — "Manifest should show who made what changes."
 *
 * Flagged as untested since 0.7.0 and, until this file, the oldest thing in the
 * app with no automated coverage of any kind. The feature works; what was
 * missing was anything that would notice if it stopped.
 *
 * The data-layer half — that the triggers attribute a change to whoever was
 * signed in, that an unsigned change records the ABSENCE rather than inventing
 * an attribution, and that the name is joined rather than copied — lives in
 * `scripts/workflow-test.mjs`, which loads the real migration SQL, so the
 * triggers there are the actual triggers. This file covers what only a browser
 * can: that the view reads it back correctly and that its filters mean
 * something.
 */

async function boot(page: Page, user: string): Promise<void> {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await addUser(page, user);
  await page.getByLabel("Signed-in user").selectOption({ label: user });
}

async function addUser(page: Page, name: string): Promise<void> {
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill(name);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Signed-in user").locator("option", { hasText: name })).toHaveCount(1);
  await page.keyboard.press("Escape");
  const overlay = page.locator("div.fixed.inset-0.z-50");
  if (await overlay.count()) await overlay.first().click({ position: { x: 5, y: 5 } });
  await expect(overlay).toHaveCount(0);
}

async function addProject(page: Page, code: string, name: string): Promise<void> {
  await page.getByTitle("Add project").click();
  await page.locator('input[placeholder="EE"]').fill(code);
  await page.locator('input[placeholder="Enthesis Engineering"]').fill(name);
  await page.getByRole("button", { name: "Save Project" }).click();
  await expect(page.getByRole("button", { name: "Save Project" })).toHaveCount(0);
}

async function addSample(page: Page, description: string, projectCode?: string): Promise<void> {
  await openNewSample(page, projectCode);
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(description);
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByRole("button", { name: /Create Sample/ })).toHaveCount(0);
}

// The Manifest button is NOT in <nav> with Board and Logs — #93 put it in the
// sidebar's bottom stack, beside the settings cog.
const openManifest = async (page: Page) =>
  page.locator("aside").first().getByRole("button", { name: "Manifest" }).click();

/** The manifest table's rows as [who, action, change]. */
async function manifestRows(page: Page): Promise<Array<[string, string, string]>> {
  const rows = page.locator("table tbody tr");
  const out: Array<[string, string, string]> = [];
  for (let i = 0; i < (await rows.count()); i += 1) {
    const cells = rows.nth(i).locator("td");
    if ((await cells.count()) < 5) continue; // the empty/loading placeholder row
    out.push([
      (await cells.nth(1).innerText()).trim(),
      (await cells.nth(2).innerText()).trim(),
      (await cells.nth(4).innerText()).trim(),
    ]);
  }
  return out;
}

test("#77: each change is attributed to the person who was signed in for it", async ({ page }) => {
  await boot(page, "Alex Rivera");
  await addProject(page, "EE", "Enthesis Engineering");
  await addSample(page, "alex block", "EE");

  // A second person takes over the workstation.
  await addUser(page, "Bo Chen");
  await page.getByLabel("Signed-in user").selectOption({ label: "Bo Chen" });
  await addSample(page, "bo block", "EE");

  await openManifest(page);
  await expect(page.getByRole("heading", { name: "Manifest" })).toBeVisible();

  const rows = await manifestRows(page);
  expect(rows.length, "the manifest has rows").toBeGreaterThan(0);

  // Attribution, which is the whole issue: each block reads under the person who
  // created it, not under whoever is signed in NOW and not under whoever was
  // first. Bo is signed in at this moment, so an implementation that read the
  // current user instead of the recorded one would put Bo on both.
  const alexRow = rows.find(([, , change]) => change.includes("EE-1"));
  const boRow = rows.find(([, , change]) => change.includes("EE-2"));
  expect(alexRow, "the first block is in the manifest").toBeTruthy();
  expect(boRow, "the second block is in the manifest").toBeTruthy();
  expect(alexRow![0]).toBe("Alex Rivera");
  expect(boRow![0]).toBe("Bo Chen");

  // Newest first — the manifest is a record you read from the top.
  const firstMention = (code: string) => rows.findIndex(([, , c]) => c.includes(code));
  expect(firstMention("EE-2")).toBeLessThan(firstMention("EE-1"));
});

test("#77: the manifest filters by person and by action", async ({ page }) => {
  await boot(page, "Alex Rivera");
  await addProject(page, "EE", "Enthesis Engineering");
  await addSample(page, "alex block", "EE");
  await addUser(page, "Bo Chen");
  await page.getByLabel("Signed-in user").selectOption({ label: "Bo Chen" });
  await addSample(page, "bo block", "EE");

  await openManifest(page);
  await page.getByLabel("Filter manifest by user").selectOption("Alex Rivera");
  await expect(async () => {
    const rows = await manifestRows(page);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(([who]) => who === "Alex Rivera"), "only Alex's changes").toBe(true);
    expect(rows.some(([, , c]) => c.includes("EE-2")), "and none of Bo's").toBe(false);
  }).toPass({ timeout: 15_000 });

  // Action, on top of the person.
  await page.getByLabel("Filter manifest by action").selectOption("create");
  await expect(async () => {
    const rows = await manifestRows(page);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(([, action]) => action === "create")).toBe(true);
  }).toPass({ timeout: 15_000 });

  // Search narrows to one block, across the summary text.
  await page.getByLabel("Filter manifest by action").selectOption("all");
  await page.getByLabel("Filter manifest by user").selectOption("all");
  await page.getByLabel("Search the manifest").fill("EE-2");
  await expect(async () => {
    const rows = await manifestRows(page);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(([, , change]) => change.includes("EE-2"))).toBe(true);
  }).toPass({ timeout: 15_000 });
});

test("#77: a change nobody was signed in for reads as Unsigned, not as somebody", async ({
  page,
}) => {
  await boot(page, "Alex Rivera");
  await addProject(page, "EE", "Enthesis Engineering");
  await addSample(page, "attributed block", "EE");

  // An unsigned change is planted rather than performed, because since #128 an
  // unsigned session cannot write at all — which is the point of #128 and means
  // the only rows like this are ones written by a build older than 0.14.0. They
  // are still in the lab's database, so the manifest still has to render them,
  // and rendering them as somebody would be worse than the gap itself.
  await page.evaluate(() => {
    (window as unknown as { __SHIM_SQL__: (q: string, b?: unknown[]) => void }).__SHIM_SQL__(
      `INSERT INTO audit_events (user_id, action, entity_type, entity_id, summary, created_at)
       VALUES (NULL, 'update', 'sample', 1, 'Updated sample EE-0001 by an older build', '2019-07-02 03:11')`,
    );
  });
  await page.goto("/");
  await expect(page.getByLabel("Signed-in user")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });

  await openManifest(page);
  await expect(async () => {
    const rows = await manifestRows(page);
    const orphan = rows.find(([, , change]) => change.includes("an older build"));
    expect(orphan, "the legacy row is listed rather than dropped").toBeTruthy();
    expect(orphan![0], "and it is honest about having no author").toBe("Unsigned");
  }).toPass({ timeout: 15_000 });

  // The unsigned rows are their own bucket in the filter, so "what has no
  // author?" is a question the view can answer.
  await page.getByLabel("Filter manifest by user").selectOption("__unsigned__");
  await expect(async () => {
    const rows = await manifestRows(page);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(([who]) => who === "Unsigned")).toBe(true);
  }).toPass({ timeout: 15_000 });

  // Picking a person excludes them again — the two buckets do not overlap.
  await page.getByLabel("Filter manifest by user").selectOption("Alex Rivera");
  await expect(async () => {
    const rows = await manifestRows(page);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(([who]) => who === "Unsigned")).toBe(false);
  }).toPass({ timeout: 15_000 });
});

/**
 * NOT covered here, deliberately: "renaming a user corrects the history rather
 * than forking it". The manifest joins the name at read time, which is what
 * makes that true, but there is no way to rename a USER in the app — Manage
 * offers rename for assay agents only. So the property is reachable from the
 * data layer and nowhere else, and it is asserted in `scripts/workflow-test.mjs`
 * instead. Written down because "why is that not tested here?" is otherwise a
 * question somebody has to re-derive.
 */
