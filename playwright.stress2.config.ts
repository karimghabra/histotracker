import { defineConfig, devices } from "@playwright/test";

/**
 * Stress harness v2 — built from what v1 got wrong.
 *
 * v1 (`playwright.stress.config.ts`) drove the UI along clean, hand-written
 * paths. It found real defects, but it also produced four false positives I had
 * to chase down, and — worse — one false NEGATIVE that nearly shipped: it
 * reported a stain date as "kept" when it had in fact been overwritten, because
 * both values fell in the same minute and `nowTimestamp()` stores minutes.
 *
 * v2 is different in kind, not in size:
 *
 *  1. **Sentinels, never coincidence.** Nothing concludes "unchanged" from two
 *     values that an action could plausibly have written identically. Every
 *     preservation check plants a value the code under test could not produce.
 *  2. **Falsify before reporting.** A finding is re-derived a second way before
 *     it is written down. v1's false positives were all single-source claims.
 *  3. **Fuzz the interleavings.** v1 tested one clean path at a time. Real work
 *     interleaves; a seeded random walk reaches states nobody would enumerate,
 *     and the seed makes any failure reproducible.
 *  4. **Probe what actually broke.** v1's fifteen invariants never fired once.
 *     v2's are derived from the defects that were real.
 *  5. **No static claims.** v1 asserted "there is no affordance for X" from a
 *     code reading; those strings were still there after X was implemented. v2
 *     attempts the capability and reports what happened.
 *
 * Run:  pnpm exec playwright test --config playwright.stress2.config.ts
 */
const PORT = 5599;

export default defineConfig({
  testDir: "./tests/stress2",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 900_000,
  reporter: [["list"]],
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
    // Same reason as playwright.stress3.config.ts: a hot-reloaded server serves
    // two instances of db.ts, and therefore two sql.js connections over one
    // virtual file. Every finding after that is about the server, not the app.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
