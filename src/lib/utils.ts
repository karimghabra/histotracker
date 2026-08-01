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
 * Format a sample code. ONE definition, used by the preview, the insert and the
 * project-move re-mint, so those can never disagree about the shape (#87).
 *
 * Codes used to be zero-padded to four digits ("EE-0001"), inherited from the
 * Python prototype. New codes are minted unpadded ("EE-1"); existing rows keep
 * whatever they were given, which is why everything that MATCHES or SORTS a code
 * has to be padding-insensitive — see {@link sampleCodeVariants} and
 * {@link compareSampleCodes}.
 */
export function formatSampleCode(projectCode: string, sampleNumber: number): string {
  return `${projectCode.trim().toUpperCase()}-${sampleNumber}`;
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
