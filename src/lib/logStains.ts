import { parsePreselectedStains } from "./db";
import type { Sample, Slide } from "./types";

/**
 * The stains a block is known to involve — for the Logs table AND its export.
 *
 * #136: "when stains are assigned they do not show up on the log until they
 * have been sectioned." The main screen has always known: the board card flags
 * the block, and the drawer lists a "Requested" row for every agent no slide
 * carries yet. The Logs only ever looked at physical `slides`, so a block
 * sitting in fixative with SafO assigned read as having no stains at all.
 *
 * Both halves of the log go through this one module on purpose. The literal ask
 * was that the log say the same thing as the main screen, and a log you export
 * to a spreadsheet is still the log — so the on-screen table and the CSV/XLSX
 * have to agree by construction, not by two implementations happening to match.
 */

export type AssignedStain = { assay_type: string; assay_name: string };

/**
 * Agents this block has been assigned that no slide carries yet.
 *
 * `preselected_stains` is already maintained as the OUTSTANDING multiset —
 * agents chosen at intake or requested since, minus the ones a cut has since
 * produced (trimmed in createSectionRequests, and translated for older
 * databases by reconcileStainRequests). So it needs no subtraction here; it is
 * exactly what the drawer renders as "Requested".
 *
 * A multiset, not a set: two requests for the same agent are two slides owed,
 * so both are kept (#62/#66), and re-requesting an already-produced agent is a
 * genuine outstanding request again (#41).
 *
 * The Logs assay-type filter reads this directly rather than `logAgents()`,
 * because it matches on `assay_type`, which only survives here.
 *
 * Nothing is outstanding on a block that can no longer be sectioned. An
 * outstanding request says something is still owed; a removed block (#96)
 * cannot be cut, and neither can an exhausted one — it has no tissue left, which
 * is why requestStain refuses it a fresh cut (#70). A row saying "assigned, not
 * cut yet" about either, or a "requested (not cut)" line in the exported
 * spreadsheet, would assert an obligation that can never be met. Glass that was
 * cut is unaffected. An archived block keeps its requests: archiving is a
 * reversible hide (#74) and the tissue is still there to cut.
 */
export function outstandingStains(sample: Sample): AssignedStain[] {
  if (sample.current_stage === "removed" || sample.block_exhausted === 1) return [];
  return parsePreselectedStains(sample.preselected_stains);
}

/** One entry per agent named on a block, in the order the log should read it. */
export type LogAgent = {
  name: string;
  /** True while a request for this agent is still outstanding — no glass yet. */
  requested: boolean;
};

/**
 * Every agent named on a block: the ones its slides carry, then the ones still
 * only assigned. Drives the Logs "Stains / IHC" cell, the stain filter, the
 * search haystack and the stain sort, so all four learn about #136 at once.
 *
 * Deduplicated case-insensitively, cut glass first — an agent that was cut AND
 * re-requested appears once, marked, because the outstanding request is the
 * part a technician still has to act on.
 */
export function logAgents(sample: Sample, slides: Slide[]): LogAgent[] {
  const out: LogAgent[] = [];
  const seen = new Map<string, LogAgent>();
  for (const slide of slides) {
    const name = slide.assay_name;
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    const entry = { name, requested: false };
    seen.set(key, entry);
    out.push(entry);
  }
  for (const agent of outstandingStains(sample)) {
    const key = agent.assay_name.toLowerCase();
    const existing = seen.get(key);
    if (existing) {
      existing.requested = true;
      continue;
    }
    const entry = { name: agent.assay_name, requested: true };
    seen.set(key, entry);
    out.push(entry);
  }
  return out;
}
