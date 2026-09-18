// #143: every built-in theme passes the customizer's own "Hints on cards" rule.
// Picking "Start from" any theme and changing nothing must not open with a
// "Hard to read" warning, which is what makes a warning that nobody reads.
// The palettes are read from the real stylesheet, not copied here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRAST_PAIRS, contrastRatio, contrastWarnings, THEME_VARS, type Palette } from "./theme";
import { THEME_OPTIONS } from "./themes";

const css = readFileSync(join(__dirname, "..", "index.css"), "utf8");

function declarations(body: string): Palette {
  return Object.fromEntries([...body.matchAll(/(--color-[a-z-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** The `@theme` defaults every theme block overrides. */
const defaults = declarations(/@theme\s*\{([^}]*)\}/.exec(css)![1]);

/** A built-in theme as it resolves on screen: the defaults, then each of its own blocks in source order. */
function builtIn(theme: string): Palette {
  const own = [...css.matchAll(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`, "g"))].map((m) =>
    declarations(m[1]),
  );
  return Object.assign({}, defaults, ...own);
}

const NAMED = THEME_OPTIONS.map((o) => o.value).filter((value) => value !== "system" && value !== "custom");
const hints = CONTRAST_PAIRS.find((pair) => pair.label === "Hints on cards")!;

// The 26 themes the picker offers besides Custom: 25 named ones and System. System is the
// stylesheet defaults on a light OS and its own block under `prefers-color-scheme: dark`
// on a dark one, so it is checked as both.
const THEMES: Array<[string, Palette]> = [
  ...NAMED.map((theme): [string, Palette] => [theme, builtIn(theme)]),
  ["system (light OS)", defaults],
  ["system (dark OS)", builtIn("system")],
];

describe("built-in themes against the customizer's own contrast rule", () => {
  it("covers all 26 built-in themes, each defining every colour the customizer edits", () => {
    expect(new Set(THEMES.map(([name]) => name.replace(/ \(.*/, ""))).size).toBe(26);
    for (const [theme, palette] of THEMES) {
      for (const v of THEME_VARS) expect(palette[v.name], `${theme} ${v.name}`).toBeTruthy();
    }
  });

  it.each(THEMES)("%s: hints on cards reach the rule's minimum", (theme, palette) => {
    const ratio = contrastRatio(palette[hints.foreground], palette[hints.background])!;
    expect(ratio, `${theme}: ${hints.foreground} on ${hints.background}`).toBeGreaterThanOrEqual(hints.min);
  });

  it.each(THEMES)("%s: opens the customizer with no warning at all", (_theme, palette) => {
    expect(contrastWarnings(palette).map((w) => w.label)).toEqual([]);
  });
});
