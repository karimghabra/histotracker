// Tests for scripts/test-coverage.mjs. Run: node --test scripts/test-coverage.test.mjs
//
// tests/suites.json and its checker are the answer to "what did this green
// check actually prove?". The failure they guard against is a suite nobody
// wired into CI: tests/stress2 existed for months, ran in no job, and nothing
// said so. So each case builds a small repository, runs the checker the way CI
// runs it (a child process), and asserts on its exit code and its words. The
// last cases post the comment to a fake GitHub and check it is kept to one,
// edited in place.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("test-coverage.mjs", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;
const MARKER = "<!-- histometer:suites -->";

// Two workflows, because this repository gates on two: the suites are spread
// across them, and a command in either one counts.
const TEST_WORKFLOW = `name: Workflow tests
on:
  push:
  pull_request:
jobs:
  browser-tests:
    steps:
      - run: pnpm exec vitest run
      - run: pnpm exec playwright test
      # pnpm test:stress is too slow to gate every change
`;

const INTEGRITY_WORKFLOW = `name: Release integrity
on:
  pull_request:
jobs:
  release-integrity:
    steps:
      - run: cargo test --lib --locked
`;

function baseManifest() {
  return {
    workflows: [".github/workflows/test.yml", ".github/workflows/release-integrity.yml"],
    suites: {
      "test:ui": { what: "Component tests.", configs: ["vitest.config.ts"], pr: "pnpm exec vitest run" },
      "test:e2e": { what: "The real app.", dirs: ["tests/e2e"], configs: ["playwright.config.ts"], pr: "pnpm exec playwright test" },
      "test:stress": {
        what: "The walk at scale.",
        dirs: ["tests/stress"],
        configs: ["playwright.stress.config.ts"],
        notOnPr: "It takes minutes.",
      },
      "cargo test --lib --locked": { what: "The Rust shell.", notAScript: "cargo, not pnpm.", pr: "cargo test --lib --locked" },
    },
    otherScripts: { dev: "The dev server." },
    otherPaths: { "tests/helpers": "Page helpers shared by the Playwright suites." },
  };
}

const DEFAULT_SCRIPTS = { dev: "vite", "test:ui": "vitest run", "test:e2e": "playwright test", "test:stress": "playwright test -c s" };
const DEFAULT_DIRS = ["tests/e2e", "tests/stress", "tests/helpers"];
const DEFAULT_CONFIGS = ["vitest.config.ts", "playwright.config.ts", "playwright.stress.config.ts"];

/** A throwaway repository shaped like this one, with whatever the case wants changed. */
function repo(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "ht-suites-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: options.scripts ?? DEFAULT_SCRIPTS }));
  for (const dir of options.dirs ?? DEFAULT_DIRS) mkdirSync(join(root, dir), { recursive: true });
  for (const config of options.configs ?? DEFAULT_CONFIGS) writeFileSync(join(root, config), "export default {};\n");
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  if (options.testWorkflow !== null) writeFileSync(join(root, ".github", "workflows", "test.yml"), options.testWorkflow ?? TEST_WORKFLOW);
  if (options.integrityWorkflow !== null) {
    writeFileSync(join(root, ".github", "workflows", "release-integrity.yml"), options.integrityWorkflow ?? INTEGRITY_WORKFLOW);
  }
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "suites.json"), JSON.stringify(options.manifest ?? baseManifest(), null, 2));
  return root;
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

// ---- the list checked against the tree -------------------------------------------

test("this repository's own list holds, and names what its pull requests do not run", async () => {
  const result = await run(["--root", ROOT]);
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes(MARKER));
  for (const suite of ["test:staining", "test:stress", "test:stress2", "test:stress3"]) {
    assert.ok(result.stdout.includes(`\`pnpm ${suite}\``), `${suite} is missing from the report`);
  }
  // The proven case: it must be named as unrun, not quietly left out.
  assert.match(result.stdout, /pnpm test:stress2[\s\S]*never been wired into any CI job/);
});

