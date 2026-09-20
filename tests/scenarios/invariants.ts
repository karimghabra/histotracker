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

/**
 * Slides sitting in a staining rack with no cut date; empty means the rack holds
 * only glass that exists.
 *
 * The same read as stress2's `racked-slide-was-cut` invariant, kept here so a
 * scenario can sweep for it without a browser: a rack is where a slide is worked
 * on, and a slide that was never cut has nothing to work on.
 */
export function rackedButNeverCut(l: Lab): string[] {
  return l
    .rows(
      `SELECT sl.slide_code, sl.stack_id FROM slides sl
         JOIN slide_stacks st ON st.id = sl.stack_id
        WHERE st.kind = 'stain' AND sl.purpose = 'stain'
          AND sl.current_stage <> 'removed' AND sl.stage_cut_at IS NULL`,
    )
    .map((r) => `${r.slide_code} is in rack ${r.stack_id} but was never cut`);
}
