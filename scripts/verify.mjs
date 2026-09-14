#!/usr/bin/env node
/**
 * `pnpm verify` - the one command that tells an update did not break
 * Histometer. Four layers, cheapest first, each failing fast unless
 * --keep-going. CI runs the same layers (.github/workflows/test.yml).
 *
 *   node scripts/verify.mjs [--base <rev>] [--workers <n>] [--keep-going]
 *                           [--only data,render,e2e,screenshot] [--screenshot]
 *
 * 1. data (in parallel): typecheck, harness, legacy upgrade, vitest, compat,
 *    release checks, suite manifest, the E4 capture guard, and the production
 *    `vite build` plus G1's bundle check.
 * 2. render: the base build and this tree served side by side, the same lab
 *    built on both, ARIA structure diffed and layout/contrast audited, no
 *    screenshot (tests/render/).
 * 3. e2e: tests/e2e with retries off, a smoke set first, then the rest.
 * 4. screenshot: the 26 captures E4 moved to tests/screenshot/, only with
 *    --screenshot (CI only, never on a lab machine; never pass this locally
 *    unless you have confirmed no display is reachable).
 *
 * Everything verbose goes to .verify-out/<step>.log; stdout stays a
 * few lines on green. No display is reachable: DISPLAY and WAYLAND_DISPLAY
 * are removed from every child, same as the browser suites already require.
 */
import { spawn, execSync } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
// Deliberately NOT under test-results/: Playwright clears its whole outputDir
// (the default) at the start of every run, which would delete this step's own
// log while an e2e-tier step still had it open. Gitignored (.gitignore).
const OUT = join(ROOT, ".verify-out");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);
const only = opt("only", "data,render,e2e" + (flag("screenshot") ? ",screenshot" : "")).split(",");
const keepGoing = flag("keep-going");
const workers = opt("workers", "1");
mkdirSync(OUT, { recursive: true });

const env = { ...process.env, CI: process.env.CI ?? "true", FORCE_COLOR: "0" };
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;

const started = Date.now();
const printed = [];
const say = (s) => {
  printed.push(s);
  console.log(s);
};

function run(name, command, extraEnv = {}, cwd = ROOT) {
  const log = join(OUT, `${name}.log`);
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn("bash", ["-c", command], { cwd, env: { ...env, ...extraEnv } });
    const sink = createWriteStream(log);
    child.stdout.pipe(sink);
    child.stderr.pipe(sink);
    child.on("close", (code) => sink.end(() => done({ name, ok: code === 0, secs: (Date.now() - t0) / 1000, log })));
  });
}

/** The lines of a failed step's log worth reading first. */
function excerpt(log, max = 12) {
  const lines = readFileSync(log, "utf8").replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const hits = lines.filter((l) => /FAIL|✘|Error|error TS|failed|regression|not ok|AssertionError|expected/i.test(l));
  return (hits.length ? hits : lines.filter(Boolean).slice(-max)).slice(0, max).map((l) => `      ${l.trim().slice(0, 180)}`);
}

function report(r) {
  say(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(9)} ${r.secs.toFixed(1).padStart(6)}s`);
  if (!r.ok) {
    for (const l of excerpt(r.log)) say(l);
    say(`      full log: ${r.log}`);
  }
}

const failures = [];
const finish = () => {
  const secs = Math.round((Date.now() - started) / 1000);
  say(failures.length ? `VERIFY FAIL (${failures.join(", ")}) in ${secs}s` : `VERIFY PASS in ${secs}s`);
  writeFileSync(join(OUT, "stdout.txt"), printed.join("\n") + "\n");
  process.exit(failures.length ? 1 : 0);
};
const stopIfRed = () => {
  if (failures.length && !keepGoing) finish();
};

// ---------------------------------------------------------------- data
if (only.includes("data")) {
  const steps = await Promise.all([
    run("tsc", "pnpm exec tsc --noEmit"),
    run("harness", "node scripts/workflow-test.mjs"),
    run("legacy", "node scripts/make-legacy-db.mjs && node scripts/legacy-db-upgrade-test.mjs; s=$?; git checkout -- tests/fixtures/legacy-pre-0023.b64; exit $s"),
    run("unit", "pnpm exec vitest run"),
    run("compat", "pnpm test:compat"),
    run("release", "node --test scripts/release-check.test.mjs && node scripts/release-check.mjs versions"),
    run("suites", "node --test scripts/test-coverage.test.mjs && node scripts/test-coverage.mjs"),
    run("captures", "node scripts/no-unasserted-captures.mjs"),
    run("bundle", `pnpm exec vite build --outDir ${join(OUT, "dist")} --emptyOutDir --logLevel warn && node scripts/bundle-check.mjs ${join(OUT, "dist")}`),
  ]);
  for (const r of steps) {
    report(r);
    if (!r.ok) failures.push(r.name);
  }
  stopIfRed();
}

// ---------------------------------------------------------------- render
async function tree(label, rev) {
  const dir = join(OUT, "trees", label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execSync(`git archive ${rev} | tar -x -C ${dir}`, { cwd: ROOT, shell: "bash" });
  if (rev === "HEAD") {
    const patch = execSync("git diff HEAD --binary", { cwd: ROOT, maxBuffer: 1 << 28 });
    if (patch.length) {
      writeFileSync(join(dir, ".worktree.patch"), patch);
      execSync("git apply .worktree.patch", { cwd: dir });
    }
  }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

function serve(dir, port) {
  writeFileSync(
    join(dir, ".verify-vite.config.ts"),
    `import base from "./vite.config.playwright";\nimport { mergeConfig } from "vite";\n` +
      `export default mergeConfig(base, { cacheDir: ".verify-vite-cache", clearScreen: false, server: { port: ${port}, strictPort: true, watch: null } });\n`,
  );
  const out = openSync(join(OUT, `vite-${port}.log`), "w");
  const err = openSync(join(OUT, `vite-${port}.err`), "w");
  const child = spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "--config", ".verify-vite.config.ts"], {
    cwd: dir,
    env,
    stdio: ["ignore", out, err],
  });
  closeSync(out);
  closeSync(err);
  return child;
}

async function up(url) {
  for (let i = 0; i < 240; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} never came up`);
}

