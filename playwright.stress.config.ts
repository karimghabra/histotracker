import { defineConfig, devices } from "@playwright/test";

// The stress suite. Separate from playwright.config.ts on purpose:
//
//  - it is SLOW (it fills the database up rather than proving one behaviour),
//    so it must not sit in the CI path that gates every push;
//  - it runs with retries OFF, because a stress run that quietly passes on the
//    second attempt has hidden exactly the thing it was built to find;
//  - it fails on console errors, which the functional suite tolerates.
//
// Run it with:  pnpm exec playwright test --config playwright.stress.config.ts
const PORT = 5599;

export default defineConfig({
  testDir: "./tests/stress",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  reporter: [["list"]],
  // Short per-action limits on purpose: a stress run that hangs for ten minutes
  // on one missing button tells you far less than one that fails in fifteen
  // seconds and moves on to the next thing.
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    actionTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx vite --config vite.config.playwright.ts",
    url: `http://localhost:${PORT}`,
    // Same reason as playwright.stress3.config.ts: a server that has hot-reloaded
    // serves two copies of db.ts, and therefore two sql.js connections over one
    // virtual file. It failed the stack-merge spec exactly once that way, and
    // passed on a clean server with nothing changed.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
