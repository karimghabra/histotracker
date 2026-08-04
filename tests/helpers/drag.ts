import type { Page } from "@playwright/test";

/**
 * Wait until clicks reach the app again after a dnd-kit drop.
 *
 * dnd-kit's pointer sensor installs a capture-phase `click` listener on
 * `document` that calls stopPropagation, so the click that ends a drag never
 * reaches the app. It tears that listener down with `setTimeout(..., 50)` — so
 * for 50 ms after EVERY drop, every click anywhere in the app is swallowed
 * before React sees it.
 *
 * `page.mouse.up()` resolves immediately, well inside that window, which made
 * the very next click a coin flip: the DOM event was dispatched on the right
 * button, no error was raised, and nothing happened. That is the whole story
 * behind the intermittent "planned run" failure and behind the `toPass` loops
 * and `force: true` calls dotted around these specs — whose comments blame
 * background refetches and re-render churn, and are wrong.
 *
 * Polling for the behaviour (does a click propagate?) rather than sleeping 50 ms
 * keeps this correct if dnd-kit ever changes the timeout.
 */
export async function settleAfterDrop(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const probe = document.createElement("span");
      probe.style.cssText = "position:fixed;left:-9999px;top:-9999px";
      document.body.appendChild(probe);
      let reached = false;
      const onClick = () => {
        reached = true;
      };
      window.addEventListener("click", onClick);
      probe.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      window.removeEventListener("click", onClick);
      probe.remove();
      return reached;
    },
    undefined,
    { timeout: 5000 },
  );
}