test("a complete list passes, and says what CI skips and what it runs", async (t) => {
  const result = await run(["--root", repo(t)]);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes("| `pnpm test:stress` | The walk at scale. | It takes minutes. |"));
  assert.ok(result.stdout.includes("CI does run: `pnpm test:ui`, `pnpm test:e2e`, `cargo test --lib --locked`."));
});

test("a suite is matched against every workflow, not only the first", async (t) => {
  // `cargo test --lib --locked` runs in release-integrity.yml alone.
  const result = await run(["--root", repo(t, { integrityWorkflow: INTEGRITY_WORKFLOW.replace("cargo test --lib --locked", "echo nothing") })]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("`cargo test --lib --locked`, but .github/workflows/test.yml, .github/workflows/release-integrity.yml never runs that command"));
});

test("a suite directory nobody wired in or wrote off fails the check", async (t) => {
  const result = await run(["--root", repo(t, { dirs: [...DEFAULT_DIRS, "tests/stress2"] })]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("tests/stress2 belongs to no suite in tests/suites.json"));
});

test("a test config that belongs to no suite fails the check", async (t) => {
  const result = await run(["--root", repo(t, { configs: [...DEFAULT_CONFIGS, "playwright.stress2.config.ts"] })]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("playwright.stress2.config.ts belongs to no suite"));
});

test("a package script the list does not account for fails, and so does one it lists that is gone", async (t) => {
  const scripts = { dev: "vite", "test:ui": "vitest run", "test:e2e": "playwright test", "test:staining": "node h.mjs" };
  const result = await run(["--root", repo(t, { scripts })]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('The package.json script "test:staining" is not in tests/suites.json'));
  assert.ok(result.stderr.includes('tests/suites.json lists the suite "test:stress", which is not a package.json script'));
});

test("a suite that is a command rather than a script needs to say so", async (t) => {
  const manifest = baseManifest();
  delete manifest.suites["cargo test --lib --locked"].notAScript;
  const result = await run(["--root", repo(t, { manifest })]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('lists the suite "cargo test --lib --locked", which is not a package.json script'));
});

test("a suite that is a script must not claim it is a command", async (t) => {
  const manifest = baseManifest();
  manifest.suites["test:ui"].notAScript = "It is run by hand.";
  const result = await run(["--root", repo(t, { manifest })]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('"test:ui" in tests/suites.json has a "notAScript" reason, but it is a package.json script'));
});

test("a support path claimed by a suite as well fails the check", async (t) => {
  const manifest = baseManifest();
  manifest.suites["test:e2e"].dirs = ["tests/e2e", "tests/helpers"];
  const result = await run(["--root", repo(t, { manifest })]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('tests/helpers is claimed by the suite "test:e2e"'));
});

test("a command the workflow only mentions in a comment does not count as run", async (t) => {
  const manifest = baseManifest();
  delete manifest.suites["test:stress"].notOnPr;
  manifest.suites["test:stress"].pr = "pnpm test:stress";
  const result = await run(["--root", repo(t, { manifest })]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('"test:stress" says pull-request CI runs it with `pnpm test:stress`'));
});

test("one command is not taken for a longer one it begins", async (t) => {
  const manifest = baseManifest();
  manifest.suites["test:ui"].pr = "pnpm test";
  const testWorkflow = TEST_WORKFLOW.replace("- run: pnpm exec vitest run\n", "- run: pnpm test:compat\n");
  const result = await run(["--root", repo(t, { manifest, testWorkflow })]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('"test:ui" says pull-request CI runs it with `pnpm test`'));
});

test("a suite that neither runs on a pull request nor says why fails the check", async (t) => {
  const manifest = baseManifest();
  delete manifest.suites["test:stress"].notOnPr;
  const result = await run(["--root", repo(t, { manifest })]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes('"test:stress" in tests/suites.json needs exactly one of "pr"'));
});

