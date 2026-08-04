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
