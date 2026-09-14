/**
 * What a person looks at a screenshot for, measured instead of photographed.
 *
 * `auditInPage` runs inside the page (pass it to `page.evaluate`) and returns one
 * sorted line per problem, so two renders compare with a plain text diff:
 *
 *  - page-scrolls-sideways   the document is wider than the viewport
 *  - control-cut-off         a button, link or field is clipped by an overflow:hidden
 *                            ancestor or pushed outside the viewport, and no scroll
 *                            container can bring it back (the #151 header overflow)
 *  - truncated-unreadable    text cut short with no title carrying the whole of it
 *  - low-contrast            WCAG ratio of text against its composited background
 *                            below 4.5 (3 for large text); grouped by colour pair
 *                            (the #83 dark-theme rows)
 *  - selected-vs-neighbour   background contrast between the selected row and an
 *                            unselected sibling (the #84 "does it stand out" question)
 *
 * No pixels are captured. Colours are resolved through a 1x1 canvas fill, which is
 * only a CSS colour parser: computed styles in Tailwind v4 come back as oklch/oklab.
 */
export function auditInPage(): string[] {
  const CAP = 25;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  type RGBA = [number, number, number, number];
  const parse = (css: string): RGBA => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (top: RGBA, under: RGBA): RGBA => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  };
  const lum = (c: RGBA) => {
    const f = (v: number) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: RGBA, b: RGBA) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = (c: RGBA) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  /** The colour actually behind an element: its own and its ancestors' backgrounds, composited. */
  const background = (el: Element | null): RGBA | null => {
    const layers: RGBA[] = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage !== "none") return null; // a gradient or image: not decidable here
      const c = parse(s.backgroundColor);
      if (c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
    }
    let base: RGBA = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  const opacity = (el: Element) => {
    let o = 1;
    for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  const label = (el: Element) => {
    const t = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
    return `${el.tagName.toLowerCase()}${t ? ` "${t}"` : ""}`;
  };
  const shown = (el: Element) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true });

  const lines: string[] = [];
  const capped = (prefix: string, items: string[]) => {
    const sorted = [...new Set(items)].sort();
    lines.push(...sorted.slice(0, CAP));
    if (sorted.length > CAP) lines.push(`${prefix} ... ${sorted.length - CAP} more`);
  };

  const se = document.scrollingElement!;
  if (se.scrollWidth > vw + 1) lines.push(`page-scrolls-sideways width=${se.scrollWidth} viewport=${vw}`);

  const cutOff: string[] = [];
  const controls = document.querySelectorAll(
    "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=checkbox]",
  );
  for (const el of controls) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue; // visually-hidden inputs behind styled labels
    let why: string | null = null;
    let scrollable = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/auto|scroll/.test(s.overflowX + " " + s.overflowY)) {
        scrollable = true;
        break;
      }
      if (/hidden|clip/.test(s.overflowX + " " + s.overflowY)) {
        const pr = p.getBoundingClientRect();
        if (r.right > pr.right + 1 || r.left < pr.left - 1 || r.bottom > pr.bottom + 1 || r.top < pr.top - 1) {
          why = `clipped-by-${p.tagName.toLowerCase()}`;
          break;
        }
      }
    }
    if (!why && !scrollable && (r.right > vw + 1 || r.left < -1 || r.top > vh + 1)) why = "outside-viewport";
    if (why) cutOff.push(`control-cut-off ${label(el)} ${why} x=${Math.round(r.left)}..${Math.round(r.right)} vw=${vw}`);
  }
  capped("control-cut-off", cutOff);

  const texty = [...document.querySelectorAll("body *")].filter(
    (e) => [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim()) && shown(e),
  ) as HTMLElement[];

  const truncated: string[] = [];
  for (const el of texty) {
    if (el.clientWidth === 0) continue;
    const s = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 1 && /hidden|clip/.test(s.overflowX) && !el.closest("[title]")) {
      truncated.push(`truncated-unreadable ${label(el)} ${el.scrollWidth}>${el.clientWidth}`);
    }
  }
  capped("truncated-unreadable", truncated);

  const pairs = new Map<string, { n: number; eg: string }>();
  for (const el of texty) {
    if (el.closest(":disabled, [aria-disabled=true]")) continue; // WCAG exempts inactive controls
    const s = getComputedStyle(el);
    const bg = background(el);
    if (!bg) continue;
    const fg = parse(s.color);
    fg[3] *= opacity(el);
    const cr = ratio(over(fg, bg), bg);
    const px = parseFloat(s.fontSize);
    const need = px >= 24 || (Number(s.fontWeight) >= 700 && px >= 18.66) ? 3 : 4.5;
    if (cr >= need) continue;
    const key = `low-contrast ${cr.toFixed(1)}<${need} fg=${hex(over(fg, bg))} bg=${hex(bg)}`;
    const seen = pairs.get(key);
    if (seen) seen.n += 1;
    else pairs.set(key, { n: 1, eg: label(el) });
  }
  capped("low-contrast", [...pairs].map(([k, v]) => `${k} x${v.n} e.g. ${v.eg}`));

  const selected: string[] = [];
  for (const el of document.querySelectorAll('[aria-current="true"], [aria-current="page"]')) {
    if (!shown(el)) continue;
    const group = el.closest("ul, ol, nav, aside, [role=list], [role=listbox]") ?? el.parentElement;
    const neighbour = [...(group?.querySelectorAll(el.tagName) ?? [])].find(
      (c) => c !== el && !c.hasAttribute("aria-current") && shown(c),
    );
    const a = background(el);
    const b = neighbour ? background(neighbour) : null;
    if (!a || !b) continue;
    const inset = /inset/.test(getComputedStyle(el).boxShadow) ? " inset-ring" : "";
    selected.push(`selected-vs-neighbour ${label(el)} bg-contrast=${ratio(a, b).toFixed(2)}${inset}`);
  }
  capped("selected-vs-neighbour", selected);

  return lines;
}

/** Make two renders of different builds comparable: the clock is frozen, but the version string is not. */
export function normalise(text: string): string {
  return text
    .replace(/v\d+\.\d+\.\d+/g, "v<version>")
    .replace(/\[ref=e\d+\]/g, "");
}