if (only.includes("render")) {
  const base = opt("base", execSync("git merge-base HEAD master", { cwd: ROOT }).toString().trim());
  const t0 = Date.now();
  const servers = [];
  try {
    const baseDir = await tree("base", base);
    const headDir = await tree("head", "HEAD");
    servers.push(serve(baseDir, 5701), serve(headDir, 5702));
    await Promise.all([up("http://localhost:5701"), up("http://localhost:5702")]);
    await Promise.all([fetch("http://localhost:5701/src/main.tsx"), fetch("http://localhost:5702/src/main.tsx")]).catch(() => {});
    rmSync(join(OUT, "render"), { recursive: true, force: true });
    const r = await run("render", "pnpm exec playwright test --config playwright.render.config.ts", {
      RENDER_DIFF_BUILDS: JSON.stringify({ base: "http://localhost:5701", head: "http://localhost:5702" }),
      RENDER_DIFF_OUT: join(OUT, "render"),
    });
    r.secs = (Date.now() - t0) / 1000;
    say(`${r.ok ? "PASS" : "FAIL"}  render    ${r.secs.toFixed(1).padStart(6)}s  (base ${base.slice(0, 7)})`);
    const summary = join(OUT, "render", "diff.txt");
    if (existsSync(summary)) {
      for (const l of readFileSync(summary, "utf8").split("\n").slice(0, r.ok ? 40 : 60)) {
        if (l) say(`      ${l}`);
      }
    } else {
      for (const l of excerpt(r.log)) say(l);
    }
    if (!r.ok) failures.push("render");
  } finally {
    for (const s of servers) s.kill();
  }
  stopIfRed();
}

// ---------------------------------------------------------------- e2e
// A few whole-journey specs first, so a broken main path answers in seconds
// rather than at the end of the full 42-file run.
const SMOKE = ["tests/e2e/smoke.spec.ts", "tests/e2e/workflow.spec.ts", "tests/e2e/sync.spec.ts", "tests/e2e/sync-pull-relaunch.spec.ts"];
if (only.includes("e2e")) {
  const smoke = await run("e2e-smoke", `pnpm exec playwright test --workers=${workers} ${SMOKE.join(" ")}`);
  say(`${smoke.ok ? "PASS" : "FAIL"}  e2e-smoke ${smoke.secs.toFixed(1).padStart(6)}s`);
  if (!smoke.ok) {
    for (const l of excerpt(smoke.log)) say(l);
    failures.push("e2e-smoke");
    stopIfRed();
  } else {
    const rest = execSync("git ls-files 'tests/e2e/*.spec.ts'", { cwd: ROOT })
      .toString()
      .trim()
      .split("\n")
      .filter((f) => !SMOKE.includes(f));
    const r = await run("e2e", `pnpm exec playwright test --workers=${workers} ${rest.join(" ")}`);
    say(`${r.ok ? "PASS" : "FAIL"}  e2e       ${r.secs.toFixed(1).padStart(6)}s  (workers=${workers})`);
    for (const l of excerpt(r.log).slice(0, r.ok ? 0 : 60)) say(l);
    if (!r.ok) failures.push("e2e");
  }
  stopIfRed();
}

// ---------------------------------------------------------------- screenshot
if (only.includes("screenshot")) {
  const r = await run("screenshot", "pnpm exec playwright test --config playwright.screenshot.config.ts");
  report(r);
  if (!r.ok) failures.push("screenshot");
}

finish();
