// The two builds under test: a released build, taken from its git tag, and the
// working tree. Each is used through its OWN source — its data layer, its
// migration list, its migration files — so nothing about the release is
// re-typed here and nothing drifts when the next release lands.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RegisteredMigration } from "./sqlx-migrator";

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
    // A fresh or shallow clone (CI) has no tags: fetch just this one.
    try {
      git("fetch", "--quiet", "--depth=1", "origin", `refs/tags/${ref}:refs/tags/${ref}`);
    } catch {
      git("fetch", "--quiet", "--depth=1", "origin", ref);
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
  const rs = readFileSync(join(root, "src-tauri", "src", "lib.rs"), "utf8");
  const blocks = rs.match(/Migration\s*\{[\s\S]*?\}/g) ?? [];
  const parsed = blocks.map((block) => {
    const m = /version:\s*(\d+),\s*description:\s*"([^"]*)",\s*sql:\s*include_str!\("\.\.\/migrations\/([^"]+)"\),\s*kind:\s*MigrationKind::(\w+)/.exec(block);
    if (!m) throw new Error(`[compat] cannot read this migration entry in ${root}/src-tauri/src/lib.rs:\n${block}`);
    return { version: Number(m[1]), description: m[2], file: m[3], kind: m[4] };
  });
  if (parsed.length === 0) throw new Error(`[compat] no migrations registered in ${root}/src-tauri/src/lib.rs`);
  return parsed
    .filter((m) => m.kind === "Up")
    .map((m) => ({
      version: m.version,
      description: m.description,
      file: m.file,
      sql: readFileSync(join(root, "src-tauri", "migrations", m.file), "utf8"),
    }));
}

function lockedVersion(root: string, crate: string): string {
  const lock = readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8");
  const m = new RegExp(`name = "${crate}"\\nversion = "([^"]+)"`).exec(lock);
  if (!m) throw new Error(`[compat] ${crate} is not in ${root}/src-tauri/Cargo.lock`);
  return m[1];
}

/**
 * sqlx-migrator.ts is a port of sqlx 0.8's migrator driven by tauri-plugin-sql
 * 2.x. A build on anything else must not be judged by it: re-read that
 * version's migrator source, update the port, then widen this check.
 */
function assertMigratorModelApplies(build: Build): void {
  const sqlx = lockedVersion(build.root, "sqlx-core");
  const plugin = lockedVersion(build.root, "tauri-plugin-sql");
  if (!/^0\.8\./.test(sqlx) || !/^2\./.test(plugin)) {
    throw new Error(
      `[compat] ${build.label} ships sqlx-core ${sqlx} / tauri-plugin-sql ${plugin}; ` +
        `tests/compat/sqlx-migrator.ts models sqlx 0.8 under tauri-plugin-sql 2. ` +
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
