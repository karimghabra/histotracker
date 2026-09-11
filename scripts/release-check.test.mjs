// Tests for scripts/release-check.mjs. Run: node --test scripts/release-check.test.mjs
//
// The provenance and plan checks are exercised against throwaway git repositories
// built to the shape of the real incident: a release line that grows away from
// master, tags cut on it, and master left behind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkProvenance,
  checkVersions,
  compareVersions,
  hasChangelogSection,
  makeGit,
  newestRelease,
  planRelease,
  readVersionSources,
  tagVersion,
} from "./release-check.mjs";

// ---- fixtures -------------------------------------------------------------------

function versionFiles(version, overrides = {}) {
  const v = (file) => overrides[file] ?? version;
  return {
    "package.json": JSON.stringify({ name: "histometer", version: v("package.json") }, null, 2) + "\n",
    "src-tauri/tauri.conf.json": JSON.stringify({ productName: "Histometer", version: v("tauri.conf.json") }, null, 2) + "\n",
    "src-tauri/Cargo.toml":
      `[package]\nname = "histometer"\nversion = "${v("Cargo.toml")}"\nedition = "2021"\n\n` +
      `[dependencies]\nserde = { version = "1" }\n`,
    "src-tauri/Cargo.lock":
      `version = 4\n\n[[package]]\nname = "base64"\nversion = "0.22.1"\n\n` +
      `[[package]]\nname = "histometer"\nversion = "${v("Cargo.lock")}"\ndependencies = [\n "base64",\n]\n`,
    "package-lock.json":
      JSON.stringify(
        { name: "histometer", version: v("package-lock.json"), packages: { "": { name: "histometer", version: v("package-lock.json#root") } } },
        null,
        2,
      ) + "\n",
    "CHANGELOG.md": `# Changelog\n\n## ${version} - unreleased\n\nWhat ${version} ships.\n`,
  };
}

const reader = (files) => (path) => {
  if (!(path in files)) throw new Error(`ENOENT ${path}`);
  return files[path];
};

/** A git repository in a temp directory, with helpers to shape its history. */
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "release-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();
  run("init", "--quiet", "--initial-branch=master");
  const write = (files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  return {
    dir,
    run,
    git: makeGit(dir),
    read: (path) => readFileSync(join(dir, path), "utf8"),
    commit(version, message = `at ${version}`) {
      write(versionFiles(version));
      write({ "log.txt": `${message}\n` });
      run("add", "-A");
      run("commit", "--quiet", "-m", message);
      return run("rev-parse", "HEAD");
    },
    tag(name, ref = "HEAD") {
      run("tag", name, ref);
    },
    head: () => run("rev-parse", "HEAD"),
  };
}

// ---- versions -------------------------------------------------------------------

test("versions: tag names and ordering", () => {
  assert.equal(tagVersion("app-v0.17.0"), "0.17.0");
  assert.equal(tagVersion("v0.11.1"), null);
  assert.equal(tagVersion("app-v0.17"), null);
  assert.ok(compareVersions("0.16.0", "0.15.3") > 0, "0.16.0 is newer than 0.15.3");
  assert.ok(compareVersions("0.9.0", "0.10.0") < 0, "numeric, not lexical");
  assert.equal(compareVersions("0.18.0", "0.18.0"), 0);
  assert.deepEqual(newestRelease(["app-v0.9.0", "app-v0.17.0", "app-v0.10.0", "v9.9.9"]), {
    tag: "app-v0.17.0",
    version: "0.17.0",
  });
  assert.equal(newestRelease([]), null);
});

test("versions: all five sources agreeing is a pass", () => {
  const { version, problems } = checkVersions(readVersionSources(reader(versionFiles("0.18.0"))));
  assert.deepEqual(problems, []);
  assert.equal(version, "0.18.0");
});

test("versions: any one source out of step is named", () => {
  for (const file of ["package.json", "tauri.conf.json", "Cargo.toml", "Cargo.lock", "package-lock.json", "package-lock.json#root"]) {
    const { version, problems } = checkVersions(
      readVersionSources(reader(versionFiles("0.18.0", { [file]: "0.17.0" }))),
    );
    assert.equal(version, null, `${file} out of step must not yield a version`);
    assert.equal(problems.length, 1, `${file}: ${problems.join(" | ")}`);
    assert.match(problems[0], /disagree/);
  }
});

