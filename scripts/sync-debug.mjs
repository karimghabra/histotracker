#!/usr/bin/env node
// Histometer shared-data-sync debug harness.
//
// Reproduces, outside the Tauri app, the exact GitHub REST calls the Rust
// backend (src-tauri/src/sync.rs) and the high-level TS flow (src/lib/githubSync.ts)
// make against the private data repo. Use it to isolate GitHub-interaction
// problems (auth, release assets, manifest, request inbox) from app/UI bugs.
//
// The token is read from the environment and NEVER printed. Run it wherever the
// token lives — ideally your own machine — so the credential stays with you:
//
//   HISTO_TOKEN=github_pat_xxx node scripts/sync-debug.mjs selftest
//
// Env:
//   HISTO_TOKEN   (required)  fine-grained PAT, Contents: read/write on the repo
//   HISTO_OWNER   (default: karimghabra)
//   HISTO_REPO    (default: Histoarchives)
//   HISTO_TAG     (default: snapshot-latest)
//
// Commands:
//   validate                 GET the repo; prints full_name (setup check)
//   status                   show manifest.json, requests/ inbox, release assets
//   selftest                 non-destructive round-trip: contents put/get/list/delete
//                            + release create/asset upload+download+delete + manifest
//   request <sample> <assay> [note]   drop a viewer request file into requests/
//   drain [--apply]          list+read requests (delete them only with --apply)

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const UA = "Histometer-Sync-Debug";
const APIV = "2022-11-28";

const TOKEN = process.env.HISTO_TOKEN;
const OWNER = process.env.HISTO_OWNER || "karimghabra";
const REPO = process.env.HISTO_REPO || "Histoarchives";
const TAG = process.env.HISTO_TAG || "snapshot-latest";

if (!TOKEN) {
  console.error("ERROR: set HISTO_TOKEN (fine-grained PAT with Contents read/write).");
  process.exit(2);
}

const b64 = (buf) => Buffer.from(buf).toString("base64");
const fromB64 = (s) => Buffer.from(String(s).replace(/\s/g, ""), "base64");

function jsonHeaders() {
  return {
    "User-Agent": UA,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": APIV,
    Authorization: `Bearer ${TOKEN}`,
  };
}

async function req(method, url, { headers = {}, body, raw = false } = {}) {
  const res = await fetch(url, { method, headers: { ...jsonHeaders(), ...headers }, body });
  const text = raw ? null : await res.text();
  return { status: res.status, ok: res.ok, res, text };
}

// ---- Contents API (mirrors github_get_file / put / delete / list) ----
async function ghGetFile(path) {
  const { status, ok, text } = await req("GET", `${API}/repos/${OWNER}/${REPO}/contents/${path}`);
  if (status === 404) return null;
  if (!ok) throw new Error(`GET ${path} -> ${status} ${text}`);
  const j = JSON.parse(text);
  return { content: fromB64(j.content).toString("utf8"), sha: j.sha };
}
async function ghPutFile(path, content, sha, message) {
  const body = { message, content: b64(content) };
  if (sha) body.sha = sha;
  const { ok, status, text } = await req("PUT", `${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!ok) throw new Error(`PUT ${path} -> ${status} ${text}`);
  return JSON.parse(text).content.sha;
}
async function ghDeleteFile(path, sha, message) {
  const { ok, status, text } = await req("DELETE", `${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha }),
  });
  if (!ok) throw new Error(`DELETE ${path} -> ${status} ${text}`);
}
async function ghListDir(path) {
  const { status, ok, text } = await req("GET", `${API}/repos/${OWNER}/${REPO}/contents/${path}`);
  if (status === 404) return [];
  if (!ok) throw new Error(`list ${path} -> ${status} ${text}`);
  return JSON.parse(text).filter((i) => i.type === "file").map((i) => ({ name: i.name, path: i.path, sha: i.sha }));
}

