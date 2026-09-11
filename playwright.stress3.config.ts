import { defineConfig, devices } from "@playwright/test";

/**
 * Stress harness v3 — the explorer.
 *
 * v2 was built to fix v1's method, and it worked, but it left a gap I created
 * deliberately and then had to admit: **v2 does not click**. Across five spec
 * files it performs exactly seven UI interactions, all of them signing in. Every
 * action after that goes through `page.evaluate` into the data layer.
 *
 * That bought reproducibility and depth — a seeded walk of thousands of actions
 * — at the cost of the one class of bug this project has reported most often:
 * a correct database rendered wrongly (#117, #118, #119). Nothing in v2 could
 * have found any of them.
 *
 * v3 closes that, and widens the walk:
 *
 *  1. **The view is checked against the data.** Every N mutations each surface is
 *     opened and compared with a count recomputed from the store — and, on the
 *     board, three ways: the database, the column's own badge, and the cards
 *     actually rendered. Badge-vs-cards is a pure view bug; badge-vs-database is
 *     the two disagreeing about the world.
 *  2. **More walkers, wider moves.** Undo and redo, archiving, renaming a project
 *     under live work, deactivating agents that racks depend on, reverting a
 *     block's stage while its slides are downstream — the cross-cutting changes
 *     that invalidate assumptions somewhere else entirely.
 *  3. **Undo is driven through the real button**, because that is the only honest
 *     way to reach it: the stack lives in React, not in the data layer.
 *
 * Run:  pnpm exec playwright test --config playwright.stress3.config.ts
 */
const PORT = 5599;

export default defineConfig({
  testDir: "./tests/stress3",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 1_800_000,
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
    // NOT reused, unlike every other config here — and this one cost a day.
    //
    // Reusing a dev server that has hot-reloaded since it started leaves Vite
    // serving two instances of the same module (`db.ts` and `db.ts?t=…`). The
    // SQL shim keeps its sql.js connection in module scope, so two instances
    // means TWO databases over one virtual file: the walk writes through one and
    // the app's Undo writes through the other. It reported, with a straight
    // face, that redo emptied the entire database — the app was flawless and the
    // server was lying. A fresh server per run costs about five seconds and
    // makes a finding mean something.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