test("versions: the Cargo.toml read is the [package] version, not a dependency's", () => {
  const files = versionFiles("0.18.0");
  files["src-tauri/Cargo.toml"] =
    `[package]\nname = "histometer"\nversion = "0.18.0"\n\n[dependencies]\nfoo = { version = "9.9.9" }\n`;
  assert.deepEqual(checkVersions(readVersionSources(reader(files))).problems, []);
  files["src-tauri/Cargo.toml"] = `[dependencies]\nversion = "0.18.0"\n`;
  const { problems } = checkVersions(readVersionSources(reader(files)));
  assert.ok(problems.some((p) => p.includes("src-tauri/Cargo.toml: no [package] version")), problems.join(" | "));
});

test("versions: a missing file is a problem, not a crash", () => {
  const files = versionFiles("0.18.0");
  delete files["package-lock.json"];
  const { problems } = checkVersions(readVersionSources(reader(files)));
  assert.ok(problems.some((p) => p.startsWith("package-lock.json: no version")), problems.join(" | "));
});

test("changelog: a level-2 heading for the version counts, and nothing else does", () => {
  for (const text of [
    "## 0.18.0 - unreleased\n",
    "## 0.18.0",
    "## 0.18.0\n\nnotes\n",
    "# Changelog\n\n## 0.18.0 - unreleased\n\n## 0.17.0 - 2026-09-04\n",
    "# Changelog\r\n\r\n## 0.18.0\r\n",
  ]) {
    assert.equal(hasChangelogSection(text, "0.18.0"), true, JSON.stringify(text));
  }
  for (const text of [
    "### 0.18.0\n",
    "## 0.18.01\n",
    "## 10.18.0\n",
    "## 0x18x0\n",
    "0.18.0 fixes the export.\n",
    "# Changelog\n\nThe next release, 0.18.0, will ship this.\n\n## 0.17.0 - 2026-09-04\n",
    "",
  ]) {
    assert.equal(hasChangelogSection(text, "0.18.0"), false, JSON.stringify(text));
  }
});

// ---- provenance -------------------------------------------------------------------

test("provenance: releases cut on master pass", (t) => {
  const r = repo(t);
  r.commit("0.13.2");
  r.tag("app-v0.13.2");
  r.commit("0.14.0");
  r.tag("app-v0.14.0");
  const { problems, newest } = checkProvenance(r.git, r.head(), "0.14.0");
  assert.deepEqual(problems, []);
  assert.equal(newest.tag, "app-v0.14.0");
});

test("provenance: the 0.17.0 incident, a release line master never received, fails and names the tag", (t) => {
  const r = repo(t);
  r.commit("0.13.2");
  r.tag("app-v0.13.2");
  r.run("checkout", "--quiet", "-b", "claude/issues-129-133");
  r.commit("0.17.0", "release line");
  r.tag("app-v0.17.0");
  r.run("checkout", "--quiet", "master");
  r.commit("0.13.2", "PR 138 on master");
  const { problems } = checkProvenance(r.git, r.head(), "0.13.2");
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0], /^app-v0\.17\.0 .* is not in master's history/);
  assert.match(problems[1], /master declares 0\.13\.2 but app-v0\.17\.0 is already released/);
});

test("provenance: merging the release line back in, with the version moved forward, passes", (t) => {
  const r = repo(t);
  r.commit("0.13.2");
  r.tag("app-v0.13.2");
  r.run("checkout", "--quiet", "-b", "claude/issues-129-133");
  r.commit("0.17.0", "release line");
  r.tag("app-v0.17.0");
  r.run("checkout", "--quiet", "master");
  r.commit("0.13.2", "PR 138 on master");
  r.run("merge", "--quiet", "--no-edit", "-X", "theirs", "claude/issues-129-133");
  r.commit("0.18.0", "move to 0.18.0");
  assert.deepEqual(checkProvenance(r.git, r.head(), "0.18.0").problems, []);
});

// ---- plan -------------------------------------------------------------------

test("plan: a new version on master publishes", (t) => {
  const r = repo(t);
  r.commit("0.17.0");
  r.tag("app-v0.17.0");
  r.commit("0.18.0");
  const plan = planRelease({ git: r.git, ref: "refs/heads/master", head: r.head(), read: r.read });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.publish, true);
  assert.equal(plan.tag, "app-v0.18.0");
});

