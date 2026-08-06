import { test, expect, type Page } from "@playwright/test";
import { openManage, openSettings, setTheme } from "../helpers/app";
import { settleAfterDrop } from "../helpers/drag";

/**
 * The 0.7.4 follow-ups (#83 dark mode, #86 shared descriptions, #91 candidate
 * list, #95 cut timing) and the settings dialogue (#92, #93, #94).
 *
 * Every one of #83/#86/#91 is a SECOND report on an issue already marked fixed,
 * which is precisely the pattern these browser-driven checks exist to break: the
 * data layer was right each time and the thing the user actually touches was
 * not.
 */

async function signInAndProject(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill("Alex Rivera");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByLabel("Signed-in user").locator("option", { hasText: "Alex Rivera" }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: "Alex Rivera" });
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill("EE");
  await page.locator('input[placeholder="Enthesis Engineering"]').fill("Enthesis Engineering");
  await page.getByRole("button", { name: "Save Project" }).click();
}

async function addSample(page: Page, description: string) {
  await page.getByRole("button", { name: "New Sample" }).click();
  await expect(page.getByRole("heading", { name: /New Sample/ })).toBeVisible();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill(description);
  await page.getByRole("button", { name: /Create Sample/ }).click();
}

async function dragOnto(page: Page, sourceText: string, columnTitle: string) {
  const card = page.getByText(sourceText, { exact: true }).first();
  const header = page.getByRole("heading", { name: columnTitle, exact: true });
  const from = await card.boundingBox();
  const to = await header.boundingBox();
  if (!from || !to) throw new Error(`drag endpoints missing for ${sourceText} → ${columnTitle}`);
  const dropX = to.x + to.width / 2;
  const dropY = to.y + 140;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 4 });
  await page.mouse.move(dropX, dropY, { steps: 10 });
  await page.mouse.move(dropX, dropY + 2, { steps: 3 });
  await page.mouse.up();
  await settleAfterDrop(page);
}

