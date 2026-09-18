/**
 * The render tier's pass/fail policy, shared by render-diff.spec.ts (and future
 * scenario specs against known bugs).
 *
 * A finding fails the gate when head has it and base does not. What counts as "the
 * same finding" leaves out the parts that legitimately move when an update adds or
 * rearranges content: how many elements share a colour pair, which element is
 * quoted as the example, and the pixel positions of a clipped control.
 *
 * The width a finding was measured at stays in its identity: a control cut off at
 * 1024 px on head is not excused by the same control cut off at 1280 px on base.
 */

const FINDING = /^(page-scrolls-sideways|control-cut-off|truncated-unreadable|low-contrast|surface-unavailable|pageerror)\b/;

/** The identity of one audit line, or null when the line is not a finding. */
export function findingKey(line: string): string | null {
  if (!FINDING.test(line)) return null;
  return line
    .replace(/ x\d+ e\.g\. .*$/, "") // low-contrast: element count and example
    .replace(/ x=-?\d+\.\.-?\d+ vw=\d+$/, "") // control-cut-off: positions
    .replace(/ \d+>\d+$/, "") // truncated-unreadable: measured widths
    .replace(/^page-scrolls-sideways width=\d+/, "page-scrolls-sideways"); // how far it overflows
}

/**
 * The finding lines of a surface record, each prefixed with the width it was
 * measured at. ARIA sections are skipped: structure is reported, never judged.
 * Lines outside any section (page errors, an unavailable surface) are findings
 * in their own right.
 */
export function auditLines(record: string): string[] {
  const out: string[] = [];
  let section = "";
  for (const line of record.split("\n")) {
    if (line.startsWith("## ")) {
      section = line.slice(3);
      continue;
    }
    if (section === "aria") continue;
    const width = section.startsWith("audit @") ? section.slice("audit ".length) + " " : "";
    if (FINDING.test(line)) out.push(width + line);
  }
  return out;
}

/** Findings head has that base does not, by identity, each reported once. */
export function newFindings(base: string[], head: string[]): string[] {
  const identity = (l: string) => {
    const width = l.startsWith("@") ? l.slice(0, l.indexOf(" ") + 1) : "";
    const key = findingKey(width ? l.slice(width.length) : l);
    return key === null ? null : width + key;
  };
  const known = new Set(base.map(identity).filter((k): k is string => k !== null));
  const fresh = new Set<string>();
  for (const l of head) {
    const k = identity(l);
    if (k !== null && !known.has(k)) fresh.add(k);
  }
  return [...fresh];
}
