// Record invariants a scenario can sweep after it has done whatever it does (A3).
import type { Lab } from "./lab";

/** Stamps that say glass was worked on. None can be true of a slide that was never cut. */
export const WORK_AFTER_CUT = [
  "stage_staining_started_at",
  "stage_deparaffinized_at",
  "stage_stained_at",
  "stage_refrax_at",
  "stage_coverslipped_at",
  "stage_dried_at",
  "stage_ready_for_imaging_at",
  "stage_pictures_taken_at",
  "stage_analyzed_at",
];

/** Live slides that carry a work stamp but no cut date; empty means the record is straight. */
export function workedButNeverCut(l: Lab): string[] {
  return l
    .rows(
      `SELECT slide_code, ${WORK_AFTER_CUT.join(", ")} FROM slides
        WHERE current_stage <> 'removed' AND stage_cut_at IS NULL
          AND (${WORK_AFTER_CUT.map((c) => `${c} IS NOT NULL`).join(" OR ")})`,
    )
    .map((r) => `${r.slide_code} never cut but ${WORK_AFTER_CUT.filter((c) => r[c]).join(", ")}`);
}
