import { expect, type Page } from "@playwright/test";

/**
 * Driving the rack panel's slide selection.
 *
 * The per-slide "Move…" dropdown is gone (0.14.1): it put a select box on every
 * row — twenty-four of them on a full rack — for an action that is occasional,
 * and it could only ever move one slide. Reassigning now goes through the same
 * ticked list that splits and removes, so the specs that used to grab a combobox
 * off a row come through here instead.
 *
 * Defined once because eight specs did it by hand, which is eight chances for
 * the next change to this panel to look like eight unrelated failures.
 */

const drawer = (page: Page) =>
  page.locator("div.border-l").filter({ has: page.getByText("Assay slides") }).last();

/** The slide codes listed in the open rack panel, in the order shown. */
export async function rackSlideCodes(page: Page): Promise<string[]> {
  const codes = await drawer(page)
    .locator("span.block.truncate.text-xs.font-semibold")
    .allInnerTexts();
  return codes.map((code) => code.trim()).filter(Boolean);
}

/** Enter selection mode, if it is not already on. */
async function startSelecting(page: Page): Promise<void> {
  const enter = drawer(page).getByRole("button", { name: "Select slides", exact: true });
  if (await enter.count()) await enter.click();
  await expect(drawer(page).getByLabel("Reassign the selected slides")).toBeVisible();
}

/**
 * Move the named slides onto another agent, or back to extras.
 *
 * `value` is the option value: `stain:PAS`, `ihc:CD31`, or `extra`.
 * Returns the codes it actually ticked, so a caller that asked for "whatever is
 * in this rack" can say what moved.
 */
export async function reassignInRack(
  page: Page,
  codes: string[],
  value: string,
): Promise<string[]> {
  await startSelecting(page);
  const ticked: string[] = [];
  for (const code of codes) {
    const box = drawer(page).getByLabel(`Select ${code}`, { exact: true });
    if ((await box.count()) === 0) continue;
    await box.check();
    ticked.push(code);
  }
  expect(ticked.length, `none of ${codes.join(", ")} are in this rack`).toBeGreaterThan(0);
  await drawer(page).getByLabel("Reassign the selected slides").selectOption(value);
  // The panel leaves selection mode once the move lands.
  await expect(drawer(page).getByLabel("Reassign the selected slides")).toHaveCount(0, {
    timeout: 15_000,
  });
  return ticked;
}

/** Move the first slide in the open rack, and say which one it was. */
export async function reassignFirstInRack(page: Page, value: string): Promise<string> {
  // The slide list comes from an async query; wait for it before the one-shot
  // read below, or a slow tick reads the list as empty and this silently no-ops.
  await expect(drawer(page).locator("span.block.truncate.text-xs.font-semibold").first()).toBeVisible();
  const codes = await rackSlideCodes(page);
  expect(codes.length, "slides listed in the open rack").toBeGreaterThan(0);
  const [moved] = await reassignInRack(page, [codes[0]], value);
  expect(moved, "the slide that was moved").toBeTruthy();
  return moved!;
}
