// The two builds under test: a released build, taken from its git tag, and the
// working tree. Each is used through its OWN source — its data layer, its
// migration list, its migration files — so nothing about the release is
// re-typed here and nothing drifts when the next release lands.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checksum, type RegisteredMigration } from "./sqlx-migrator";
import { parseMigrationList } from "../../src/test/sqlx-migrator";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** Extracted release trees, cached by commit. Git-ignored. */
const CACHE_DIR = join(REPO_ROOT, ".compat");

/** What a build is made of, as far as its database is concerned. */
export const BUILD_PATHS = [
  "src",
  "src-tauri/migrations",
  "src-tauri/src/lib.rs",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.lock",
];

export interface Build {
  /** e.g. "release app-v0.17.0" or "this branch". */
  label: string;
  ref: string;
  commit: string;
  /** src-tauri/tauri.conf.json `version`. */
  version: string;
  root: string;
  migrations: RegisteredMigration[];
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function resolveCommit(ref: string): string {
  try {
    return git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  } catch {
    // A fresh or shallow clone (CI) has no tags: fetch just this one. Shallowly
    // only if the clone already is: --depth on a full clone makes it shallow
    // and cuts the release line's history off at the tag.
    const depth = git("rev-parse", "--is-shallow-repository") === "true" ? ["--depth=1"] : [];
    try {
      git("fetch", "--quiet", ...depth, "origin", `refs/tags/${ref}:refs/tags/${ref}`);
    } catch {
      git("fetch", "--quiet", ...depth, "origin", ref);
      return git("rev-parse", "--verify", "FETCH_HEAD^{commit}");
    }
    return git("rev-parse", "--verify", `${ref}^{commit}`);
  }
}

/**
 * The migration list a build REGISTERS, read out of its `src-tauri/src/lib.rs`.
 * The list there is explicit, not discovered, and it — not the directory — is
 * what the migrator runs. Down migrations are dropped, as the plugin does.
 */
export function registeredMigrations(root: string): RegisteredMigration[] {
  const librs = join(root, "src-tauri", "src", "lib.rs");
  return parseMigrationList(readFileSync(librs, "utf8"), `[compat] ${librs}`).map((m) => {
    const sql = readFileSync(join(root, "src-tauri", "migrations", m.file), "utf8");
    return { ...m, sql, checksum: checksum(sql) };
  });
}

function lockedVersion(root: string, crate: string): string {
  const lock = readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8");
  const m = new RegExp(`name = "${crate}"\\nversion = "([^"]+)"`).exec(lock);
  if (!m) throw new Error(`[compat] ${crate} is not in ${root}/src-tauri/Cargo.lock`);
  return m[1];
}

/**
 * src/test/sqlx-migrator.ts is a port of sqlx 0.8's migrator driven by tauri-plugin-sql
 * 2.x. A build on anything else must not be judged by it: re-read that
 * version's migrator source, update the port, then widen this check.
 */
function assertMigratorModelApplies(build: Build): void {
  const sqlx = lockedVersion(build.root, "sqlx-core");
  const plugin = lockedVersion(build.root, "tauri-plugin-sql");
  if (!/^0\.8\./.test(sqlx) || !/^2\./.test(plugin)) {
    throw new Error(
      `[compat] ${build.label} ships sqlx-core ${sqlx} / tauri-plugin-sql ${plugin}; ` +
        `src/test/sqlx-migrator.ts models sqlx 0.8 under tauri-plugin-sql 2. ` +
        `Re-check the port against that version before trusting this harness.`,
    );
  }
}

function tauriVersion(root: string): string {
  return JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
}

export function currentBuild(): Build {
  const build: Build = {
    label: "this branch",
    ref: "working tree",
    commit: git("rev-parse", "HEAD"),
    version: tauriVersion(REPO_ROOT),
    root: REPO_ROOT,
    migrations: registeredMigrations(REPO_ROOT),
  };
  assertMigratorModelApplies(build);
  return build;
}

/**
 * Up to 0.17.0 the installer workflow republished a release on every push at
 * the same version, but the tag stayed where it was first cut (from 0.18.0 a
 * release is never rebuilt, docs/releasing.md). So a branch that carries
 * the tag and still builds the same version past it may be what the installer
 * was last built from. Only remote branches this clone has fetched are seen
 * (none in CI's shallow checkout); name the branch to test it instead.
 */
function warnIfRebuiltLater(ref: string, commit: string, version: string): void {
  let branches: string[] = [];
  try {
    branches = git("for-each-ref", "--contains", commit, "--format=%(refname:short)", "refs/remotes/origin").split("\n");
  } catch {
    return;
  }
  for (const branch of branches.filter(Boolean)) {
    const tip = git("rev-parse", branch);
    if (tip === commit) continue;
    try {
      const conf = git("show", `${tip}:src-tauri/tauri.conf.json`);
      if (JSON.parse(conf).version === version) {
        console.warn(
          `  [compat] ${branch} is past ${ref} and still builds ${version}; the installer may have been ` +
            `rebuilt from it. Check it too: pnpm test:compat ${branch}`,
        );
      }
    } catch {
      /* not a Histometer tree at that tip */
    }
  }
}

/**
 * A released build, from its tag (`app-v<version>`, which the installer
 * workflow creates from the exact commit it built). Any other ref works too —
 * a release line's tip before it is tagged, say — but only a tag is checked
 * against the version it claims.
 */
export function releaseBuild(ref: string): Build {
  const commit = resolveCommit(ref);
  const root = join(CACHE_DIR, `${ref.replace(/[^\w.-]+/g, "_")}@${commit.slice(0, 12)}`);
  const done = join(root, ".extracted");
  if (!existsSync(done)) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const tar = execFileSync("git", ["archive", "--format=tar", commit, ...BUILD_PATHS], {
      cwd: REPO_ROOT,
      maxBuffer: 256 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", root], { input: tar });
    writeFileSync(done, `${ref} ${commit}\n`);
  }
  const version = tauriVersion(root);
  const tagged = /^app-v(.+)$/.exec(ref);
  if (tagged && tagged[1] !== version) {
    throw new Error(`[compat] ${ref} builds version ${version}, not ${tagged[1]}`);
  }
  if (tagged) warnIfRebuiltLater(ref, commit, version);
  const build: Build = {
    label: `release ${ref}`,
    ref,
    commit,
    version,
    root,
    migrations: registeredMigrations(root),
  };
  assertMigratorModelApplies(build);
  return build;
}
