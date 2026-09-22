import { test as base } from "@playwright/test";
import { assertShimFsIntact } from "./shim-fs";

export * from "@playwright/test";

/**
 * Playwright's `test`, with one guarantee every browser suite inherits: when the
 * test body ends, no page it opened may have seen the virtual filesystem lose a
 * write (src/test/shim-fs.ts). A lost write made through the UI is absorbed as
 * an ordinary failed action while the in-memory database carries on, so without
 * this a test could pass on a database no reload would ever open.
 *
 * It checks every context of the browser, not only the one the fixture hands
 * out. Several specs open their own with `browser.newContext()` - the sync pair,
 * the relaunch specs, the export specs - and a guard that covered only the
 * fixture's context would leave exactly those free to lose a write in silence.
 *
 * ## A closed target is not a violation
 *
 * The check must not become a source of flakes itself, so a context or page that
 * the test closed before teardown is excluded BY CONSTRUCTION rather than by
 * catching an error and guessing what it meant: `browser.contexts()` lists only
 * the contexts still open, and `page.isClosed()` skips a page that has gone.
 * Nothing here treats "this target is closed" and "this harness lost a write" as
 * the same event - the first is never reported, and the second always is.
 *
 * `context` stays in the dependency list so the fixture Playwright hands the
 * test is still open while this runs: fixtures tear down in reverse order, so
 * depending on it keeps it alive until after the check.
 */
export const test = base.extend<{ shimFsIntact: void }>({
  shimFsIntact: [
    async ({ browser, context }, use) => {
      await use();
      void context; // held open for the duration of the check; see above
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
