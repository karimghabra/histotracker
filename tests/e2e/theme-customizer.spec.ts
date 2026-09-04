import { test, expect, type Page } from "@playwright/test";
import { openSettings } from "../helpers/app";

/**
 * Building a theme while watching the board change.
 *
 * The requirement was "customize a theme and preview it at the same time", and
 * that is a layout claim as much as a colour one: the picker used to live in a
 * modal that covered the board, so every change meant close, look, reopen. The
 * assertions below are therefore as much about the board still being VISIBLE
 * and painted as about the palette being stored.
 */

async function boot(page: Page) {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
}

const surfaceOf = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-surface").trim(),
  );

async function openCustomizer(page: Page) {
  await openSettings(page);
  await page.getByRole("button", { name: /Customize colours/ }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Theme customizer" })).toBeVisible();
}

test("the board stays visible and repaints while you pick", async ({ page }) => {
  await boot(page);
  const before = await surfaceOf(page);

  await openCustomizer(page);

  // The dialog is GONE and the board is still there. This is the whole point:
  // a customizer inside a modal cannot preview anything.
  await expect(page.getByRole("heading", { name: "Pre-processing", exact: true })).toBeVisible();

  await page.getByLabel("Surface hex").fill("#123456");
  await expect(async () => {
    expect(await surfaceOf(page)).toBe("#123456");
  }).toPass({ timeout: 10_000 });

  // Painted live, before saving anything — the board is the preview.
  expect(await surfaceOf(page)).not.toBe(before);
  await expect(page.getByRole("heading", { name: "Pre-processing", exact: true })).toBeVisible();
});

test("discard puts back exactly what was there", async ({ page }) => {
  await boot(page);
  const before = await surfaceOf(page);

  await openCustomizer(page);
  await page.getByLabel("Surface hex").fill("#654321");
  await expect(async () => {
    expect(await surfaceOf(page)).toBe("#654321");
  }).toPass({ timeout: 10_000 });

  await page.getByRole("button", { name: /Discard/ }).click();
  await expect(page.getByRole("complementary", { name: "Theme customizer" })).toHaveCount(0);
  await expect(async () => {
    expect(await surfaceOf(page)).toBe(before);
  }).toPass({ timeout: 10_000 });
});

test("a saved theme survives a reload", async ({ page }) => {
  await boot(page);
  await openCustomizer(page);
  await page.getByLabel("Surface hex").fill("#0b1d2e");
  await page.getByLabel("Panel hex").fill("#14263a");
  await page.getByRole("button", { name: /Save theme/ }).click();
  await expect(page.getByRole("complementary", { name: "Theme customizer" })).toHaveCount(0);

  await page.goto("/");
  await expect(page.getByLabel("Signed-in user")).toBeVisible({ timeout: 20_000 });
  await expect(async () => {
    expect(await surfaceOf(page)).toBe("#0b1d2e");
  }).toPass({ timeout: 10_000 });

  // A dark palette must also get what every built-in dark theme gets: the
  // `bg-white` remap. Without it every text input and subtle button stays
  // literally white on a dark board — 42 elements — and the contrast check
  // cannot see it, because #ffffff is not a colour the user picked.
  await expect(page.locator("html")).toHaveAttribute("data-custom-dark", "true");
});

test("it warns when a palette is unreadable, and still lets you save it", async ({ page }) => {
  await boot(page);
  await openCustomizer(page);

  await page.getByLabel("Panel hex").fill("#ffffff");
  await page.getByLabel("Ink hex").fill("#f4f4f4");

  const warnings = page.getByRole("status", { name: "Contrast warnings" });
  await expect(warnings).toBeVisible();
  await expect(warnings).toContainText("Text on cards");

  // A warning, not a rule — a lab that wants a low-contrast theme for a dark
  // room can have one; it just should not get one by accident.
  await expect(page.getByRole("button", { name: /Save theme/ })).toBeEnabled();
});
