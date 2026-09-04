import { useMemo, useState } from "react";
import { Check, Palette, RotateCcw, X } from "lucide-react";
import { Button } from "./ui";
import { THEME_OPTIONS } from "../lib/themes";
import {
  contrastWarnings,
  isDarkPalette,
  readThemePalette,
  THEME_VAR_GROUPS,
  toHex,
  type Palette as ThemePalette,
} from "../lib/theme";

/**
 * Build a theme and watch the board change as you do it.
 *
 * A DOCKED panel, not a dialog, and that is the whole design. The theme picker
 * has always lived in the Settings modal, which covers the board — so you chose
 * a colour, closed the dialog, looked, and opened it again. You cannot tune a
 * palette that way, because the thing you are judging is the board with real
 * cards on it, not a swatch.
 *
 * This sits in the same slot as the details drawers, with the same resize
 * handle, so the board stays beside it and stays live. Every change is applied
 * to `:root` the instant it is made: there is no preview surface, because the
 * app IS the preview.
 */
export function ThemeCustomizerPanel({
  palette,
  onChange,
  onSave,
  onCancel,
  width,
}: {
  palette: ThemePalette;
  /** Applied immediately — this is what makes the board the preview. */
  onChange: (next: ThemePalette) => void;
  onSave: () => void;
  onCancel: () => void;
  width: number;
}) {
  const [startFrom, setStartFrom] = useState("");
  const warnings = useMemo(() => contrastWarnings(palette), [palette]);
  const dark = isDarkPalette(palette);

  function set(name: string, value: string) {
    const hex = toHex(value);
    // A half-typed hex ("#12") is not a colour yet. Ignoring it rather than
    // applying black keeps the board steady while somebody types.
    if (!hex) return;
    onChange({ ...palette, [name]: hex });
  }

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-l border-line bg-panel"
      style={{ width }}
      aria-label="Theme customizer"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <Palette size={16} /> Custom theme
          </h2>
          <p className="text-xs text-ink-faint">
            The board updates as you pick · reads as {dark ? "dark" : "light"}
          </p>
        </div>
        <button
          onClick={onCancel}
          aria-label="Close without saving"
          className="rounded-md p-1 text-ink-faint hover:bg-black/5 hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto thin-scroll px-4 py-3">
        {/* Start from an existing theme rather than from nothing. Most people
            want "our blue instead of that blue", which is one change to an
            existing palette, not eleven decisions from black. */}
        <label className="mb-4 block">
          <span className="mb-1.5 block text-xs font-medium text-ink-soft">Start from</span>
          <select
            aria-label="Start from an existing theme"
            value={startFrom}
            onChange={(event) => {
              const theme = event.target.value;
              setStartFrom(theme);
              if (theme) onChange(readThemePalette(theme));
            }}
            className="w-full cursor-pointer rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-brand"
          >
            <option value="">Pick a theme to copy…</option>
            {THEME_OPTIONS.filter((option) => option.value !== "system").map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {THEME_VAR_GROUPS.map((group) => (
          <section key={group.title} className="mb-4">
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              {group.title}
            </h3>
            <div className="space-y-1.5">
              {group.vars.map((v) => (
                <div key={v.name} className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={v.label}
                    value={palette[v.name] ?? "#000000"}
                    onChange={(event) => set(v.name, event.target.value)}
                    className="h-7 w-10 shrink-0 cursor-pointer rounded border border-line bg-transparent p-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-ink">{v.label}</div>
                    <div className="truncate text-[10px] text-ink-faint">{v.hint}</div>
                  </div>
                  {/* The text field is not decoration: a lab with a brand colour
                      has it written down as a hex string, and typing it beats
                      hunting for it in a colour wheel. */}
                  <input
                    type="text"
                    aria-label={`${v.label} hex`}
                    value={palette[v.name] ?? ""}
                    onChange={(event) => set(v.name, event.target.value)}
                    spellCheck={false}
                    className="w-20 shrink-0 rounded border border-line bg-white px-1.5 py-1 font-mono text-[11px] text-ink outline-none focus:border-brand"
                  />
                </div>
              ))}
            </div>
          </section>
        ))}

        {/* Warn, never block. A lab that wants a low-contrast theme for a dark
            room can have one; it just should not get one by accident, which is
            what happens when eleven colours are picked one at a time and only
            the last combination is ever looked at. */}
        {warnings.length > 0 && (
          <div
            role="status"
            aria-label="Contrast warnings"
            className="rounded-md border border-amber-400/60 bg-amber-50/60 px-2.5 py-2"
          >
            <p className="text-[11px] font-semibold text-amber-800">
              Hard to read ({warnings.length})
            </p>
            <ul className="mt-1 space-y-0.5">
              {warnings.map((w) => (
                <li key={w.label} className="text-[11px] text-amber-800">
                  {w.label} — {w.ratio.toFixed(1)}:1, wants {w.min}:1
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[10px] text-amber-800/80">
              You can save anyway. This is a warning, not a rule.
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        <Button variant="primary" className="flex-1" onClick={onSave}>
          <Check size={15} /> Save theme
        </Button>
        <Button variant="ghost" onClick={onCancel} title="Discard and go back to the previous theme">
          <RotateCcw size={15} /> Discard
        </Button>
      </div>
    </aside>
  );
}