test("a workflow that does not run on pull requests fails the check", async (t) => {
  const result = await run(["--root", repo(t, { testWorkflow: TEST_WORKFLOW.replace("  pull_request:\n", "") })]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(".github/workflows/test.yml does not run on pull requests"));
});

test("a named workflow that is not there fails the check", async (t) => {
  const result = await run(["--root", repo(t, { integrityWorkflow: null })]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("names .github/workflows/release-integrity.yml"));
});

test("the same list is appended to a markdown file, for the job summary", async (t) => {
  const root = repo(t);
  const summary = join(root, "summary.md");
  writeFileSync(summary, "# Earlier step\n");
  const result = await run(["--root", root, "--markdown", summary]);
  assert.equal(result.code, 0);
  const written = readFileSync(summary, "utf8");
  assert.ok(written.startsWith("# Earlier step\n"));
  assert.ok(written.includes("| `pnpm test:stress` |"));
});

// ---- the pull request comment ----------------------------------------------------

/** A GitHub that only knows the three calls this script makes, so the comment path is really exercised. */
async function fakeGitHub(t, comments) {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk.toString()));
    request.on("end", () => {
      seen.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
      const url = request.url ?? "";
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && url.startsWith("/repos/o/r/issues/7/comments")) {
        response.end(JSON.stringify(url.includes("page=1") ? comments : []));
      } else if (request.method === "POST" && url === "/repos/o/r/issues/7/comments") {
        comments.push({ id: 100 + comments.length, body: JSON.parse(body).body });
        response.end("{}");
      } else if (request.method === "PATCH" && url.startsWith("/repos/o/r/issues/comments/")) {
        const id = Number(url.split("/").pop());
        const target = comments.find((entry) => entry.id === id);
        if (target) target.body = JSON.parse(body).body;
        response.end("{}");
      } else {
        response.statusCode = 404;
        response.end('{"message":"Not Found"}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { seen, env: { GH_TOKEN: "fake-token", GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: `http://127.0.0.1:${port}` } };
}

test("the comment is posted once, then edited in place rather than added again", async (t) => {
  const comments = [{ id: 1, body: "A person said something." }];
  const github = await fakeGitHub(t, comments);
  const root = repo(t);

  const first = await run(["--root", root, "--pr", "7"], github.env);
  assert.equal(first.code, 0);
  assert.ok(first.stdout.includes("Pull request comment posted."));
  assert.equal(comments.length, 2);
  assert.ok(comments[1].body.startsWith(MARKER));
  assert.ok(github.seen.every((line) => line.endsWith("Bearer fake-token")));

  const again = await run(["--root", root, "--pr", "7"], github.env);
  assert.ok(again.stdout.includes("Pull request comment unchanged."));

  const manifest = baseManifest();
  manifest.suites["test:stress"].notOnPr = "It takes ten minutes.";
  writeFileSync(join(root, "tests", "suites.json"), JSON.stringify(manifest));
  const changed = await run(["--root", root, "--pr", "7"], github.env);
  assert.ok(changed.stdout.includes("Pull request comment updated."));
  assert.equal(comments.length, 2);
  assert.equal(comments[0].body, "A person said something.");
  assert.ok(comments[1].body.includes("It takes ten minutes."));
});

test("nothing is posted while the list is wrong, because a wrong list would be the thing posted", async (t) => {
  const comments = [];
  const github = await fakeGitHub(t, comments);
  const result = await run(["--root", repo(t, { dirs: [...DEFAULT_DIRS, "tests/stress2"] }), "--pr", "7"], github.env);
  assert.equal(result.code, 1);
  assert.equal(comments.length, 0);
  assert.equal(github.seen.length, 0);
});

test("a refusal from GitHub fails loudly, so a missing disclosure is never silent", async (t) => {
  const github = await fakeGitHub(t, []);
  const result = await run(["--root", repo(t), "--pr", "7"], { ...github.env, GITHUB_REPOSITORY: "someone/else" });
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("GitHub answered 404"));
});
