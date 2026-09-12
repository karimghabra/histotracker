import { expect, type Page } from "@playwright/test";
import { sql, type Finding } from "../stress2/driver";

/**
 * "The view tells the truth about the data" — as an invariant.
 *
 * This is the half v2 was missing. A data-layer fuzzer can prove the database is
 * coherent and still miss the bug the user actually reports, because the bug is
 * in what the screen says about a perfectly good database. The three biggest
 * issues in this project's history (#117, #118, #119) were all exactly that.
 *
 * Each check recomputes an expected count from the store using the app's OWN
 * predicate, then compares it with what is on screen. Two rules keep this from
 * becoming a false-positive machine — the failure mode v1 taught me:
 *
 *   · Check DERIVED values (counts, membership, emptiness), never layout.
 *   · On a mismatch, re-derive a second way before reporting it.
 *
 * On the board there is a third witness: each column renders its own count
 * badge. So the database, the badge, and the cards actually drawn can be
 * compared against each other, and the two possible disagreements mean different
 * things — badge≠cards is React drawing something other than what it counted;
 * badge≠database is the view and the store disagreeing about the world.
 */

export type ViewCheck = {
  where: string;
  detail: string;
  ok: boolean;
};

// `.last()`, not `.first()`: several ancestors up the tree also carry
// `rounded-lg`, and document order puts the outermost first. The innermost div
// that contains this heading is the column itself — anything wider would sweep
// in the neighbouring columns' cards.
const column = (page: Page, title: string) =>
  page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .last();

/** The count a column prints in its own header. */
async function badgeCount(page: Page, title: string): Promise<number | null> {
  // Anchored on the heading's own parent (QueueColumn's header row), so the
  // badge read is guaranteed to be THIS column's. Reaching for the first
  // `span.ml-auto` under a loosely-matched ancestor found the sidebar's instead,
  // and reported every column as zero.
  const header = page
    .getByRole("heading", { name: title, exact: true })
    .first()
    .locator("xpath=..");
  const text = await header
    .locator("span.ml-auto")
    .first()
    .innerText()
    .catch(() => "");
  const n = Number(text.trim());
  return Number.isFinite(n) ? n : null;
}

/** The cards actually drawn in a column. */
async function cardCount(page: Page, title: string): Promise<number> {
  return column(page, title).locator("[aria-selected]").count();
}

/**
 * Force the view to re-read the store.
 *
 * The explorer calls `db.ts` directly, which is what buys it its depth — but it
 * means nothing ever calls `useActions`' `invalidate()`, so React Query happily
 * serves the cache it filled before the walk started. Left alone, every column
 * reads zero and every "finding" is the harness's own doing. (It was: the first
 * run reported six.)
 *
 * A remount is the honest way to clear it — it is precisely what the app does on
 * launch, and React still computes the whole view from the store, so a rendering
 * bug is as visible as ever. `/` and not `/?freshdb=1`, which would wipe the
 * database instead of reopening it.
 *
 * What this consequently CANNOT catch: a view that goes stale because a mutation
 * forgot to invalidate. That bug is unreachable from here by construction, since
 * the harness bypasses the layer that would have done the invalidating. It
 * belongs to `tests/e2e`, which drives the buttons.
 */
export async function refreshView(page: Page, user = "Alex Rivera"): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const signIn = page.getByLabel("Signed-in user");
  if ((await signIn.count()) > 0) {
    await signIn.selectOption({ label: user }).catch(() => {});
  }
  await page.waitForTimeout(250);
}

export async function goBoard(page: Page): Promise<void> {
  await page.locator("nav").getByRole("button", { name: "Board" }).click();
  await expect(page.getByRole("heading", { name: "Pre-processing", exact: true })).toBeVisible();
}

export async function goLogs(page: Page): Promise<void> {
  await page.locator("nav").getByRole("button", { name: "Logs" }).click();
  await expect(page.getByPlaceholder(/Search code/)).toBeVisible();
}

/** Shut any drawer, so it cannot cover a column or hold a stale selection. */
export async function closeDrawer(page: Page): Promise<void> {
  const panel = page
    .locator("div.border-l")
    .filter({ has: page.getByRole("heading", { name: "Timeline" }) });
  if (await panel.count()) {
    await panel.locator("button:has(svg.lucide-x)").first().click();
    await expect(panel).toHaveCount(0);
  }
}

/**
 * Look at every project. The comparison is with the whole store, and since #131
 * the board shows only the project picked in the sidebar; with none remembered
 * the app opens on the first one (#84), so the board held a fifth of the blocks.
 */
async function showAllProjects(page: Page): Promise<void> {
  const all = page.locator("aside").getByRole("button", { name: "All projects", exact: true });
  if ((await all.count()) === 0) return; // no projects, nothing to filter
  if ((await all.getAttribute("aria-current")) !== "true") await all.click();
  await expect(all).toHaveAttribute("aria-current", "true");
}

/**
 * Compare every surface with the store.
 *
 * Returns findings rather than throwing, so one lying view does not hide the
 * other five.
 */
