/**
 * What does a green pull request prove here?
 *
 * tests/suites.json lists every test suite and says whether the pull-request
 * workflows run it. This checks that list against the tree and those
 * workflows, and fails when they disagree:
 *
 *   - every package.json script is a suite or is named as something else;
 *   - every directory under tests/ and every vitest or Playwright config
 *     belongs to a suite, or is named as support;
 *   - a suite said to run on a pull request is actually invoked by one of the
 *     workflows, and one that is not says why.
 *
 * So a new suite cannot land unrun without somebody writing down why, and the
 * list of suites CI does not run is always true. That list is printed,
 * appended to a markdown file (the job summary), and, with --pr, posted on
 * the pull request as one comment kept up to date, so a green check never
 * claims coverage it does not have.
 *
 *   node scripts/test-coverage.mjs [--root DIR] [--markdown FILE] [--pr NUMBER]
 *
 * --pr needs GH_TOKEN (or GITHUB_TOKEN) and GITHUB_REPOSITORY; GITHUB_API_URL
 * is honoured, which is how the tests point it at a fake. Node built-ins only,
 * so CI runs it without installing anything.
 *
 * This is the same mechanism as projtracker's scripts/test-coverage.mjs, and
 * is meant to read the same way. Three things differ, because this repository
 * does: it gates on more than one workflow ("workflows" is a list), a suite
 * may be a command rather than a package.json script ("notAScript", which is
 * how the Rust shell and the typecheck are accounted for), and a directory
 * under tests/ may be shared support rather than a suite ("otherPaths").
 */

import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST = "tests/suites.json";
/** Marks the pull-request comment this script owns, so it edits it rather than adding another. */
const MARKER = "<!-- histometer:suites -->";
const CONFIG = /^(vitest|playwright)(\.[\w-]+)?\.config\.(ts|mts|cts|js|mjs|cjs)$/;

function parseArgs(argv) {
  const args = { root: process.cwd(), markdown: null, pr: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--root" || flag === "--markdown" || flag === "--pr") {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      args[flag.slice(2)] = value;
      i++;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${what} (${path}): ${error.message}`);
  }
}

/** The workflows' own lines, without comments: a command mentioned only in a comment does not run. */
function workflowLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .filter((line) => line.trim() !== "");
}

function invokes(lines, command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[\\s;&|:])${escaped}($|[\\s;&|])`);
  return lines.some((line) => pattern.test(line));
}

/** How a suite is written in the report: a package.json script is run with pnpm, a command is itself. */
function invocation(name, suite) {
  return suite.notAScript ? name : `pnpm ${name}`;
}

/** Everything wrong with the manifest, as sentences a person can act on. Empty when it is true. */
function check(root, manifest) {
  const problems = [];
  const suites = manifest.suites ?? {};
  const others = manifest.otherScripts ?? {};
  const otherPaths = manifest.otherPaths ?? {};
  const scripts = Object.keys(readJson(join(root, "package.json"), "package.json").scripts ?? {});

  for (const name of scripts) {
    if (!(name in suites) && !(name in others)) {
      problems.push(
        `The package.json script "${name}" is not in ${MANIFEST}. Add it under "suites" if it tests anything, saying whether pull-request CI runs it, or under "otherScripts" with what it does.`,
      );
    }
    if (name in suites && name in others) {
      problems.push(`"${name}" is listed both as a suite and under "otherScripts" in ${MANIFEST}; it is one or the other.`);
    }
  }
  for (const [name, suite] of Object.entries(suites)) {
    const declared = typeof suite.notAScript === "string" && suite.notAScript.trim() !== "";
    if (!scripts.includes(name) && !declared) {
      problems.push(
        `${MANIFEST} lists the suite "${name}", which is not a package.json script. Either it is gone, or give it a "notAScript" saying why it is run as a command instead.`,
      );
    }
    if (scripts.includes(name) && declared) {
      problems.push(`"${name}" in ${MANIFEST} has a "notAScript" reason, but it is a package.json script; drop the reason.`);
    }
  }
  for (const name of Object.keys(others)) {
    if (!scripts.includes(name)) problems.push(`${MANIFEST} lists "${name}" under "otherScripts", which is not a package.json script any more.`);
  }

  const owner = new Map();
  for (const [name, suite] of Object.entries(suites)) {
    for (const path of [...(suite.dirs ?? []), ...(suite.configs ?? [])]) {
      if (owner.has(path)) problems.push(`${path} is claimed by both "${owner.get(path)}" and "${name}" in ${MANIFEST}.`);
      owner.set(path, name);
      if (!existsSync(join(root, path))) problems.push(`"${name}" in ${MANIFEST} claims ${path}, which does not exist.`);
    }
  }
  for (const path of Object.keys(otherPaths)) {
    if (owner.has(path)) problems.push(`${path} is claimed by the suite "${owner.get(path)}" in ${MANIFEST} and also listed under "otherPaths"; it is one or the other.`);
    owner.set(path, null);
    if (!existsSync(join(root, path))) problems.push(`${MANIFEST} lists ${path} under "otherPaths", which does not exist.`);
  }

  const testsDir = join(root, "tests");
  const dirs = existsSync(testsDir)
    ? readdirSync(testsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `tests/${entry.name}`)
    : [];
  for (const dir of dirs) {
    if (!owner.has(dir)) {
      problems.push(`${dir} belongs to no suite in ${MANIFEST}. Add it to the "dirs" of the suite that runs it, add that suite, or list it under "otherPaths" if it only supports other suites.`);
    }
  }
  const configs = readdirSync(root).filter((file) => CONFIG.test(file));
  for (const config of configs) {
    if (!owner.has(config)) {
      problems.push(`${config} belongs to no suite in ${MANIFEST}. Add it to the "configs" of the suite that runs it, or add that suite.`);
    }
  }

  const workflowPaths = manifest.workflows;
  let lines = [];
  let named = "the pull-request workflows";
  if (!Array.isArray(workflowPaths) || workflowPaths.length === 0 || workflowPaths.some((path) => typeof path !== "string")) {
    problems.push(`${MANIFEST} must name the pull-request workflows in "workflows", as a list of paths.`);
  } else {
    named = workflowPaths.join(", ");
    for (const path of workflowPaths) {
      if (!existsSync(join(root, path))) {
        problems.push(`${MANIFEST} names ${path} in "workflows", which does not exist.`);
        continue;
      }
      const own = workflowLines(readFileSync(join(root, path), "utf8"));
      if (!own.some((line) => /^\s*pull_request\s*:/.test(line) || /^\s*on:\s*.*\bpull_request\b/.test(line))) {
        problems.push(`${path} does not run on pull requests, so none of its suites say anything about one.`);
      }
      lines = lines.concat(own);
    }
  }

  for (const [name, suite] of Object.entries(suites)) {
    const hasPr = typeof suite.pr === "string" && suite.pr.trim() !== "";
    const hasReason = typeof suite.notOnPr === "string" && suite.notOnPr.trim() !== "";
    if (typeof suite.what !== "string" || suite.what.trim() === "") problems.push(`"${name}" in ${MANIFEST} needs a "what": what it proves.`);
    if (hasPr === hasReason) {
      problems.push(
        `"${name}" in ${MANIFEST} needs exactly one of "pr" (the command the workflow runs it with) or "notOnPr" (why pull-request CI does not run it).`,
      );
    } else if (hasPr && lines.length > 0 && !invokes(lines, suite.pr.trim())) {
      problems.push(`"${name}" says pull-request CI runs it with \`${suite.pr}\`, but ${named} never runs that command.`);
    }
  }
  return problems;
}

