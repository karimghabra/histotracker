import { defineConfig, devices } from "@playwright/test";
import base, { launchOptions } from "./playwright.config";

// The screenshot tier (pnpm verify's layer 4): the 26 captures E4 moved out of
// tests/e2e, so a person can still look, per the captain's ruling of
// 2026-09-14 ("its fine to take screenshots, as long as more lightweight e2e
// tests are performed first"). These flows are already proven correct by the
// assertions their tests/e2e companions carry; this tier exists only to
// produce the images, so it runs last, and only once the data, render and e2e
// layers are green (scripts/verify.mjs).
export default defineConfig({
  ...base,
  testDir: "./tests/screenshot",
  reporter: [["list"]],
  // Only the 26 explicit page.screenshot() calls the specs themselves make;
  // "on" would additionally capture one automatic end-of-test screenshot per
  // test regardless of those calls, which is not what moved here.
  use: { ...base.use, screenshot: "off", trace: "off", video: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions } }],
});
