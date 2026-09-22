import { test as base } from "@playwright/test";
import { assertShimFsIntact } from "./shim-fs";

export * from "@playwright/test";

/**
 * Playwright's `test`, with one guarantee every browser suite inherits: after
 * the test body, no page of its context may have seen the virtual filesystem
 * lose a write (src/test/shim-fs.ts). A lost write made through the UI is
 * absorbed as an ordinary failed action while the in-memory database carries
 * on, so without this a test could pass on a database no reload would open.
 */
export const test = base.extend<{ shimFsIntact: void }>({
  shimFsIntact: [
    async ({ context }, use) => {
      await use();
      for (const page of context.pages()) await assertShimFsIntact(page, "the end of the test");
    },
    { auto: true },
  ],
});
