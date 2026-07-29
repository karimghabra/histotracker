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