test("plan: any ref other than master is refused, whatever else is right", (t) => {
  const r = repo(t);
  r.commit("0.17.0");
  r.tag("app-v0.17.0");
  r.run("checkout", "--quiet", "-b", "claude/next");
  r.commit("0.18.0");
  for (const ref of ["refs/heads/claude/next", "refs/tags/v0.18.0", ""]) {
    const plan = planRelease({ git: r.git, ref, head: r.head(), read: r.read });
    assert.equal(plan.publish, false, ref);
    assert.match(plan.problems[0], /releases are cut from master only/, ref);
  }
});

test("plan: an existing version is refused rather than rebuilt, from its own commit or a later one", (t) => {
  const r = repo(t);
  r.commit("0.18.0");
  r.tag("app-v0.18.0");
  let plan = planRelease({ git: r.git, ref: "refs/heads/master", head: r.head(), read: r.read });
  assert.equal(plan.publish, false);
  assert.match(plan.problems[0], /app-v0\.18\.0 is already released from this commit/);

  r.commit("0.18.0", "a fix merged without a version bump");
  plan = planRelease({ git: r.git, ref: "refs/heads/master", head: r.head(), read: r.read });
  assert.equal(plan.publish, false);
  assert.match(plan.problems[0], /app-v0\.18\.0 is already released from [0-9a-f]{12}\. .*bump the version/);
});

test("plan: a version below the newest release is refused (the 0.15.3-after-0.16.0 mistake)", (t) => {
  const r = repo(t);
  r.commit("0.16.0");
  r.tag("app-v0.16.0");
  r.commit("0.15.3");
  const plan = planRelease({ git: r.git, ref: "refs/heads/master", head: r.head(), read: r.read });
  assert.equal(plan.publish, false);
  assert.ok(plan.problems.some((p) => /master declares 0\.15\.3 but app-v0\.16\.0/.test(p)), plan.problems.join("\n"));
});

test("plan: nothing is published while any release is missing from master", (t) => {
  const r = repo(t);
  r.commit("0.13.2");
  r.tag("app-v0.13.2");
  r.run("checkout", "--quiet", "-b", "side");
  r.commit("0.14.3", "side release");
  r.tag("app-v0.14.3");
  r.run("checkout", "--quiet", "master");
  r.commit("0.15.0");
  const plan = planRelease({ git: r.git, ref: "refs/heads/master", head: r.head(), read: r.read });
  assert.equal(plan.publish, false);
  assert.match(plan.problems[0], /app-v0\.14\.3 .* is not in master's history/);
});

test("plan: version files out of step block the release", (t) => {
  const r = repo(t);
  r.commit("0.17.0");
  r.tag("app-v0.17.0");
  r.commit("0.18.0");
  writeFileSync(join(r.dir, "src-tauri/Cargo.toml"), versionFiles("0.17.0")["src-tauri/Cargo.toml"]);
  const plan = planRelease({ git: r.git, ref: "refs/heads/master", head: r.head(), read: r.read });
  assert.equal(plan.publish, false);
  assert.match(plan.problems[0], /disagree/);
});

test("plan: a version with no changelog section is refused", (t) => {
  const r = repo(t);
  r.commit("0.17.0");
  r.tag("app-v0.17.0");
  r.commit("0.18.0");
  writeFileSync(join(r.dir, "CHANGELOG.md"), "# Changelog\n\n## 0.17.0 - 2026-09-04\n\nThemes.\n");
  r.run("commit", "--quiet", "-am", "0.18.0 without its changelog section");
  let plan = planRelease({ git: r.git, ref: "refs/heads/master", head: r.head(), read: r.read });
  assert.equal(plan.publish, false);
  assert.ok(plan.problems.some((p) => /CHANGELOG\.md .*0\.18\.0/.test(p)), plan.problems.join("\n"));

  rmSync(join(r.dir, "CHANGELOG.md"));
  r.run("commit", "--quiet", "-am", "no changelog at all");
  plan = planRelease({ git: r.git, ref: "refs/heads/master", head: r.head(), read: r.read });
  assert.equal(plan.publish, false);
  assert.ok(plan.problems.some((p) => /CHANGELOG\.md .*0\.18\.0/.test(p)), plan.problems.join("\n"));
});