/** Take one sample all the way to Embedded Inventory. */
async function embed(page: Page, code: string, batchLabel: string) {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await dragOnto(page, code, "Processor");
  await expect(page.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText(batchLabel, { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  await dragOnto(page, batchLabel, "Needs Embedding");
  await dragOnto(page, code, "Embedded Inventory");
}

async function cut(page: Page, code: string) {
  await page.getByText(code, { exact: true }).first().click();
  await page.getByRole("button", { name: /Send for Cutting/ }).click();
  await page.getByRole("button", { name: /Send for Cutting/ }).last().click();
  await page.locator("button:has(svg.lucide-x)").first().click();
}

/** sRGB relative luminance of a `rgb(...)` / `rgba(...)` string. */
function luminance(color: string): number {
  const nums = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  if (nums.length < 3) throw new Error(`not a colour: ${color}`);
  const [r, g, b] = nums.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// #83 follow-up — "the background color on the removed slides is way too
// bright, unreadable in dark mode theme".
//
// The row was painted `bg-red-50/60`, a FIXED near-white, while the text on it
// is theme-aware. In the eleven dark themes that is pale grey on bright pink.
// ---------------------------------------------------------------------------
test("#83: a removed slide's row is readable in a dark theme", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "dark mode removal");
  await embed(page, "EE-1", "Batch 1");
  await cut(page, "EE-1");

  // Remove the whole cut group, with a reason.
  await page.getByText("3 slides").first().click();
  await page.locator("button.text-red-600, button:has(svg.lucide-trash-2)").last().click();
  const dialog = page.getByRole("dialog", { name: /Remove this cut group/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason for removal").fill("block cracked");
  await dialog.getByRole("button", { name: "Remove cut group" }).click();
  await expect(page.getByText("3 slides")).toHaveCount(0, { timeout: 15000 });

  await setTheme(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "EE-1", exact: true }).click();
  const flag = page.getByText("Removed", { exact: true }).first();
  await expect(flag).toBeVisible();

  // The row's own paint must be DARK, like the theme it sits in. The old
  // bg-red-50/60 over a dark panel measured ~0.85 here.
  const rowBg = await page
    .locator("div.row-removed")
    .first()
    .evaluate((el) => window.getComputedStyle(el).backgroundColor);
  expect(luminance(rowBg)).toBeLessThan(0.2);

  // ...and the reason panel must be legible: open it and compare its actual
  // painted text colour against its actual painted background.
  await page.getByText("EE-1-A", { exact: true }).first().click();
  const note = page.locator("div.note-removed").first();
  await expect(note).toBeVisible();
  const { bg, fg } = await note.evaluate((el) => {
    const reason = el.querySelector("p:last-of-type") as HTMLElement;
    return {
      bg: window.getComputedStyle(el).backgroundColor,
      fg: window.getComputedStyle(reason).color,
    };
  });
  expect(contrastRatio(bg, fg)).toBeGreaterThan(4.5); // WCAG AA for body text
  await expect(page.getByText("block cracked").first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// #91 follow-up — "the list from which add samples should pull should be those
// samples which have been completely preprocessed, but NOT those that are in the
// embedded inventory".
// ---------------------------------------------------------------------------
test("#91: the Add list does not offer a block from the Embedded Inventory", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "in the run");
  await addSample(page, "already embedded");
  await addSample(page, "still waiting");

  // EE-2 goes all the way to Embedded Inventory; EE-3 completes preprocessing
  // and stops there.
  await embed(page, "EE-2", "Batch 1");
  for (const code of ["EE-3"]) {
    await page.getByText(code, { exact: true }).first().click();
    await page.getByRole("button", { name: "Placed in fixative" }).click();
    await page.getByRole("button", { name: "Removed from fixative" }).click();
    await page.getByRole("button", { name: "Placed in ethanol" }).click();
    await page.locator("button:has(svg.lucide-x)").first().click();
  }

  // Start a run holding EE-1 only.
  await page.getByText("EE-1", { exact: true }).first().click();
  await page.getByRole("button", { name: "Placed in fixative" }).click();
  await page.getByRole("button", { name: "Removed from fixative" }).click();
  await page.getByRole("button", { name: "Placed in ethanol" }).click();
  await page.locator("button:has(svg.lucide-x)").first().click();
  await dragOnto(page, "EE-1", "Processor");
  await expect(page.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await expect(async () => {
    const btn = page.getByRole("button", { name: "Start Batch" });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await expect(page.getByText("Batch 2", { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });

  // Open the running run and its Add list.
  await page.getByText("Batch 2", { exact: true }).click();
  await expect(page.getByRole("heading", { name: /Processing Batch/ })).toBeVisible();
  await page.getByRole("button", { name: /^Add$/ }).click();

  const adder = page.locator("div.border-dashed");
  await expect(adder).toBeVisible();
  // EE-3 is still waiting, so it IS offered — without this the next assertion
  // would pass on an empty list and prove nothing.
  await expect(adder.getByText("EE-3", { exact: true })).toBeVisible();
  // EE-2 is embedded. Every preprocessing timestamp it has is still set, which
  // is exactly why the timestamp-only rule offered it.
  await expect(adder.getByText("EE-2", { exact: true })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// #95 — a slide is cut when it is CUT, not when its group is queued.
// ---------------------------------------------------------------------------
test("#95: a queued slide has no Cut step until the group is sectioned", async ({ page }) => {
  await signInAndProject(page);
  await addSample(page, "cut timing");
  await embed(page, "EE-1", "Batch 1");
  await cut(page, "EE-1");

  async function slideTimelineHasCut(): Promise<boolean> {
    await page.locator("nav").getByRole("button", { name: "Logs" }).click();
    await page.getByRole("cell", { name: "EE-1", exact: true }).click();
    await page.getByRole("button", { name: /EE-1-A/ }).click();
    const has = (await page.getByText("Cut", { exact: true }).count()) > 0;
    await page.getByRole("button", { name: /EE-1-A/ }).click();
    await page.getByRole("cell", { name: "EE-1", exact: true }).click();
    await page.locator("nav").getByRole("button", { name: "Board" }).click();
    return has;
  }

  // Sitting in Needs Sectioning: planned, not cut.
  expect(await slideTimelineHasCut()).toBe(false);

  // Actually section it.
  await page.getByText("3 slides").first().click();
  await page.getByRole("button", { name: /Mark Sectioned/ }).click();
  const drawerClose = page.locator("button:has(svg.lucide-x)").first();
  if (await drawerClose.isVisible().catch(() => false)) {
    await drawerClose.click().catch(() => undefined);
  }

  // Now it is cut, and says so.
  expect(await slideTimelineHasCut()).toBe(true);
});

// ---------------------------------------------------------------------------
// #92 / #93 / #94 — the settings dialogue.
// ---------------------------------------------------------------------------
test("#93/#94: Manifest and the set-up controls have moved", async ({ page }) => {
  await signInAndProject(page);

  // #94 — the header no longer carries the three set-up controls.
  const header = page.locator("header");
  await expect(header.getByRole("button", { name: "Manage" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Backups" })).toHaveCount(0);
  await expect(header.getByLabel("Visual theme")).toHaveCount(0);

  // #93 — Manifest is in the left panel, below the project list, above the cog.
  const sidebar = page.locator("aside").first();
  await expect(sidebar.locator("nav").getByRole("button", { name: "Manifest" })).toHaveCount(0);
  const manifest = sidebar.getByRole("button", { name: "Manifest" });
  const settings = sidebar.getByRole("button", { name: "Settings", exact: true });
  await expect(manifest).toBeVisible();
  await expect(settings).toBeVisible();
  const manifestBox = await manifest.boundingBox();
  const settingsBox = await settings.boundingBox();
  const version = await sidebar.getByTitle("Histometer version").boundingBox();
  if (!manifestBox || !settingsBox || !version) throw new Error("sidebar layout not measurable");
  expect(manifestBox.y).toBeLessThan(settingsBox.y); // Manifest ABOVE the cog
  expect(settingsBox.y).toBeLessThan(version.y); // cog ABOVE the version

  // And it still works.
  await manifest.click();
  await expect(page.getByRole("heading", { name: /Manifest/ })).toBeVisible();
});

test("#92: cutting defaults are configurable and take effect", async ({ page }) => {
  await signInAndProject(page);

  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings" });
  // The reported default: three slides per block, not four.
  await expect(dialog.getByLabel("Slides per block")).toHaveValue("3");
  await dialog.getByLabel("Slides per block").fill("6");
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(dialog.getByText("Saved.")).toBeVisible();
  await page.keyboard.press("Escape");

  // It survives a reload — it is a database row, not component state.
  // goto("/") not reload(): the reload would carry ?freshdb=1 with it and
  // wipe the very database whose persistence is under test.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await openSettings(page);
  await expect(page.getByRole("dialog", { name: "Settings" }).getByLabel("Slides per block")).toHaveValue("6");
  await page.keyboard.press("Escape");

  // And a block embedded afterwards is planned for six.
  await addSample(page, "six slides please");
  await embed(page, "EE-1", "Batch 1");
  await cut(page, "EE-1");
  await expect(page.getByText("6 slides").first()).toBeVisible();
});

test("#92: hiding the Manifest hides the button and the view", async ({ page }) => {
  await signInAndProject(page);

  const sidebar = page.locator("aside").first();
  await expect(sidebar.getByRole("button", { name: "Manifest" })).toBeVisible();
  await sidebar.getByRole("button", { name: "Manifest" }).click();
  await expect(page.getByRole("heading", { name: /Manifest/ })).toBeVisible();

  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("checkbox", { name: /Show the Manifest/ }).uncheck();
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(dialog.getByText("Saved.")).toBeVisible();
  await page.keyboard.press("Escape");

  // The button goes...
  await expect(sidebar.getByRole("button", { name: "Manifest" })).toHaveCount(0);
  // ...and so does the view, even though it was the one selected when we hid
  // it — the choice is persisted, so otherwise the app reopens on a view with
  // no way back to it.
  await expect(page.getByRole("heading", { name: /Manifest/ })).toHaveCount(0);
  // goto("/") not reload(): the reload would carry ?freshdb=1 with it and
  // wipe the very database whose persistence is under test.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("aside").first().getByRole("button", { name: "Manifest" })).toHaveCount(0);
});
