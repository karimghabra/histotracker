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
