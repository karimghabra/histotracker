#!/usr/bin/env node
// Release integrity: every release is cut from master, and master says what ships.
//
//   node scripts/release-check.mjs versions      the five version sources agree
//   node scripts/release-check.mjs provenance    every release tag is in HEAD's history,
//                                                and HEAD is not behind the newest release
//   node scripts/release-check.mjs plan          may the installer workflow publish HEAD?
//
// Why this exists: 0.14.3 through 0.17.0 were published from `claude/**` branches
// that were never merged back, so for a month master (0.13.2) and the build the
// lab ran (0.17.0) were two different codebases and nothing said so. Each check
// below is one of the ways that went unnoticed. See docs/releasing.md and
// docs/release_line_reconciliation.md.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The one branch releases are cut from. */
export const RELEASE_BRANCH = "master";
/** Tags the installer workflow creates, `app-v<version>` (tauri-action `tagName`). */
export const TAG_PREFIX = "app-v";

// ---- versions ---------------------------------------------------------------

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(text) {
  const m = VERSION.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative, zero or positive, as `a` sorts before, level with or after `b`. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** `app-v0.17.0` -> `0.17.0`; anything else -> null. */
export function tagVersion(tag) {
  if (!tag.startsWith(TAG_PREFIX)) return null;
  const version = tag.slice(TAG_PREFIX.length);
  return parseVersion(version) ? version : null;
}

/**
 * Every place the app's version is written down, read through `read(path)`.
 *
 * They are one number and are bumped together; a release cut with them out of
 * step names itself one thing in the installer and another in the app.
 */
export function readVersionSources(read) {
  const sources = [];
  const add = (file, what, fn) => {
    let value = null;
    try {
      value = fn(read(file));
    } catch {
      value = null;
    }
    sources.push({ file, what, value });
  };
  add("package.json", "version", (t) => JSON.parse(t).version ?? null);
  add("src-tauri/tauri.conf.json", "version", (t) => JSON.parse(t).version ?? null);
  add("src-tauri/Cargo.toml", "[package] version", (t) => {
    const pkg = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(t);
    return pkg ? (/^version\s*=\s*"([^"]+)"/m.exec(pkg[1])?.[1] ?? null) : null;
  });
  add("src-tauri/Cargo.lock", 'package "histometer"', (t) => {
    const m = /\[\[package\]\]\s*\nname = "histometer"\s*\nversion = "([^"]+)"/.exec(t);
    return m ? m[1] : null;
  });
  add("package-lock.json", "version", (t) => JSON.parse(t).version ?? null);
  add("package-lock.json", 'packages[""].version', (t) => JSON.parse(t).packages?.[""]?.version ?? null);
  return sources;
}

/** The agreed version, or the list of problems. */
export function checkVersions(sources) {
  const problems = [];
  for (const s of sources) {
    if (s.value == null) problems.push(`${s.file}: no ${s.what} found`);
    else if (!parseVersion(s.value)) problems.push(`${s.file}: ${s.what} "${s.value}" is not x.y.z`);
  }
  const values = [...new Set(sources.map((s) => s.value).filter(Boolean))];
  if (values.length > 1) {
    problems.push(
      `the version sources disagree: ${sources.map((s) => `${s.file} ${s.what} = ${s.value}`).join("; ")}`,
    );
  }
  return { version: problems.length === 0 ? values[0] : null, problems };
}

/** True when `text` has a level-2 heading for `version`: `## 0.18.0` or `## 0.18.0 - unreleased`. */
export function hasChangelogSection(text, version) {
  return new RegExp(`^## ${version.replaceAll(".", "\\.")}(?:\\s|$)`, "m").test(text);
}

// ---- git --------------------------------------------------------------------

export function makeGit(cwd) {
  const run = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return {
    /** True when `ancestor` is in the history of `descendant` (or is it). */
    isAncestor(ancestor, descendant) {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: "ignore" });
        return true;
      } catch (err) {
        if (err.status === 1) return false;
        throw new Error(`git merge-base --is-ancestor ${ancestor} ${descendant} failed`);
      }
    },
    releaseTags() {
      const out = run("tag", "--list", `${TAG_PREFIX}*`);
      return out ? out.split("\n").filter((t) => tagVersion(t)) : [];
    },
    commitOf(ref) {
      return run("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    },
    isShallow() {
      return run("rev-parse", "--is-shallow-repository") === "true";
    },
  };
}

/** The newest release tag by version, or null when nothing has been released. */
export function newestRelease(tags) {
  let best = null;
  for (const tag of tags) {
    const v = tagVersion(tag);
    if (v && (!best || compareVersions(v, best.version) > 0)) best = { tag, version: v };
  }
  return best;
}

/**
 * Does `head` account for every release?
 *
 *  - Every `app-v*` tag must be in head's history. A tag that is not was cut from
 *    a commit master never received: the lab can be running code the trunk does
 *    not have, which is exactly how 0.14.3 to 0.17.0 happened.
 *  - head's version must not be behind the newest release. Master declaring
 *    0.13.2 while 0.17.0 was installed is what let a branch off master number
 *    itself 0.14.0.
 */
