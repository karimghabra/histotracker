/**
 * The theme picker's options, lifted out of the header when the picker moved
 * into the settings dialogue (#94).
 *
 * The values must match the `:root[data-theme="…"]` selectors in index.css. The
 * ☀/☾ prefix says which are light and which are dark, which is the only thing
 * the names do not tell you.
 */
export const THEME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "system", label: "◐ System" },
  { value: "light", label: "☀ Clinical Light" },
  { value: "dark", label: "☾ Night Shift" },
  { value: "contrast", label: "☾ High Contrast" },
  { value: "ocean", label: "☀ Ocean Glass" },
  { value: "forest", label: "☀ Forest Bench" },
  { value: "lavender", label: "☀ Lavender Haze" },
  { value: "rose", label: "☀ Rose Quartz" },
  { value: "sunset", label: "☀ Sunset Agar" },
  { value: "mint", label: "☀ Mint Cleanroom" },
  { value: "matcha", label: "☀ Matcha Tea" },
  { value: "solarized", label: "☀ Solarized Slide" },
  { value: "arctic", label: "☀ Arctic Bloom" },
  { value: "sakura", label: "☀ Sakura Lab" },
  { value: "citrus", label: "☀ Citrus Pop" },
  { value: "parchment", label: "☀ Parchment" },
  { value: "candy", label: "☀ Candy Microscope" },
  { value: "blueprint", label: "☾ Blueprint" },
  { value: "mocha", label: "☾ Mocha Microscope" },
  { value: "cobalt", label: "☾ Cobalt Night" },
  { value: "aubergine", label: "☾ Aubergine" },
  { value: "deepsea", label: "☾ Deep Sea" },
  { value: "evergreen", label: "☾ Evergreen Night" },
  { value: "neon", label: "☾ Neon Culture" },
  { value: "graphite", label: "☾ Graphite" },
  { value: "terminal", label: "☾ Retro Terminal" },
];
