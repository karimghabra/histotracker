// Open issues #140, #142 and #146, walked through the real app. Each assertion is on the
// harm the issue names, so any fix that removes the harm passes.
//
// Each test is marked `test.fail()`: the bug is open, so the test is expected to fail and CI stays
// green. The day the fix lands the test passes, Playwright reports that as a failure, and whoever
// fixed the issue must delete the `test.fail()` line here, which turns it into a hard check.
import { test, expect, type Page } from "@playwright/test";
import { openSettings, setTheme } from "../helpers/app";
import { DB, addProject, addSample, boot, signOutAndBackIn } from "../helpers/lab";

test("#140: after a sign-out and sign-in, the sidebar's selection and the board's filters agree", async ({ page }) => {
  test.fail(true, "OPEN ISSUE #140: delete this line in the pull request that fixes it");
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addProject(page, "ZZ", "Zebrafish");
  await addSample(page, "ee block", "EE");
  const sidebar = page.locator("aside").first();
  const filter = page.getByLabel("Filter pre-processing by project");

  await sidebar.getByRole("button", { name: /^Enthesis Engineering/ }).click();
  await expect(filter, "picking EE filters the board (#131)").not.toHaveValue("all");

  await signOutAndBackIn(page);
  await expect(page.getByRole("heading", { name: "Pre-processing", exact: true })).toBeVisible();

  const selected = (await sidebar.locator('[aria-current="true"]').first().innerText()).replace(/\s+/g, " ");
  const sidebarSays = /Enthesis Engineering/.test(selected) ? "EE" : /Zebrafish/.test(selected) ? "ZZ" : "all";
  const value = await filter.inputValue();
  const boardSays = value === "all" ? "all" : (await filter.locator(`option[value="${value}"]`).innerText()).trim().slice(0, 2);
  expect(boardSays,`sidebar selects "${selected.slice(0, 40)}"; board filter value ${value}`).toBe(sidebarSays);
});

test.describe("#142: on a dark OS", () => {
  test.use({ colorScheme: "dark" });

  /** The board's painted surface as [r, g, b], through a 1x1 canvas colour parser (not a capture). */
  const surface = (page: Page) =>
    page.evaluate(() => {
      const css = getComputedStyle(document.documentElement).getPropertyValue("--color-surface").trim();
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    });
  const luminance = ([r, g, b]: number[]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

  test("#142: the System theme's customizer starts from the dark palette on screen", async ({ page }) => {
    test.fail(true, "OPEN ISSUE #142: delete this line in the pull request that fixes it");
    await page.goto("/?freshdb=1");
    await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({ timeout: 20_000 });
    await setTheme(page, "system");
    const before = await surface(page);
    expect(luminance(before), `System on a dark OS paints rgb(${before})`).toBeLessThan(0.35);

    await openSettings(page);
    await page.getByRole("button", { name: /Customize colours/ }).click();
    const panel = page.getByRole("complementary", { name: "Theme customizer" });
    await expect(panel).toBeVisible();
    expect(`rgb(${await surface(page)})`, "the board's surface once the customizer opens").toBe(`rgb(${before})`);
    await expect(panel.getByText(/reads as (dark|light)/)).toHaveText(/reads as dark/);
  });
});

test("#146: signed out, Undo can neither change the record nor sign anyone in", async ({ page }) => {
  test.fail(true, "OPEN ISSUE #146: delete this line in the pull request that fixes it");
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addSample(page, "first block", "EE");
  await addSample(page, "second block", "EE");
  const record = () =>
    page.evaluate(async (path) => {
      const db = (await import(/* @vite-ignore */ path)) as Record<string, (...a: unknown[]) => Promise<never>>;
      const samples = (await db.listOpenSamples()) as Array<{ sample_code: string }>;
      const user = (await db.getActiveUser()) as { name: string } | null;
      return { samples: samples.map((s) => s.sample_code).sort().join(","), signedIn: user?.name ?? "nobody" };
    }, DB);
  const before = await record();
  expect(before.samples.split(",")).toHaveLength(2);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Keep reading" }).click();
  const signedOut = { ...before, signedIn: "nobody" };
  expect(await record()).toEqual(signedOut);

  // Both routes the issue names: the header button, and Ctrl+Z.
  const undo = page.getByTitle("Undo (Ctrl+Z)");
  if (await undo.isEnabled()) await undo.click();
  await page.locator("body").press("Control+z");

  // Undo swaps a whole image in, which lands in milliseconds; watch for 4 s and stop at the first harm.
  let now = signedOut;
  for (const deadline = Date.now() + 4000; Date.now() < deadline; await page.waitForTimeout(200)) {
    now = await record();
    if (JSON.stringify(now) !== JSON.stringify(signedOut)) break;
  }
  expect(JSON.stringify(now), "the record and the session after Undo while signed out").toBe(JSON.stringify(signedOut));
});
