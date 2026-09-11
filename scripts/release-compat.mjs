#!/usr/bin/env node
// Is this branch compatible with the builds the lab runs?
//
//   pnpm test:compat                        the release in use + the newest release
//   pnpm test:compat app-v0.18.0 [more…]    the releases named (any tag or ref)
//
// For each release, runs tests/compat against that release's own tagged source
// and this working tree: a database each one wrote, opened and worked on by the
// other, through upgrade, rollback, backup revert and sync. See
// docs/release_compat.md.

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The release installed at the lab. Bump it when the lab installs a new one;
 * a PR is judged against this build first.
 */
const IN_USE_RELEASE = "app-v0.17.0";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function releaseTags() {
  const parse = (out) => out.split("\n").map((l) => l.trim().split(/\s+/).pop()?.replace("refs/tags/", "")).filter(Boolean);
  try {
    return parse(execFileSync("git", ["ls-remote", "--tags", "--refs", "origin", "app-v*"], { cwd: ROOT, encoding: "utf8" }));
  } catch {
    return parse(execFileSync("git", ["tag", "--list", "app-v*"], { cwd: ROOT, encoding: "utf8" }));
  }
}

function newestRelease() {
  const key = (tag) => tag.replace(/^app-v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const newer = (a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
    }
    return false;
  };
  return releaseTags().filter((t) => /^app-v\d/.test(t)).reduce((best, t) => (!best || newer(t, best) ? t : best), "");
}

const named = process.argv.slice(2);
const releases = named.length ? named : [IN_USE_RELEASE];
if (!named.length) {
  const newest = newestRelease();
  if (newest && newest !== IN_USE_RELEASE) {
    console.log(`A newer release than the one in use exists (${newest}); checking it too.`);
    releases.push(newest);
  }
}

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
