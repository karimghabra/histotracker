// The render tier needs no web server of its own: scripts/verify.mjs serves
// both builds (base and head) itself and passes their URLs via
// RENDER_DIFF_BUILDS.
import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: resolve(ROOT, "tests/render"),
  workers: 1,
  retries: 0,
  timeout: 600_000,
  reporter: [["list"]],
  outputDir: resolve(ROOT, "test-results/render-out"),
  use: { ...devices["Desktop Chrome"], trace: "off", screenshot: "off", video: "off" },
});
