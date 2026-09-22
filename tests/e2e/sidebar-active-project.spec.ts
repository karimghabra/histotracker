import { test, expect, type Page, type Locator } from "../helpers/test";
import { openManage, setTheme } from "../helpers/app";
import { contrastRatio } from "../../src/lib/theme";

/** The colour actually painted behind an element: its own and its ancestors'
 * backgrounds, composited, since the selected row's fill is translucent
 * (`bg-brand/20`) over whatever the sidebar itself paints. Colours are parsed
 * through a 1x1 canvas fill rather than a regex: Tailwind v4's computed colours
 * come back as oklch(), which a plain rgb()/rgba() pattern would not match. */
async function compositedBackground(locator: Locator): Promise<string> {
  return locator.evaluate((el) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const parse = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    let base: [number, number, number, number] = [255, 255, 255, 1];
    const layers: Array<[number, number, number, number]> = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
    }
    for (let i = layers.length - 1; i >= 0; i--) {
      const [r, g, b, a] = layers[i];
      base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a), 1];
    }
    return `rgb(${Math.round(base[0])}, ${Math.round(base[1])}, ${Math.round(base[2])})`;
  });
}

// #84 — the active project drives which project a new sample lands in, so it has
// to be obvious at a glance. Three projects, so "which one is selected?" is a
// real question; asserted as a background contrast ratio against an unselected
// neighbour, in every theme, rather than left for a person to judge from a picture.

async function boot(page: Page) {
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
}

async function addProject(page: Page, code: string, name: string) {
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill(code);
  await page.locator('input[placeholder="Enthesis Engineering"]').fill(name);
  await page.getByRole("button", { name: "Save Project" }).click();
}

test("#84: the selected project stands out against its neighbours", async ({ page }) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addProject(page, "CART", "Cartilage Repair");
  await addProject(page, "TEND", "Tendon Healing");

  const sidebar = page.locator("aside");
  const active = sidebar.locator('button[aria-current="true"]');

  // Exactly one project is marked, and it says SELECTED — not ACTIVE. Every
  // project in this list is active, so that badge answered a question nobody
  // asked while the real one went unanswered (#84).
  await expect(active).toHaveCount(1);
  await expect(active.getByText("Selected", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Active", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByText("Projects", { exact: true })).toBeVisible();

  // Select a different project — the marker follows the click.
  await sidebar.getByText("Cartilage Repair").click();
  await expect(active).toHaveCount(1);
  await expect(active).toContainText("Cartilage Repair");
  await expect(active).toContainText("CART");

  // The selected row must not paint outside its own box. A plain Tailwind `ring`
  // is a box-shadow drawn OUTSIDE the border box, so the selected row rendered
  // 4px wider than every other row and sat proud of the list — the report's
  // "darker box does not fit within the larger box".
  //
  // Asserted on the computed box-shadow, NOT on measured widths: a box-shadow is
  // outside the layout box entirely, so getBoundingClientRect() reports the same
  // width either way. A width comparison here passes with the bug present and is
  // worse than no assertion, because it looks like coverage.
  const ringShadow = await active.evaluate((el) =>
    getComputedStyle(el)
      .boxShadow.split(/,(?![^(]*\))/)
      .map((s) => s.trim())
      .find((s) => !s.startsWith("rgba(0, 0, 0, 0)")) ?? "",
  );
  expect(ringShadow).toContain("inset");

  // The selected row must stand out against an unselected neighbour, and keep
  // its inset ring, in every theme, not only the light one it happened to be
  // designed in. What the three per-theme captures this replaces stood in for.
  // Unselected rows carry no aria-current attribute at all, so name the
  // neighbour instead of trying to negate one.
  const neighbour = sidebar.getByRole("button", { name: /Enthesis Engineering/ });
  for (const theme of ["light", "dark", "matcha"]) {
    if (theme !== "light") {
      await setTheme(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    }
    const [activeBg, neighbourBg] = await Promise.all([
      compositedBackground(active),
      compositedBackground(neighbour),
    ]);
    const ratio = contrastRatio(activeBg, neighbourBg);
    expect(ratio, `${theme} theme: selected vs. unselected row background contrast`).not.toBeNull();
    expect(ratio!, `${theme} theme: ${activeBg} against ${neighbourBg}`).toBeGreaterThan(1.1);
    const shadow = await active.evaluate((el) =>
      getComputedStyle(el)
        .boxShadow.split(/,(?![^(]*\))/)
        .map((s) => s.trim())
        .find((s) => !s.startsWith("rgba(0, 0, 0, 0)")) ?? "",
    );
    expect(shadow, `${theme} theme: selected row keeps its inset ring`).toContain("inset");
  }
});

// #84 — collapsed, the sidebar is 56px wide and the selected project used to
// carry BOTH a fill and a dot. Dot + gap + three letters needed ~33px in a 31px
// content box, so the code was clipped. Two indicators do not fit; the redundant
// one goes.
test("#84: the collapsed sidebar does not clip the selected project", async ({ page }) => {
  await boot(page);
  await addProject(page, "EE", "Enthesis Engineering");
  await addProject(page, "CART", "Cartilage Repair");
  await addProject(page, "TEND", "Tendon Healing");

  const sidebar = page.locator("aside");
  await page.getByTitle("Collapse projects").click();
  const selected = sidebar.locator('button[aria-current="true"]');
  await expect(selected).toHaveCount(1);

  // WAIT FOR THE WIDTH TO SETTLE. The sidebar animates via `transition-[width]`,
  // so measuring straight after the click samples a 256px-wide sidebar that is
  // still shrinking — where everything fits and the assertion below passes no
  // matter what. This is why an earlier version of this test reported the
  // clipping fix as untestable: it was measuring the wrong frame.
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())!.width), { timeout: 5000 })
    .toBe(56);

  // The project CODE must render in full, inside the button's CONTENT box.
  //
  // The content box is the point. Before the fix the label ran from 13px to 46px
  // inside a button whose border box was 6→49 but whose content box (after
  // pl-2 pr-1) was only 14→45 — so it overflowed by ~1px each side and was
  // visibly clipped, while every border-box comparison said it was fine. Two
  // earlier versions of this assertion passed with the bug present.
  //
  // Truncation counts as clipping too: "TE…" is not an answer to "which project
  // will this sample go into?".
  const fits = await selected.evaluate((btn) => {
    const cs = getComputedStyle(btn);
    const b = btn.getBoundingClientRect();
    const aside = btn.closest("aside")!.getBoundingClientRect();
    const contentLeft = b.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    const contentRight = b.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    const labels = [...btn.querySelectorAll("span")].filter((s) => s.textContent?.trim());
    return {
      buttonInsideSidebar: b.left >= aside.left && b.right <= aside.right,
      labelOverflow: labels.some((s) => {
        const r = s.getBoundingClientRect();
        return r.left < contentLeft - 0.5 || r.right > contentRight + 0.5;
      }),
      // True when `truncate` has ellipsised the code, or content overflows a
      // hidden box — the other shape the same squeeze can take.
      anyEllipsised: labels.some((s) => s.scrollWidth > s.clientWidth + 1),
      text: btn.textContent?.trim() ?? "",
    };
  });
  expect(fits.buttonInsideSidebar).toBe(true);
  expect(fits.labelOverflow).toBe(false);
  expect(fits.anyEllipsised).toBe(false);
  expect(fits.text).toBe("TEN");


  // Still selectable while collapsed, and the marker follows.
  await sidebar.getByText("CAR", { exact: true }).click();
  await expect(sidebar.locator('button[aria-current="true"]')).toContainText("CAR");
});
