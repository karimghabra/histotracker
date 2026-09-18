#!/usr/bin/env node
// Is the production bundle the app? `vite build` exiting 0 is not enough: a
// vite.config.ts that lost its Tailwind plugin builds green and ships an
// unstyled app, and every browser suite serves vite.config.playwright.ts
// instead, so none of them would see it (2026-09-13 review, G1).
//   node scripts/bundle-check.mjs <dist dir>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dist = process.argv[2];
if (!dist) {
  console.error("usage: node scripts/bundle-check.mjs <dist dir>");
  process.exit(2);
}
const problems = [];
const html = existsSync(join(dist, "index.html")) ? readFileSync(join(dist, "index.html"), "utf8") : "";
if (!html) problems.push("no index.html");
const assets = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
for (const a of assets) if (!existsSync(join(dist, a))) problems.push(`index.html names ${a}, which is missing`);
const read = (ext) => assets.filter((a) => a.endsWith(ext)).map((a) => readFileSync(join(dist, a), "utf8")).join("\n");
const css = read(".css");
const js = read(".js");

// Utilities the board is drawn with, one of them from the theme tokens index.css defines.
for (const cls of [".rounded-lg", ".flex", ".bg-panel", ".text-ink"]) {
  if (!css.includes(`${cls}{`) && !css.includes(`${cls} {`)) problems.push(`css has no ${cls} rule`);
}
for (const raw of ["@tailwind", "@apply", "@theme"]) if (css.includes(raw)) problems.push(`css still holds raw ${raw}`);
if (!js.includes("Open Histology Workflow")) problems.push("js does not hold the board");
// The sql.js Tauri shim is test code; vite.config.playwright.ts aliases it in, production must not.
for (const marker of ["__SHIM_SQL__", "__SHIM_SELECT__", "sql-wasm"]) if (js.includes(marker)) problems.push(`js ships test shim (${marker})`);

const kb = (s) => Math.round(Buffer.byteLength(s) / 1024);
if (problems.length) {
  console.log(`bundle FAIL: ${problems.length} problem(s), css ${kb(css)} KB, js ${kb(js)} KB`);
  for (const p of problems.slice(0, 6)) console.log(`  ${p}`);
  process.exit(1);
}
console.log(`bundle ok: css ${kb(css)} KB, js ${kb(js)} KB`);
