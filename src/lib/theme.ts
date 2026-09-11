/**
 * The custom theme: the eleven variables a theme is made of, read live from the
 * stylesheet, and the contrast maths that stops somebody building an unreadable
 * one by accident.
 *
 * Themes are `:root[data-theme="…"]` blocks in `index.css` overriding these
 * eleven variables and nothing else, so "a theme" is exactly this record. A
 * custom one is the same eleven values written as inline styles on `:root`,
 * which beat the stylesheet without editing it.
 *
 * The palette lives in `localStorage`, beside the theme NAME that has always
 * lived there. That is deliberate and it is the same reasoning as
 * `viewPrefs.ts`: which colours you find readable is one person's view of one
 * screen, not a fact about the lab, and it must not sync to anybody else.
 */

export type Palette = Record<string, string>;

export interface ThemeVar {
  /** The CSS custom property, exactly as `index.css` declares it. */
  name: string;
  label: string;
  hint: string;
}

export interface ThemeVarGroup {
  title: string;
  vars: ThemeVar[];
}

/**
 * Every variable a theme sets, grouped the way somebody thinks about them
 * rather than the way the stylesheet lists them.
 *
 * If a future theme adds a twelfth variable, it must be added here too —
 * otherwise the customizer would silently drop it when saving a palette, and a
 * custom theme would be subtly different from every built-in one. A unit test
 * asserts this list matches what the stylesheet actually defines.
 */
export const THEME_VAR_GROUPS: ThemeVarGroup[] = [
  {
    title: "Paper",
    vars: [
      { name: "--color-surface", label: "Surface", hint: "The board behind everything" },
      { name: "--color-panel", label: "Panel", hint: "Cards, drawers, dialogs" },
      { name: "--color-line", label: "Line", hint: "Borders and dividers" },
    ],
  },
  {
    title: "Ink",
    vars: [
      { name: "--color-ink", label: "Ink", hint: "Body text" },
      { name: "--color-ink-soft", label: "Ink soft", hint: "Secondary text" },
      { name: "--color-ink-faint", label: "Ink faint", hint: "Timestamps, hints" },
    ],
  },
  {
    title: "Accent",
    vars: [
      { name: "--color-brand", label: "Brand", hint: "Buttons, selection" },
      { name: "--color-brand-strong", label: "Brand strong", hint: "Pressed and filled states" },
      { name: "--color-lane-a", label: "Lane A", hint: "First board lane" },
      { name: "--color-lane-b", label: "Lane B", hint: "Second board lane" },
      { name: "--color-warn", label: "Warn", hint: "Overdue, awaiting pickup" },
    ],
  },
];

export const THEME_VARS: ThemeVar[] = THEME_VAR_GROUPS.flatMap((group) => group.vars);

export const CUSTOM_THEME = "custom";
const STORAGE_KEY = "histometer-theme-custom";

// ---------------------------------------------------------------------------
// Colour parsing
// ---------------------------------------------------------------------------

/**
 * Parse whatever the browser hands back for a custom property.
 *
 * `getComputedStyle().getPropertyValue()` returns the declared token, so for
 * these themes that is a hex string with leading whitespace — but a value that
 * has been through an inline style may come back as `rgb(…)`, and a hand-typed
 * one may be three-digit hex. All three are accepted rather than assuming the
 * one shape the stylesheet happens to use today.
 */
export function parseColor(value: string): [number, number, number] | null {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return null;

  const rgb = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map((n) => Math.round(Number(n)));
    if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
    return [parts[0], parts[1], parts[2]];
  }

  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!hex) return null;
  const digits = hex[1];
  if (digits.length === 3) {
    return [
      parseInt(digits[0] + digits[0], 16),
      parseInt(digits[1] + digits[1], 16),
      parseInt(digits[2] + digits[2], 16),
    ];
  }
  return [
    parseInt(digits.slice(0, 2), 16),
    parseInt(digits.slice(2, 4), 16),
    parseInt(digits.slice(4, 6), 16),
  ];
}

