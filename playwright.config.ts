import { defineConfig, devices } from "@playwright/test";

// Drives the REAL app in Chromium against a sql.js-backed Tauri SQL shim
// (see vite.config.playwright.ts). This is for interactive debugging and real
// UI regression checks — distinct from the jsdom vitest suite.
const PORT = 5599;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  // The app re-renders on background timers (auto-advance/sync), so a few
  // interactions are timing-sensitive; retry rather than chase per-frame waits.
  retries: 2,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npx vite --config vite.config.playwright.ts",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
