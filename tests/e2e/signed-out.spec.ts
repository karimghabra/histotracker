import { test, expect, type Page } from "@playwright/test";
import { openManage } from "../helpers/app";

/**
 * An unsigned session has a viewer's privileges (#128), and the checklist says
 * so in the right words (#127).
 *
 * The app signs itself out at launch (#76), so "nobody is signed in" is the
 * state every session STARTS in — it is not an edge case, it is the front door.
 * Until now that door was wide open: an unsigned user could section blocks,
 * consume extras, request stains, record images and mark work analyzed, and
 * every one of those landed in the record attributed to nobody at all. In an
 * application whose whole purpose is the record, an entry that cannot say who
 * made it is a hole that can never be filled in afterwards.
 *
 * Two things have to be true and the second is what makes the first safe to
 * ship: the gate closes, AND it opens again. A gate that locks the lab out of
 * its own workstation would be a far worse bug than the one being fixed, which
 * is exactly what happened on the first attempt here — gating "Manage users" on
 * the same flag hid the only route to signing in.
 */

const USER = "Alex Rivera";

async function signIn(page: Page): Promise<void> {
  await page.goto("/?freshdb=1");
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await openManage(page);
  await page.getByPlaceholder("Alex Rivera").fill(USER);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Signed-in user").locator("option", { hasText: USER })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByLabel("Signed-in user").selectOption({ label: USER });
}

async function addProject(page: Page, code: string): Promise<void> {
  await page.getByTitle("Add project").click();
  await expect(page.getByRole("heading", { name: "Add Project" })).toBeVisible();
  await page.locator('input[placeholder="EE"]').fill(code);
  await page.locator('input[placeholder="Enthesis Engineering"]').fill(`Project ${code}`);
  await page.getByRole("button", { name: "Save Project" }).click();
}

async function signOut(page: Page): Promise<void> {
  await page.getByLabel("Signed-in user").selectOption("");
  await expect(page.getByLabel("Signed-in user")).toHaveValue("");
  // A manual sign-out raises the sign-back-in prompt (#108). Dismiss it, since
  // what is being tested is the board BEHIND it.
  const keepReading = page.getByRole("button", { name: "Keep reading" });
  if (await keepReading.count()) await keepReading.click();
  await expect(keepReading).toHaveCount(0);
}

test("#128: an unsigned session cannot change the record, and can still sign in", async ({
  page,
}) => {
  await signIn(page);
  await addProject(page, "EE");

  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("signed-in block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("signed-in block").first()).toBeVisible();

  await signOut(page);

  // ---- the gate is closed -------------------------------------------------
  // Creating work is refused at its own control rather than by a rejected
  // promise nobody is awaiting.
  await expect(page.getByRole("button", { name: "New Sample" })).toBeDisabled();
  await expect(page.getByTitle(/Sign in before making modifications/)).toBeVisible();

  // …and the block that already exists is still fully readable. Read-only is
  // the point; blank is not.
  await expect(page.getByText("signed-in block").first()).toBeVisible();

  // The BACKSTOP — that `db.ts` itself refuses, not merely that the button is
  // greyed — is asserted in tests/stress3/32-hostile.spec.ts, not here.
  //
  // It cannot be checked from this suite. Reaching the data layer means
  // `import("/src/lib/db.ts")` from the page, and this config reuses a running
  // dev server on purpose (so `--ui` works against `pnpm dev:browser`). A server
  // that has hot-reloaded since it started serves BOTH `db.ts` and `db.ts?t=…`,
  // which are two modules with two copies of the signed-out flag — the app sets
  // one and the test reads the other. The assertion then fails for a reason that
  // has nothing to do with the app, which is worse than not making it. The
  // stress configs start a fresh server every run, so it belongs there.

  // ---- the gate opens again ----------------------------------------------
  // The route to signing in must survive the gate that signing in opens, or the
  // workstation locks its own users out. This is not hypothetical: the first
  // attempt at #128 gated "Manage users" on the same flag, and every spec sat
  // waiting sixty seconds for a button that was never going to appear.
  await openManage(page);
  await expect(page.getByPlaceholder("Alex Rivera")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByLabel("Signed-in user").selectOption({ label: USER });
  await expect(page.getByRole("button", { name: "New Sample" })).toBeEnabled();

  // And the work it refused a moment ago now goes through.
  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("second block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("second block").first()).toBeVisible();
});

test("#127: protocol steps are attributed to the signed-in user, with no operator box", async ({
  page,
}) => {
  await signIn(page);
  await addProject(page, "EE");

  // The free-text "Operator" field is gone from the whole app. It was a second,
  // editable identity beside the real one — typeable over, able to go stale, and
  // the only thing standing between an unsigned session and a completed step.
  await expect(page.getByLabel("Active operator")).toHaveCount(0);

  await page.getByRole("button", { name: "New Sample" }).click();
  await page.getByPlaceholder("e.g. 2 week Stretch PLA").fill("checklist block");
  await page.getByRole("button", { name: /Create Sample/ }).click();
  await expect(page.getByText("checklist block").first()).toBeVisible();

  await signOut(page);

  // The message lives on the checklist itself, so open the block that carries
  // one. Signed out, it names the fix rather than sending the user to a
  // workstation they are already sitting at.
  await page.getByText("checklist block").first().click();
  await expect(page.getByText("Sign in before making modifications.").first()).toBeVisible();
  await expect(page.getByText(/Read-only viewer/)).toHaveCount(0);
});
