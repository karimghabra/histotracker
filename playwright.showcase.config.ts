import { defineConfig, devices } from "@playwright/test";

// Standalone config for the screenshot/tutorial walkthrough. Kept OUT of the
// main e2e suite (which uses testDir ./tests/e2e) so it never gates a release —
// run it on demand with:  npx playwright test --config playwright.showcase.config.ts
const PORT = 5599;

export default defineConfig({
  testDir: "./tests/tutorial",
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite --config vite.config.playwright.ts",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