export async function checkViewsAgainstData(
  page: Page,
  findings: Finding[],
  where: string,
  // The undo specs pass `false`: undo goes through the app's own `invalidate()`,
  // so the view there is already fresh by the app's own doing — and a remount
  // would throw away the React-side undo stack the test is measuring.
  opts: { refresh?: boolean } = {},
): Promise<number> {
  let bad = 0;
  const report = (detail: string, corroboration: string) => {
    bad += 1;
    findings.push({ where, severity: "defect", detail, corroboration });
  };

  if (opts.refresh !== false) await refreshView(page);
  await closeDrawer(page);
  await showAllProjects(page);
  await goBoard(page);
  // A board render can lag a mutation by a tick; give React a beat before
  // accusing it of lying. This is a settle, not a retry-until-pass: the counts
  // are read once, afterwards.
  await page.waitForTimeout(400);

  // ---- board columns, three ways -----------------------------------------
  // Each entry recomputes the column's population with the same predicate the
  // app uses, so a disagreement is a real disagreement and not two different
  // questions.
  // Only Embedded Inventory is compared against the database, and that is a
  // deliberate limit.
  //
  // Its population is `listOpenSamples()` narrowed to one stage, so the
  // predicate below is four conditions that can be read against the source and
  // agreed with. The rack columns are not: `listOpenSlideStacks()` is forty
  // lines with five archival sub-clauses about racks whose members belong to
  // other people's blocks, and re-typing it here would not test that logic — it
  // would fork it, and every disagreement afterwards would be between two copies
  // of a query rather than between the screen and the truth. Those columns are
  // covered by badge-versus-cards instead, which needs no predicate at all
  // because the badge is computed from the very query the cards come from.
  const columns: Array<{ title: string; query: string }> = [
    {
      title: "Embedded Inventory",
      query: `SELECT COUNT(*) AS n FROM samples s JOIN projects p ON p.id = s.project_id
               WHERE s.current_stage = 'embedded' AND s.archived_at IS NULL
                 AND p.is_active = 1 AND s.block_exhausted = 0`,
    },
  ];

  for (const col of columns) {
    const badge = await badgeCount(page, col.title);
    const cards = await cardCount(page, col.title);
    const rows = await sql<{ n: number }>(page, col.query);
    const expected = Number(rows[0]?.n ?? 0);

    // The strongest signal, and the one needing no domain agreement at all: the
    // column counted N and drew M.
    if (badge !== null && badge !== cards) {
      report(
        `"${col.title}" says ${badge} in its header and draws ${cards} cards — the view ` +
          `disagrees with itself`,
        "badge and rendered cards read from the same DOM in the same pass",
      );
    }
    if (badge !== null && badge !== expected) {
      report(
        `"${col.title}" says ${badge} but the database holds ${expected}`,
        `recomputed with the column's own predicate: ${col.query.replace(/\s+/g, " ").trim()}`,
      );
    }
  }

  // ---- Logs: one row per sample ------------------------------------------
  await goLogs(page);
  await page.waitForTimeout(300);
  const logRows = await page
    .locator("tbody tr")
    .filter({ hasNot: page.locator("td[colspan]") })
    .count();
  // Decomposed rather than asserted against one predicate.
  //
  // The first version of this check demanded `p.is_active = 1` as well, and
  // reported a defect the moment a walker deactivated a project. That was the
  // check being wrong, not the app: the Logs are the permanent record, and
  // deactivating a project is about board clutter. Naming each candidate and
  // saying which one the screen matches means a disagreement points at a
  // specific rule instead of at a number.
  const [tallies] = await sql<{
    total: number;
    live: number;
    live_active: number;
    archived: number;
    inactive: number;
  }>(
    page,
    `SELECT
       (SELECT COUNT(*) FROM samples)                                             AS total,
       -- what the Logs default to: archived and removed hidden (#74 / #105)
       (SELECT COUNT(*) FROM samples
         WHERE archived_at IS NULL AND current_stage <> 'removed')                AS live,
       (SELECT COUNT(*) FROM samples s JOIN projects p ON p.id = s.project_id
         WHERE s.archived_at IS NULL AND s.current_stage <> 'removed'
           AND p.is_active = 1)                                                   AS live_active,
       (SELECT COUNT(*) FROM samples WHERE archived_at IS NOT NULL)               AS archived,
       (SELECT COUNT(*) FROM samples s JOIN projects p ON p.id = s.project_id
         WHERE p.is_active = 0)                                                   AS inactive`,
  );

  if (logRows !== Number(tallies?.live ?? -1)) {
    report(
      `the Logs draw ${logRows} rows; the two toggles say ${tallies?.live} ` +
        `(${tallies?.total} blocks, ${tallies?.archived} archived, ${tallies?.inactive} in ` +
        `deactivated projects; scoping to active projects too would give ${tallies?.live_active})`,
      "every candidate predicate counted in one statement, so the row count is compared " +
        "against all of them rather than against a single guess",
    );
  }

  return bad;
}

/**
 * The board's own arithmetic, checked without leaving it.
 *
 * Cheap enough to run far more often than the full sweep, and it is the check
 * that needs no agreement about domain predicates: whatever the column believes
 * its population to be, it must draw that many cards.
 */
export async function checkBoardSelfConsistency(
  page: Page,
  findings: Finding[],
  where: string,
): Promise<number> {
  await closeDrawer(page);
  await goBoard(page);
  await page.waitForTimeout(250);
  let bad = 0;
  for (const title of [
    "Pre-processing",
    "Needs Embedding",
    "Embedded Inventory",
    "Needs Sectioning",
    "Staining / IHC",
    "Ready for Imaging",
  ]) {
    const badge = await badgeCount(page, title);
    const cards = await cardCount(page, title);
    if (badge === null) continue;
    // Processor holds batches as well as cards, and Extras groups by block, so
    // those two are excluded rather than compared against the wrong thing.
    if (badge !== cards) {
      bad += 1;
      findings.push({
        where,
        severity: "defect",
        detail: `"${title}" counted ${badge} and drew ${cards}`,
        corroboration: "badge and cards read from one DOM snapshot",
      });
    }
  }
  return bad;
}
