// #162: the Logs "Add a stain" dropdown follows the active theme.
// The open list of a native <select> takes its colours from its <option>s, so the
// assertion is on the computed text and background colour of those options and the
// contrast between them, read through a 1x1 canvas colour parser. Nothing is looked at.
import { test, expect, type Page } from "@playwright/test";
import { setTheme } from "../helpers/app";
import { addProject, addSample, boot } from "../helpers/lab";

type Rgba = [number, number, number, number];

/** The computed colours of the dropdown's control and of its listed options. */
async function stainSelectColours(page: Page) {
  return page.getByLabel("Add a stain to EE-1").evaluate((select) => {
    const parse = (css: string): Rgba => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data] as Rgba;
    };
    const root = getComputedStyle(document.documentElement);
    const option = select.querySelector("option[value]:not([value=''])")!;
    const styled = getComputedStyle(option);
    return {
      panel: parse(root.getPropertyValue("--color-panel").trim()),
      ink: parse(root.getPropertyValue("--color-ink").trim()),
      optionText: parse(styled.color),
      optionBackground: parse(styled.backgroundColor),
    };
  });
}

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgba) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

for (const theme of ["light", "dark", "cobalt", "terminal", "arctic"]) {
  test(`#162: the Add a stain options follow the ${theme} theme`, async ({ page }) => {
    await boot(page);
    await addProject(page, "EE", "Enthesis Engineering");
    await addSample(page, "loggable block", "EE");
    await setTheme(page, theme);
    await page.locator("nav").getByRole("button", { name: "Logs" }).click();
    await page.getByRole("cell", { name: "EE-1", exact: true }).click();
    await expect(page.getByLabel("Add a stain to EE-1")).toBeVisible({ timeout: 15_000 });

    const c = await stainSelectColours(page);
    expect(c.optionBackground, `option background in ${theme} is the theme's card colour, opaque`).toEqual(c.panel);
    expect(c.optionText, `option text in ${theme} is the theme's ink`).toEqual(c.ink);
    expect(contrast(c.optionText, c.optionBackground), `option contrast in ${theme}`).toBeGreaterThanOrEqual(4.5);
  });
}
