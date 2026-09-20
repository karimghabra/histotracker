import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Fake GitHub remote for the sync harness.
//
// The workstation/viewer sync moves the raw SQLite file through a set of Rust
// `github_*` commands. In the browser those are normally no-ops, so sync can't
// actually be exercised. This dev-only middleware is a tiny in-memory stand-in
// for the shared data repo: it holds committed files (manifest, requests, the
// workstation claim) and release assets (the DB + workbook). Two separate
// Playwright browser contexts hit the SAME Vite server, so this single store is
// their shared remote — while each context keeps its own local DB (shim-fs in
// its own localStorage). The store is namespaced by `?ns=` so parallel tests
// don't collide. Nothing here ships in production.
// ---------------------------------------------------------------------------
interface FakeStore {
  files: Map<string, { content: string; sha: string }>;
  assets: Map<string, number[]>;
  seq: number;
}

function fakeGithubPlugin(): Plugin {
  const stores = new Map<string, FakeStore>();
  const store = (ns: string): FakeStore => {
    let s = stores.get(ns);
    if (!s) {
      s = { files: new Map(), assets: new Map(), seq: 0 };
      stores.set(ns, s);
    }
    return s;
  };
  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });

  return {
    name: "fake-github",
    configureServer(server) {
      server.middlewares.use("/__fakegh", async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "", "http://localhost");
        const cmd = url.pathname.replace(/^\//, "");
        const ns = url.searchParams.get("ns") ?? "default";
        const s = store(ns);
        const body = await readBody(req);
        const send = (obj: unknown) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(obj ?? null));
        };
        switch (cmd) {
          case "reset":
            stores.delete(ns);
            return send({ ok: true });
          case "get_file": {
            const f = s.files.get(String(body.path));
            return send(f ? { content: f.content, sha: f.sha } : null);
          }
          case "put_file": {
            s.seq += 1;
            const sha = `sha-${s.seq}`;
            s.files.set(String(body.path), { content: String(body.content ?? ""), sha });
            return send(sha);
          }
          case "delete_file":
            s.files.delete(String(body.path));
            return send(null);
          case "list_dir": {
            const prefix = `${String(body.path).replace(/\/$/, "")}/`;
            const out = [];
            for (const [p, v] of s.files) {
              if (p.startsWith(prefix)) out.push({ name: p.split("/").pop(), path: p, sha: v.sha });
            }
            return send(out);
          }
          case "upload_release_asset":
            s.assets.set(`${body.tag}/${body.assetName}`, (body.bytes as number[]) ?? []);
            return send(null);
          case "download_release_asset":
            return send(s.assets.get(`${body.tag}/${body.assetName}`) ?? []);
          case "validate":
            return send("ok");
          default:
            res.statusCode = 404;
            return send({ error: `unknown command ${cmd}` });
        }
      });
    },
  };
}

// Browser-driveable build of the app for Playwright. Identical to the real
// frontend except `@tauri-apps/plugin-sql` is aliased to a sql.js-backed shim
// (src/test/browser-sql-shim.ts) so the app runs in plain Chromium. Nothing
// here affects `tauri dev` / production, which use vite.config.ts.
export default defineConfig({
  plugins: [react(), tailwindcss(), fakeGithubPlugin()],
  resolve: {
    alias: {
      "@tauri-apps/plugin-sql": fileURLToPath(
        new URL("./src/test/browser-sql-shim.ts", import.meta.url),
      ),
      "@tauri-apps/api/core": fileURLToPath(
        new URL("./src/test/browser-core-shim.ts", import.meta.url),
      ),
    },
  },
  optimizeDeps: {
    // sql.js ships as CJS; let Vite pre-bundle it for the browser.
    include: ["sql.js"],
  },
  server: {
    port: 5599,
    strictPort: true,
    watch: {
      // Never watch the Rust build tree. It holds locked .exe files that
      // chokidar cannot open, and `cargo check` rewrites them constantly — so a
      // cargo build running alongside the e2e suite killed the dev server with
      // `EBUSY: resource busy or locked, watch …/build_script_build.exe`, and
      // every remaining test failed with ERR_CONNECTION_REFUSED. Nothing under
      // these paths is part of the frontend bundle, so there is nothing to gain
      // by watching them.
      ignored: ["**/src-tauri/target/**", "**/target/**", "**/test-results/**"],
    },
  },
});
