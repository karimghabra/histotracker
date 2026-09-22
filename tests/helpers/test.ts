import { test as base } from "@playwright/test";
import { assertShimFsIntact, watchShimFs, type ShimFsWatch } from "./shim-fs";

export * from "@playwright/test";

/**
 * Playwright's `test`, with one guarantee every browser suite inherits: when the
 * test body ends, no page it opened may have seen the virtual filesystem lose a
 * write (src/test/shim-fs.ts). A lost write made through the UI is absorbed as
 * an ordinary failed action while the in-memory database carries on, so without
 * this a test could pass on a database no reload would ever open.
 *
 * It watches the latch as it is set, in the fixture's context and in every one
 * the test creates (`watchShimFs`), not by sampling the contexts still open at
 * teardown: several specs open their own with `browser.newContext()` - the sync
 * pair, the relaunch specs, the export specs - and close them before the body
 * ends, which would take a lost write out of reach of any look afterwards.
 *
 * The pages still open are sampled as well, for a loss whose announcement has
 * not reached the watch by the time the body returns. A closed page is skipped
 * there by construction (`page.isClosed()`), never by catching an error and
 * guessing what it meant; the watch has already heard from it.
 *
 * A spec that loses a write on purpose to test this machinery takes it back with
 * `shimFs.takeLost()` and asserts on what it got.
 *
 * `context` stays in the dependency list so the fixture Playwright hands the
 * test is still open while this runs: fixtures tear down in reverse order, so
 * depending on it keeps it alive until after the check.
 */
export const test = base.extend<{ shimFs: ShimFsWatch }>({
  shimFs: [
    async ({ browser, context }, use) => {
      const watch = watchShimFs(browser, context);
      try {
        await use(watch);
      } finally {
        watch.stop();
      }
      watch.assertIntact("the end of the test");
      for (const open of browser.contexts()) {
        for (const page of open.pages()) {
          if (page.isClosed()) continue;
          await assertShimFsIntact(page, "the end of the test");
        }
      }
    },
    { auto: true },
  ],
});
