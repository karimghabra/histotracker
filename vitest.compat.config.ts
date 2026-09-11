import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Release-compatibility harness (tests/compat/). Runs the REAL data layer of a
// released build and of this branch, in Node, against the same SQLite files.
// Start it with `pnpm test:compat` (scripts/release-compat.mjs picks the
// release); running this config directly tests the release in COMPAT_RELEASE.
export default defineConfig({
  resolve: {
    alias: {
      "@tauri-apps/plugin-sql": fileURLToPath(new URL("./tests/compat/tauri-sql-shim.ts", import.meta.url)),
      "@tauri-apps/api/core": fileURLToPath(new URL("./tests/compat/tauri-core-shim.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/compat/**/*.test.ts"],
    setupFiles: ["./tests/compat/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One story, told in order, on shared files.
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
