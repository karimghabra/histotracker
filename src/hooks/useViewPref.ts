import { useCallback, useState } from "react";
import { readViewPref, writeViewPref } from "../lib/viewPrefs";

/**
 * `useState`, but the value survives switching between the Board and the Logs
 * (#104). Same signature, so a filter becomes persistent by changing one word.
 *
 * `isValid` guards against a remembered value that no longer means anything —
 * a sort key that has been renamed, say. Without it a stale blob could pin a
 * column to a filter the UI has no option for, which is bug #85's shape.
 */
export function useViewPref<T>(
  key: string,
  initial: T,
  isValid?: (value: unknown) => boolean,
): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readViewPref(key, initial, isValid));
  const set = useCallback(
    (next: T | ((current: T) => T)) => {
      setValue((current) => {
        const resolved =
          typeof next === "function" ? (next as (c: T) => T)(current) : next;
        writeViewPref(key, resolved);
        return resolved;
      });
    },
    [key],
  );
  return [value, set];
}

/**
 * The same, for a Set. JSON has no set type, so it rides as an array — kept
 * here rather than at each call site so the two directions cannot disagree.
 */
export function useViewPrefSet<T extends string>(
  key: string,
  initial: Set<T> = new Set(),
): [Set<T>, (next: Set<T> | ((current: Set<T>) => Set<T>)) => void] {
  const [value, setValue] = useState<Set<T>>(() => {
    const stored = readViewPref<unknown>(key, null);
    return Array.isArray(stored) ? new Set(stored as T[]) : initial;
  });
  const set = useCallback(
    (next: Set<T> | ((current: Set<T>) => Set<T>)) => {
      setValue((current) => {
        const resolved =
          typeof next === "function" ? (next as (c: Set<T>) => Set<T>)(current) : next;
        writeViewPref(key, [...resolved]);
        return resolved;
      });
    },
    [key],
  );
  return [value, set];
}
