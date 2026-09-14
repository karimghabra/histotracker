#!/usr/bin/env node
// Fails when a lightweight e2e spec takes a screenshot. A capture nobody opens
// on a green run checks nothing (the 2026-09-13 review found 26 in tests/e2e,
// asserted on by none of them); its replacement is an assertion in the spec
// itself. Captures belong in the screenshot tier (tests/screenshot/,
// playwright.screenshot.config.ts), which this does not scan - that is layer 4
// of pnpm verify, and runs only in CI, only once layers 1-3 are green.
//   node scripts/no-unasserted-captures.mjs [dir=tests/e2e]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const dir = process.argv[2] ?? "tests/e2e";
const files = (function walk(d) {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.spec\.ts$/.test(n) ? [p] : [];
  });
})(dir);

const hits = [];
for (const file of files) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (/\.screenshot\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) hits.push(`${relative(process.cwd(), file)}:${i + 1}`);
    });
}
if (!hits.length) {
  console.log(`captures: none in ${files.length} spec files`);
  process.exit(0);
}
console.log(`captures: ${hits.length} unasserted screenshot call(s) in ${new Set(hits.map((h) => h.split(":")[0])).size} of ${files.length} spec files; replace each with an assertion, or move it to tests/screenshot/ (the screenshot tier)`);
for (const h of hits.slice(0, 8)) console.log(`  ${h}`);
if (hits.length > 8) console.log(`  ... ${hits.length - 8} more`);
process.exit(1);
