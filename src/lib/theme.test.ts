import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contrastRatio,
  contrastWarnings,
  isPalette,
  parseColor,
  THEME_VARS,
  toHex,
  type Palette,
} from "./theme";

function palette(overrides: Record<string, string> = {}): Palette {
  const base: Palette = {};
  for (const v of THEME_VARS) base[v.name] = "#808080";
  return { ...base, ...overrides };
}

describe("parseColor", () => {
  it("reads the three shapes a custom property can come back as", () => {
    // Six-digit hex is what index.css declares; `rgb()` is what a value that has
    // been through an inline style can resolve to; three-digit is what somebody
    // types by hand. Assuming only the first would break the other two silently.
    expect(parseColor("#112233")).toEqual([17, 34, 51]);
    expect(parseColor("  #112233  ")).toEqual([17, 34, 51]);
    expect(parseColor("#abc")).toEqual([170, 187, 204]);
    expect(parseColor("rgb(17, 34, 51)")).toEqual([17, 34, 51]);
    expect(parseColor("rgba(17 34 51 / 0.5)")).toEqual([17, 34, 51]);
  });

  it("returns null rather than a wrong colour", () => {
    for (const bad of ["", "   ", "not a colour", "#12", "#1234567", "rgb(300, 0, 0)"]) {
      expect(parseColor(bad), bad).toBeNull();
    }
  });

  it("normalises to the form an <input type=color> accepts", () => {
    expect(toHex("rgb(17, 34, 51)")).toBe("#112233");
    expect(toHex("#ABC")).toBe("#aabbcc");
    expect(toHex("nonsense")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG anchors", () => {
    // Black on white is 21:1 and a colour on itself is 1:1 — the two ends of the
    // scale, which is enough to catch a luminance formula that is subtly wrong.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("is symmetric, so argument order cannot change the verdict", () => {
    const a = contrastRatio("#2f6f9f", "#eef1f5");
    const b = contrastRatio("#eef1f5", "#2f6f9f");
    expect(a).toBeCloseTo(b!, 10);
  });

  it("is null when either side is unparseable", () => {
    expect(contrastRatio("#000000", "nope")).toBeNull();
  });
});

describe("contrastWarnings", () => {
  it("says nothing about a readable palette", () => {
    expect(
      contrastWarnings(
        palette({
          "--color-panel": "#ffffff",
          "--color-surface": "#ffffff",
          "--color-ink": "#111111",
          "--color-ink-soft": "#444444",
          "--color-ink-faint": "#666666",
          "--color-brand-strong": "#1a3d5c",
        }),
      ),
    ).toEqual([]);
  });

  it("catches the failure that actually happens: text too close to its background", () => {
    const warnings = contrastWarnings(
      palette({ "--color-panel": "#ffffff", "--color-ink": "#eeeeee" }),
    );
    expect(warnings.some((w) => w.label === "Text on cards")).toBe(true);
  });

  it("reports the worst offender first", () => {
    const warnings = contrastWarnings(
      palette({
        "--color-panel": "#ffffff",
        "--color-ink": "#dddddd", // hopeless
        "--color-ink-soft": "#999999", // merely bad
      }),
    );
    expect(warnings.length).toBeGreaterThan(1);
    for (let i = 1; i < warnings.length; i += 1) {
      expect(warnings[i - 1].ratio).toBeLessThanOrEqual(warnings[i].ratio);
    }
  });

  it("holds the faint ink to the lower bar it is actually used at", () => {
    // ink-faint carries timestamps and hints, never body text, so it is judged
    // at 3:1. Judging it at 4.5 would make almost every existing theme warn,
    // and a warning that always fires is one nobody reads.
    const grey = contrastWarnings(palette({ "--color-panel": "#ffffff", "--color-ink-faint": "#949494" }));
    expect(grey.some((w) => w.label === "Hints on cards")).toBe(false);
  });
});

describe("isPalette", () => {
  it("accepts a complete one and rejects anything else", () => {
    expect(isPalette(palette())).toBe(true);
    expect(isPalette(null)).toBe(false);
    expect(isPalette("#fff")).toBe(false);
    // A palette missing a variable is the shape a build with a DIFFERENT
    // variable set would have written. Applying it half-way would leave the
    // remaining variables inherited from whatever theme was underneath, which
    // is a mix nobody chose.
    const short = palette();
    delete short[THEME_VARS[0].name];
    expect(isPalette(short)).toBe(false);
    // And one with an unparseable value.
    expect(isPalette({ ...palette(), [THEME_VARS[0].name]: "octarine" })).toBe(false);
  });
});

describe("the variable list matches the stylesheet", () => {
  it("covers every custom property a theme block sets", () => {
    // The customizer saves exactly THEME_VARS. If a theme in index.css sets a
    // variable this list does not know about, a custom palette would silently
    // drop it and be subtly different from every built-in theme — so the list
    // is checked against the real stylesheet rather than trusted.
    // Scanned across EVERY theme rule, not one block. The first version of this
    // read only `[data-theme="dark"]` and failed — because `--color-warn` is set
    // in a shared rule covering all the dark themes rather than inside each one.
    // That is exactly the drift this test exists to notice, and it noticed it on
    // its first run.
    const css = readFileSync(join(__dirname, "..", "index.css"), "utf8");
    const declared = [
      ...new Set([...css.matchAll(/^\s+(--color-[a-z-]+)\s*:/gm)].map((m) => m[1])),
    ].sort();
    const known = THEME_VARS.map((v) => v.name).sort();
    expect(declared).toEqual(known);
  });
});
