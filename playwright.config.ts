import { defineConfig, devices } from "@playwright/test";

// Drives the REAL app in Chromium against a sql.js-backed Tauri SQL shim
// (see vite.config.playwright.ts). This is for interactive debugging and real
// UI regression checks — distinct from the jsdom vitest suite.
const PORT = 5599;

// Some sandboxes ship a pre-installed Chromium whose build number doesn't match
// the one this Playwright version would download (and can't fetch a new one).
// Point CHROMIUM_PATH at that binary to use it instead; unset everywhere else,
// so a normal `npx playwright install` checkout is unaffected.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
export const launchOptions = CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  // The app re-renders on background timers (auto-advance/sync), so a few
  // interactions are timing-sensitive; retry rather than chase per-frame waits.
  retries: 2,
  // 30s (the default) was already tight for the specs that walk a block all the
  // way from intake to Embedded Inventory — a dozen drags, each with a settle.
  // Asking for a stain now costs a trip through the Logs (#113/#114 moved the
  // control there), which tipped several of them over. This only lengthens the
  // ceiling; a passing test is unaffected.
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions } },
  ],
  webServer: {
    command: "npx vite --config vite.config.playwright.ts",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