export function checkProvenance(git, head, headVersion) {
  const problems = [];
  const tags = git.releaseTags();
  for (const tag of tags) {
    if (!git.isAncestor(tag, head)) {
      const commit = git.commitOf(tag);
      problems.push(
        `${tag} (commit ${commit.slice(0, 12)}) is not in ${RELEASE_BRANCH}'s history: that release was not ` +
          `cut from ${RELEASE_BRANCH}, and ${RELEASE_BRANCH} does not contain the code the lab may be running. ` +
          `Merge ${commit.slice(0, 12)} into ${RELEASE_BRANCH} (never rebase a released commit), or withdraw the release.`,
      );
    }
  }
  const newest = newestRelease(tags);
  if (newest && headVersion && compareVersions(headVersion, newest.version) < 0) {
    problems.push(
      `${RELEASE_BRANCH} declares ${headVersion} but ${newest.tag} is already released: ` +
        `the trunk is behind what ships. Bring ${newest.tag} into ${RELEASE_BRANCH} and move the version forward.`,
    );
  }
  return { tags, newest, problems };
}

/**
 * May the installer workflow publish `head` as a release?
 *
 * Returns { publish, version, tag, problems }; any problem fails the run.
 */
export function planRelease({ git, ref, head, read }) {
  const problems = [];
  if (ref !== `refs/heads/${RELEASE_BRANCH}`) {
    problems.push(
      `releases are cut from ${RELEASE_BRANCH} only, and this run is for ${ref || "an unknown ref"}. ` +
        `Merge the change into ${RELEASE_BRANCH}; the release is built from there.`,
    );
  }
  const { version, problems: versionProblems } = checkVersions(readVersionSources(read));
  problems.push(...versionProblems);
  if (version) {
    let changelog = null;
    try {
      changelog = read("CHANGELOG.md");
    } catch {
      changelog = null;
    }
    if (changelog == null || !hasChangelogSection(changelog, version)) {
      problems.push(
        `CHANGELOG.md has no section for ${version}: add a "## ${version}" section with what the release ` +
          `ships before cutting it (docs/releasing.md).`,
      );
    }
  }
  const provenance = checkProvenance(git, head, version);
  problems.push(...provenance.problems);
  const tag = version ? `${TAG_PREFIX}${version}` : null;
  let publish = false;
  if (version && problems.length === 0) {
    const existing = provenance.tags.includes(tag) ? git.commitOf(tag) : null;
    if (existing) {
      const where = existing === head ? "from this commit" : `from ${existing.slice(0, 12)}`;
      problems.push(
        `${tag} is already released ${where}. A release is never rebuilt or overwritten: ` +
          `to ship this commit, bump the version (package.json, src-tauri/tauri.conf.json, ` +
          `src-tauri/Cargo.toml and both lockfiles) and merge that to ${RELEASE_BRANCH}.`,
      );
    } else {
      // Newer than every release, necessarily: a lower version was refused by
      // checkProvenance as "behind", and an equal one has its tag.
      publish = true;
    }
  }
  return { publish, version, tag, problems };
}

// ---- command line -------------------------------------------------------------

function report(problems) {
  const inActions = process.env.GITHUB_ACTIONS === "true";
  for (const problem of problems) console.error(inActions ? `::error title=Release::${problem}` : `✗ ${problem}`);
}

function setOutputs(outputs) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const git = makeGit(root);
  const readTree = (path) => readFileSync(join(root, path), "utf8");
  const [command] = argv;

  if (command === "versions") {
    const { version, problems } = checkVersions(readVersionSources(readTree));
    report(problems);
    if (problems.length) return 1;
    console.log(`✓ every version source says ${version}`);
    return 0;
  }

  if (command === "provenance" || command === "plan") {
    if (git.isShallow()) {
      report(["this is a shallow clone, so release tags cannot be traced; check out with fetch-depth: 0"]);
      return 1;
    }
    const head = git.commitOf("HEAD");
    if (command === "provenance") {
      const { version } = checkVersions(readVersionSources(readTree));
      const { tags, newest, problems } = checkProvenance(git, head, version);
      report(problems);
      if (problems.length) return 1;
      console.log(
        `✓ all ${tags.length} release tags are in this history` +
          (newest ? `; the newest is ${newest.tag} and this tree declares ${version}` : ""),
      );
      return 0;
    }
    const plan = planRelease({ git, ref: process.env.GITHUB_REF ?? "", head, read: readTree });
    report(plan.problems);
    setOutputs({ publish: plan.publish, version: plan.version ?? "", tag: plan.tag ?? "" });
    if (plan.problems.length) return 1;
    console.log(`✓ ${plan.tag} will be published from ${head.slice(0, 12)}`);
    return 0;
  }

  console.error("usage: node scripts/release-check.mjs versions | provenance | plan");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
