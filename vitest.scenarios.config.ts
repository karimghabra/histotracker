import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Data-layer scenarios on the REAL src/lib/db.ts, in Node, on a real SQLite file
// (tests/scenarios). It borrows the compat harness's Tauri shims (tests/compat), so
// there is no hand port of a query to drift from db.ts (#81, #139), and no browser.
// Run it with `pnpm test:scenarios`; the reporter prints one line when green.
const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

process.env.COMPACT_LABEL ??= "scenarios";

export default defineConfig({
  resolve: {
    alias: {
      "@tauri-apps/plugin-sql": at("./tests/compat/tauri-sql-shim.ts"),
      "@tauri-apps/api/core": at("./tests/compat/tauri-core-shim.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/scenarios/**/*.test.ts"],
    setupFiles: ["./tests/compat/setup.ts"],
    reporters: [at("./scripts/compact-vitest-reporter.ts")],
    includeTaskLocation: true,
    testTimeout: 60_000,
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
