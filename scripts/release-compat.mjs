#!/usr/bin/env node
// Is this branch compatible with the build the lab runs?
//
//   pnpm test:compat                        the release in use (IN_USE_RELEASE)
//   pnpm test:compat app-v0.18.0 [more…]    the releases named (any tag or ref)
//
// For each release, runs tests/compat against that release's own tagged source
// and this working tree: a database each one wrote, opened and worked on by the
// other, through upgrade, rollback, backup revert and sync. See
// docs/release_compat.md.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IN_USE_RELEASE, releasesToTest } from "./compat-releases.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const releases = releasesToTest(process.argv.slice(2));

const results = [];
for (const release of releases) {
  console.log(`\n=== Compatibility with ${release}${release === IN_USE_RELEASE ? " (in use at the lab)" : ""} ===`);
  const run = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.compat.config.ts"],
    { cwd: ROOT, stdio: "inherit", env: { ...process.env, COMPAT_RELEASE: release } },
  );
  results.push([release, run.status === 0]);
}

console.log("");
for (const [release, ok] of results) {
  console.log(`${ok ? "✓" : "✗"} ${release}: ${ok ? "compatible, both directions" : "NOT compatible — see above"}`);
}
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