/** Normalise anything parseable to `#rrggbb`, which is what `<input type=color>` needs. */
export function toHex(value: string): string | null {
  const rgb = parseColor(value);
  if (!rgb) return null;
  return `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number | null {
  const one = parseColor(a);
  const two = parseColor(b);
  if (!one || !two) return null;
  const [hi, lo] = [luminance(one), luminance(two)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The pairs that actually carry information, and the ratio each needs.
 *
 * Not every combination — only the ones where failing means you cannot read the
 * app. `index.css` already carries a long note about a related hazard (fixed
 * pink row tints became unreadable in the dark themes), which is the evidence
 * that this is a real way to lose an afternoon rather than a theoretical one.
 *
 * 4.5:1 is WCAG AA for body text; 3:1 is the large-text and non-text threshold,
 * used for the faint ink that only ever carries timestamps and hints.
 */
export const CONTRAST_PAIRS: Array<{
  foreground: string;
  background: string;
  label: string;
  min: number;
}> = [
  { foreground: "--color-ink", background: "--color-panel", label: "Text on cards", min: 4.5 },
  { foreground: "--color-ink", background: "--color-surface", label: "Text on the board", min: 4.5 },
  { foreground: "--color-ink-soft", background: "--color-panel", label: "Secondary text on cards", min: 4.5 },
  { foreground: "--color-ink-faint", background: "--color-panel", label: "Hints on cards", min: 3 },
  // The white-on-brand case: `Sidebar.tsx` notes that `text-surface` on
  // `brand-strong` was chosen deliberately because brand-strong is a LIGHT tone
  // in the dark themes. A custom palette can break that in either direction.
  { foreground: "--color-surface", background: "--color-brand-strong", label: "Selected project label", min: 4.5 },
];

export interface ContrastWarning {
  label: string;
  ratio: number;
  min: number;
}

/** Which readable-text rules this palette fails, worst first. */
export function contrastWarnings(palette: Palette): ContrastWarning[] {
  const warnings: ContrastWarning[] = [];
  for (const pair of CONTRAST_PAIRS) {
    const ratio = contrastRatio(palette[pair.foreground] ?? "", palette[pair.background] ?? "");
    if (ratio == null) continue;
    if (ratio < pair.min) warnings.push({ label: pair.label, ratio, min: pair.min });
  }
  return warnings.sort((a, b) => a.ratio - b.ratio);
}

/**
 * Is this palette a DARK theme? (Inferred, not asked.)
 *
 * This matters more than it looks. A theme in `index.css` is not only eleven
 * variables: the dark ones also set `color-scheme: dark` and remap Tailwind's
 * literal `bg-white` to the panel colour. `bg-white` is on 42 elements — every
 * text input and every subtle button among them — so a dark palette WITHOUT
 * that remap renders white boxes on a dark board. The contrast check cannot
 * catch it, because #ffffff is not one of the eleven values the user picked.
 *
 * Inferred from the surface rather than asked, because it is not really a
 * question: a theme whose board is nearly black is a dark theme, and making
 * somebody tick a box to say so is an invitation to get it wrong.
 */
export function isDarkPalette(palette: Palette): boolean {
  const surface = parseColor(palette["--color-surface"] ?? "");
  if (!surface) return false;
  return luminance(surface) < 0.5;
}

// ---------------------------------------------------------------------------
// Reading and applying
// ---------------------------------------------------------------------------

/**
 * The eleven values a built-in theme resolves to, read from the stylesheet.
 *
 * Deliberately NOT a copy of the palettes in TypeScript. `index.css` is the
 * source of truth for what a theme looks like, and a second copy here would be
 * a fork that drifts the first time somebody adjusts a colour — the customizer
 * would then "start from Night Shift" and produce something that is not Night
 * Shift. Applying the attribute and reading the computed value asks the real
 * stylesheet instead.
 *
 * The attribute is restored synchronously before returning, so nothing paints
 * in between.
 */
export function readThemePalette(theme: string): Palette {
  const root = document.documentElement;
  const previous = root.getAttribute("data-theme");
  const previousInline = THEME_VARS.map(
    (v) => [v.name, root.style.getPropertyValue(v.name)] as const,
  );

  // Inline values win over the stylesheet, so a custom palette already applied
  // would be read back instead of the theme asked for. Clear, read, restore.
  for (const v of THEME_VARS) root.style.removeProperty(v.name);
  if (theme === "system" || !theme) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);

  const computed = getComputedStyle(root);
  const palette: Palette = {};
  for (const v of THEME_VARS) {
    palette[v.name] = toHex(computed.getPropertyValue(v.name)) ?? "#000000";
  }

  if (previous === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", previous);
  for (const [name, value] of previousInline) {
    if (value) root.style.setProperty(name, value);
  }
  return palette;
}

/** Paint a palette onto `:root`, or clear it and fall back to the stylesheet. */
export function applyPalette(palette: Palette | null): void {
  const root = document.documentElement;
  for (const v of THEME_VARS) {
    const value = palette?.[v.name];
    if (value) root.style.setProperty(v.name, value);
    else root.style.removeProperty(v.name);
  }
  // The dark flag rides along here rather than being set by the caller, so the
  // variables and the `bg-white` override can never disagree about which theme
  // is showing — a half-applied dark theme is the exact failure it is for.
  if (palette && isDarkPalette(palette)) root.setAttribute("data-custom-dark", "true");
  else root.removeAttribute("data-custom-dark");
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Is this a complete, parseable palette? A half-written one is not applied. */
export function isPalette(value: unknown): value is Palette {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return THEME_VARS.every((v) => typeof record[v.name] === "string" && parseColor(record[v.name] as string) !== null);
}

/**
 * Every read is total. A corrupt blob, a palette written by a build with a
 * different variable set, or storage that throws in a locked-down browser all
 * fall back to "no custom theme" rather than throwing inside a render.
 */
export function loadCustomPalette(): Palette | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isPalette(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveCustomPalette(palette: Palette): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(palette));
  } catch {
    // Storage full or blocked: the palette stays applied for this session and
    // is simply not remembered. Losing a colour choice is not worth a crash.
  }
}