function report(manifest) {
  const suites = Object.entries(manifest.suites ?? {});
  const run = suites.filter(([, suite]) => suite.pr).map(([name, suite]) => `\`${invocation(name, suite)}\``);
  const unrun = suites.filter(([, suite]) => suite.notOnPr);
  const lines = [MARKER, "### What this pull request's CI does not run", ""];
  if (unrun.length === 0) {
    lines.push("Every suite in `tests/suites.json` runs on this pull request.");
  } else {
    lines.push("A green check here says nothing about these suites:", "", "| Suite | What it covers | Why CI does not run it |", "|---|---|---|");
    const cell = (text) => text.replace(/\|/g, "\\|");
    for (const [name, suite] of unrun) lines.push(`| \`${invocation(name, suite)}\` | ${cell(suite.what)} | ${cell(suite.notOnPr)} |`);
  }
  lines.push("", `CI does run: ${run.join(", ")}.`, "", "From `tests/suites.json`, which CI checks against the tree on every run.");
  return `${lines.join("\n")}\n`;
}

async function github(path, init = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN is needed to comment on the pull request");
  const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const request = () =>
    fetch(`${api}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
    });
  // One retry, for GitHub's own hiccups only: a refusal (4xx) is an answer.
  let response = await request().catch(() => null);
  if (response === null || response.status >= 500) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    response = await request();
  }
  if (!response.ok) throw new Error(`GitHub answered ${response.status} to ${init.method ?? "GET"} ${path}: ${await response.text()}`);
  return response.json();
}

/** One comment per pull request: edited in place when it exists, so re-runs do not pile up. */
async function comment(pr, body) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is needed to comment on the pull request");
  if (!/^\d+$/.test(pr)) throw new Error(`--pr takes a pull request number, not "${pr}"`);
  let existing = null;
  for (let page = 1; existing === null; page++) {
    const comments = await github(`/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    existing = comments.find((entry) => typeof entry.body === "string" && entry.body.startsWith(MARKER)) ?? null;
    if (comments.length < 100) break;
  }
  if (existing === null) {
    await github(`/repos/${repo}/issues/${pr}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    return "posted";
  }
  if (existing.body === body) return "unchanged";
  await github(`/repos/${repo}/issues/comments/${existing.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
  return "updated";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readJson(join(args.root, MANIFEST), MANIFEST);
  const problems = check(args.root, manifest);
  const body = report(manifest);

  process.stdout.write(body);
  if (args.markdown) appendFileSync(args.markdown, `${body}\n`);
  if (problems.length > 0) {
    process.stderr.write(`\n${MANIFEST} does not match the tree:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  // Only a true list is worth posting; a failing check above has already said what is wrong.
  if (args.pr) process.stdout.write(`\nPull request comment ${await comment(args.pr, body)}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
