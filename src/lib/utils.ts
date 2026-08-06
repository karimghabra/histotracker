import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function nowTimestamp(): string {
  // Matches the prototype's "YYYY-MM-DD HH:MM" storage format.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  // Stored as "YYYY-MM-DD HH:MM"; make it ISO-ish for the Date constructor.
  const parsed = new Date(value.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Spreadsheet-style lowercase labels: 1 -> a, 26 -> z, 27 -> aa. */
export function duplicateLabel(ordinal: number): string {
  let value = Math.max(1, Math.floor(ordinal));
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(97 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

/**
 * The STORED form of a sample code — zero-padded to four digits ("EE-0001").
 * ONE definition, used by the preview, the insert and the project-move re-mint,
 * so those can never disagree about the shape.
 *
 * Storage stays padded deliberately (#87). The padding is what makes the code a
 * stable, fixed-width identifier: it is embedded verbatim in every slide code, in
 * `stain_requests`, in audit summaries and in the synced payload. Changing the
 * stored form would fork the identity of every existing sample. The leading zeros
 * are a DISPLAY concern only — see {@link displayCode}, which strips them
 * everywhere the user reads a code, including for samples cut years ago.
 */
export function formatSampleCode(projectCode: string, sampleNumber: number): string {
  return `${projectCode.trim().toUpperCase()}-${String(sampleNumber).padStart(4, "0")}`;
}

/**
 * The DISPLAYED form of any sample or slide code: the same code without its
 * leading zeros (#87).
 *
 * "EE-0001" → "EE-1", "EE-0022-A" → "EE-22-A". Purely cosmetic and applied at
 * render time, so it fixes codes retroactively — a block logged last year shows
 * the short form immediately, with nothing written to the database. Only the
 * leading numeric run is touched; a slide's letter suffix is left alone.
 */
export function displayCode(code: string): string {
  return (code ?? "").replace(/^([A-Za-z]+)-0*(\d+)/, (_m, prefix, digits) => `${prefix}-${Number(digits)}`);
}

/**
 * The letter a slide actually carries, taken from its code ("EE-0001-C" → "C").
 *
 * Not `duplicateLabel(slide_ordinal)`: slide_ordinal is a PER-SECTION counter
 * that restarts at 1 for every cut group, so the second group's slides reported
 * "Duplicate A, B" while their codes read E, F (#75). The code is the label the
 * bench wrote on the physical slide, so it is the authority.
 */
export function slideLetterOf(slideCode: string): string {
  return /-([A-Za-z]+)$/.exec((slideCode ?? "").trim())?.[1]?.toUpperCase() ?? "";
}

/**
 * Strip leading zeros from EVERY code embedded in a longer string.
 *
 * Some summaries are composed in SQL — `slide_summary` is a GROUP_CONCAT like
 * "EE-0001-B: Stain: H&E · EE-0002-A: IHC: CD31" — so the codes sit mid-text
 * where {@link displayCode}'s anchored match cannot reach them. Matching
 * requires letters, a hyphen and digits, so ordinary prose is left alone.
 */
export function displayCodesInText(text: string): string {
  return (text ?? "").replace(
    /\b([A-Za-z]{1,6})-0+(\d+)/g,
    (_m, prefix, digits) => `${prefix}-${Number(digits)}`,
  );
}

/** Split "EE-0007" or "EE-7" into its prefix and number; null if not a code. */
export function parseSampleCode(code: string): { prefix: string; number: number } | null {
  const match = /^(.*)-0*(\d+)$/.exec((code ?? "").trim());
  return match ? { prefix: match[1], number: Number(match[2]) } : null;
}

/**
 * Every spelling of the same sample identity, for padding-insensitive lookup.
 *
 * A database can hold both "EE-0001" (minted before this change) and "EE-2"
 * (after). Anything resolving a code typed by a human, or arriving in a synced
 * request written by an instance on a different build, must accept both — the
 * lookups fail CLOSED and SILENTLY, so a miss quietly drops work.
 */
export function sampleCodeVariants(code: string): string[] {
  const parsed = parseSampleCode(code);
  const raw = (code ?? "").trim();
  if (!parsed) return [raw];
  return [
    ...new Set([
      `${parsed.prefix}-${parsed.number}`,
      `${parsed.prefix}-${String(parsed.number).padStart(4, "0")}`,
      raw,
    ]),
  ];
}

/**
 * Order bare sample codes numerically: EE-2 before EE-10, and EE-0001 before
 * EE-2. Deliberately NOT {@link compareSlideCodes} — that one compares the tail
 * by LENGTH first (correct for slide letters, where Z must precede AA) and would
 * sort a padded "EE-0001" after "EE-9".
 */
export function compareSampleCodes(a: string, b: string): number {
  return (a ?? "").localeCompare(b ?? "", undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Order slide codes the way the bench reads them (issue #75).
 *
 * A slide code is `<parent>-<label>` where the label is the bijective base-26
 * sequence from {@link duplicateLabel} (A…Z, AA, AB…). A plain string compare
 * gets that wrong at the wrap — it sorts "AA" before "B" — so compare the parent
 * first, then the label by LENGTH and only then alphabetically. For labels of
 * equal length that is exactly alphabetical order, which is what was asked for,
 * and across lengths it keeps Z before AA instead of burying the 27th slide in
 * the middle of the list.
 */
export function compareSlideCodes(a: string, b: string): number {
  const split = (code: string) => {
    const at = code.lastIndexOf("-");
    return at === -1 ? { parent: code, label: "" } : { parent: code.slice(0, at), label: code.slice(at + 1) };
  };
  const left = split(a ?? "");
  const right = split(b ?? "");
  return (
    left.parent.localeCompare(right.parent, undefined, { numeric: true, sensitivity: "base" }) ||
    left.label.length - right.label.length ||
    left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
  );
}

/**
 * Split a pasted description column into one entry per sample.
 *
 * Blank lines are KEPT in place, because the paste is positional — line 3 is
 * sample 3, and silently closing a gap shifts every following description onto
 * the wrong sample. Trailing blanks are dropped: a spreadsheet column copy ends
 * in a newline, and counting it would report a mismatch on the commonest paste.
 *
 * Both the per-sample rows and the mismatch warning read this one list, so they
 * cannot disagree about what a "line" is (#86).
 */
export function normalizePastedLines(text: string): string[] {
  const lines = (text ?? "").split("\n").map((line) => line.trim());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The description a batch sample ends up with, from the batch-wide field and
 * that sample's own row (#86).
 *
 * The shared field used to be a pure FALLBACK — used only when a row was blank,
 * and thrown away entirely the moment the row had anything in it. So filling in
 * both, which is the natural thing to do, silently discarded the half that was
 * true of every sample: "shared description currently does nothing".
 *
 * It composes instead. The shared part is the thing all the samples have in
 * common ("2 week PLA") and the row is what tells them apart ("left femur"),
 * so the sample reads "2 week PLA | left femur". Either half alone stands on its
 * own; both blank is the one case the caller must refuse, which is #88's rule
 * and is why this returns "" rather than inventing a placeholder.
 */
/**
 * When a slide was physically cut — "" if it has not been cut yet (#95).
 *
 * Slides used to be stamped `stage_cut_at` at INSERT, which is the moment the
 * cut group is *created* and dropped into Needs Sectioning. So a slide read as
 * Cut in the log while the block was still sitting in the queue waiting for
 * somebody to go to the microtome; and undoing a sectioning did not clear it,
 * because the stamp predated the thing being undone. That is the whole of #95:
 * the undo/redo machinery was fine, the timestamp was written too early.
 *
 * The stamp now happens when the group leaves Needs Sectioning. This rule covers
 * the two kinds of row that predate that:
 *   - a group STILL in Needs Sectioning that carries an old creation-time stamp
 *     reports no cut, because it demonstrably has not been cut; and
 *   - a genuinely old slide with no stamp at all (builds before the column was
 *     written) still reports its `created_at`, so its Cut step does not vanish
 *     from a log that has shown it for a year.
 */
export function slideCutAt(slide: {
  stage_cut_at?: string | null;
  created_at?: string | null;
  section_stage?: string | null;
}): string {
  if (slide.section_stage === "needs_sectioning") return "";
  return slide.stage_cut_at || slide.created_at || "";
}

export function composeDescription(shared: string, own: string): string {
  const s = (shared ?? "").trim();
  const o = (own ?? "").trim();
  if (s && o) return `${s} | ${o}`;
  return o || s;
}