// ---- Releases API (mirrors get_or_create_release / upload / download) ----
async function getOrCreateRelease(tag) {
  let r = await req("GET", `${API}/repos/${OWNER}/${REPO}/releases/tags/${tag}`);
  if (r.ok) return JSON.parse(r.text);
  if (r.status !== 404) throw new Error(`get release ${tag} -> ${r.status} ${r.text}`);
  r = await req("POST", `${API}/repos/${OWNER}/${REPO}/releases`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag_name: tag, name: tag, body: "Histometer snapshot (debug).", prerelease: false }),
  });
  if (!r.ok) throw new Error(`create release ${tag} -> ${r.status} ${r.text}`);
  return JSON.parse(r.text);
}
async function uploadAsset(tag, name, bytes, contentType) {
  const rel = await getOrCreateRelease(tag);
  for (const a of rel.assets || []) {
    if (a.name === name) await req("DELETE", `${API}/repos/${OWNER}/${REPO}/releases/assets/${a.id}`);
  }
  const r = await req("POST", `${UPLOADS}/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  if (!r.ok) throw new Error(`upload ${name} -> ${r.status} ${r.text}`);
}
async function downloadAsset(tag, name) {
  const rel = JSON.parse((await req("GET", `${API}/repos/${OWNER}/${REPO}/releases/tags/${tag}`)).text);
  const asset = (rel.assets || []).find((a) => a.name === name);
  if (!asset) throw new Error(`asset ${name} not found on ${tag}`);
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`, {
    headers: { ...jsonHeaders(), Accept: "application/octet-stream" },
  });
  if (!res.ok) throw new Error(`download ${name} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---- Commands ----
async function cmdValidate() {
  const { ok, status, text } = await req("GET", `${API}/repos/${OWNER}/${REPO}`);
  if (!ok) throw new Error(`repo unreachable -> HTTP ${status}. Check repo name + token scope.`);
  const j = JSON.parse(text);
  console.log(`OK  ${j.full_name}  (private=${j.private}, perms.push=${j.permissions?.push})`);
}

async function cmdStatus() {
  const manifest = await ghGetFile("manifest.json");
  console.log("manifest.json:", manifest ? manifest.content.trim() : "(absent)");
  const reqs = await ghListDir("requests");
  console.log(`requests/: ${reqs.length} file(s)`, reqs.map((r) => r.name).join(", "));
  const rel = await req("GET", `${API}/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  if (rel.ok) {
    const j = JSON.parse(rel.text);
    console.log(`release ${TAG}: assets ->`, (j.assets || []).map((a) => `${a.name} (${a.size}B)`).join(", ") || "(none)");
  } else {
    console.log(`release ${TAG}: (absent, HTTP ${rel.status})`);
  }
}

async function cmdSelftest() {
  const stamp = Date.now();
  const probe = `requests/_debug-${stamp}.json`;
  console.log("1) validate…"); await cmdValidate();
  console.log("2) contents put…"); const sha = await ghPutFile(probe, JSON.stringify({ probe: stamp }) + "\n", undefined, "debug probe");
  console.log("   put sha:", sha.slice(0, 12));
  console.log("3) contents get…"); const got = await ghGetFile(probe); console.log("   read back:", got.content.trim());
  console.log("4) contents list…"); const list = await ghListDir("requests"); console.log("   requests count:", list.length);
  console.log("5) release create + asset upload…");
  const bytes = Buffer.from(`histometer-debug-${stamp}`);
  await uploadAsset(TAG, `debug-${stamp}.bin`, bytes, "application/octet-stream");
  console.log("6) release asset download…");
  const dl = await downloadAsset(TAG, `debug-${stamp}.bin`);
  console.log("   round-trip match:", dl.equals(bytes));
  console.log("7) manifest write+read…");
  const existing = await ghGetFile("manifest.json");
  const version = new Date().toISOString();
  await ghPutFile("manifest.json", JSON.stringify({ version, updated_at: version, db_asset: "histometer.db", workbook_asset: "histometer-status.xlsx" }, null, 2) + "\n", existing?.sha, `debug manifest ${version}`);
  console.log("   manifest version:", version);
  console.log("8) cleanup probe file + debug asset…");
  const fresh = await ghGetFile(probe);
  await ghDeleteFile(probe, fresh.sha, "debug cleanup");
  const rel = JSON.parse((await req("GET", `${API}/repos/${OWNER}/${REPO}/releases/tags/${TAG}`)).text);
  for (const a of rel.assets || []) if (a.name === `debug-${stamp}.bin`) await req("DELETE", `${API}/repos/${OWNER}/${REPO}/releases/assets/${a.id}`);
  console.log("\nSELFTEST PASSED — token + repo + contents + releases + manifest all work.");
}

async function cmdRequest(sample, assay, note = "") {
  if (!sample || !assay) throw new Error("usage: request <sample> <assay> [note]");
  const uuid = (globalThis.crypto?.randomUUID?.() ?? `dbg-${Date.now()}`);
  const payload = { uuid, sample_code: sample, slide_code: "", requested_assay: assay, requester_name: "debug", note, created_at: new Date().toISOString() };
  await ghPutFile(`requests/${uuid}.json`, JSON.stringify(payload, null, 2) + "\n", undefined, `debug request ${sample}`);
  console.log("submitted request", uuid);
}

async function cmdDrain(apply) {
  const entries = await ghListDir("requests");
  console.log(`inbox: ${entries.length} file(s)`);
  for (const e of entries) {
    if (!e.name.endsWith(".json")) continue;
    const f = await ghGetFile(e.path);
    console.log(` - ${e.name}: ${f.content.replace(/\s+/g, " ").slice(0, 120)}`);
    if (apply) { await ghDeleteFile(e.path, f.sha, `ingest ${e.name}`); console.log("   deleted"); }
  }
  if (!apply) console.log("(dry run — pass --apply to delete after reading)");
}

const [cmd, ...args] = process.argv.slice(2);
const run = {
  validate: () => cmdValidate(),
  status: () => cmdStatus(),
  selftest: () => cmdSelftest(),
  request: () => cmdRequest(args[0], args[1], args.slice(2).join(" ")),
  drain: () => cmdDrain(args.includes("--apply")),
}[cmd];

if (!run) {
  console.error("commands: validate | status | selftest | request <sample> <assay> [note] | drain [--apply]");
  process.exit(2);
}
run().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
