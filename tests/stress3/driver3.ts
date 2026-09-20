import type { Page } from "@playwright/test";
import { sql, type Finding } from "../stress2/driver";

/**
 * v3 additions to the v2 driver.
 *
 * Two capabilities v2 had no way to reach:
 *
 *  · **A content fingerprint**, so "the database came back exactly as it was"
 *    is a decidable question rather than a spot-check of four columns. Undo
 *    restores a whole SQLite image; the only honest test of that is a whole-image
 *    comparison.
 *  · **The real undo stack**, reached the way the app reaches it.
 */

/**
 * Tables excluded from the fingerprint, and why each one has to be.
 *
 * `restoreDbPreservingSession` deliberately re-adds the current users and the
 * signed-in user after swapping the image, and `undo()` writes an audit row
 * AFTER the restore lands. Both are correct behaviour, so counting them would
 * make every undo look like a failure. Everything the workflow actually consists
 * of is still in scope.
 */
const NOT_RESTORED = new Set(["audit_events", "users", "app_settings", "schema_meta"]);

/**
 * A stable serialisation of the whole workflow state.
 *
 * Ordered by rowid, so it is insertion-order stable, and a restored image
 * restores rowids too. Returned per-table rather than as one hash: when two
 * fingerprints differ, the caller can say WHICH table drifted, which is the
 * difference between a usable finding and "something changed".
 */
export async function fingerprint(page: Page): Promise<Record<string, string>> {
  return (await page.evaluate((skip) => {
    const select = (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] })
      .__SHIM_SELECT__;
    const tables = (
      select(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`) as Array<{
        name: string;
      }>
    )
      .map((r) => r.name)
      .filter((n) => !n.startsWith("sqlite_") && !(skip as string[]).includes(n));

    const out: Record<string, string> = {};
    for (const table of tables) {
      try {
        out[table] = JSON.stringify(select(`SELECT * FROM ${table} ORDER BY rowid`));
      } catch (e) {
        out[table] = `ERROR ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return out;
  }, [...NOT_RESTORED])) as Record<string, string>;
}

/** Which tables two fingerprints disagree about, with a readable summary. */
export function fingerprintDiff(
  before: Record<string, string>,
  after: Record<string, string>,
): Array<{ table: string; detail: string }> {
  const diffs: Array<{ table: string; detail: string }> = [];
  for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[table] ?? "<absent>";
    const b = after[table] ?? "<absent>";
    if (a === b) continue;
    const rowsA = a.startsWith("[") ? (JSON.parse(a) as unknown[]).length : -1;
    const rowsB = b.startsWith("[") ? (JSON.parse(b) as unknown[]).length : -1;
    diffs.push({
      table,
      detail:
        rowsA !== rowsB
          ? `${table}: ${rowsA} rows before, ${rowsB} after`
          : `${table}: same ${rowsA} rows, different contents`,
    });
  }
  return diffs;
}

/**
 * Push an undo point, the way `useActions.commit()` does.
 *
 * The explorer drives `db.ts` directly, so nothing populates the undo stack for
 * it — the stack lives in React and only UI mutations fill it. These two lines
 * are the recording half of `commit()`, reproduced deliberately and named as
 * such: they are `snapshotDb()` plus `useUndoStore.record()`, the same functions
 * from the same modules.
 *
 * What is NOT reproduced is the interesting half. Popping, the whole-image
 * restore, session preservation, query invalidation and the re-render are all
 * reached through the real toolbar button, so the machinery under test is the
 * app's own.
 */
export async function recordUndoPoint(page: Page, label: string): Promise<boolean> {
  return (await page.evaluate(async (text) => {
    try {
      const db = (await import("/src/lib/db.ts")) as unknown as Record<string, Function>;
      const undo = (await import("/src/lib/undo.ts")) as unknown as {
        useUndoStore: { getState: () => { record: (s: { label: string; snapshot: unknown }) => void } };
      };
      const snapshot = await db.snapshotDb();
      undo.useUndoStore.getState().record({ label: text as string, snapshot });
      return true;
    } catch {
      return false;
    }
  }, label)) as boolean;
}

export async function undoDepths(page: Page): Promise<{ undo: number; redo: number }> {
  return (await page.evaluate(async () => {
    const undo = (await import("/src/lib/undo.ts")) as unknown as {
      useUndoStore: { getState: () => { undoStack: unknown[]; redoStack: unknown[] } };
    };
    const s = undo.useUndoStore.getState();
    return { undo: s.undoStack.length, redo: s.redoStack.length };
  })) as { undo: number; redo: number };
}

/** Press the real button. Returns false when the control is disabled or absent. */
export async function pressUndo(page: Page, which: "Undo" | "Redo"): Promise<boolean> {
  const button = page.getByTitle(which === "Undo" ? "Undo (Ctrl+Z)" : "Redo (Ctrl+Y)");
  if ((await button.count()) === 0) return false;
  if (await button.isDisabled().catch(() => true)) return false;

  // The restore is asynchronous — snapshot, swap the image, invalidate, refetch.
  // Waiting for the stack depth to actually move (rather than for a fixed delay)
  // means a slow restore is never mistaken for a lost click, and a click that
  // genuinely did nothing is never mistaken for a slow one.
  const key = which === "Undo" ? "undo" : "redo";
  const before = (await undoDepths(page))[key];
  await button.click();
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(100);
    if ((await undoDepths(page))[key] !== before) {
      // The stack moved; give the refetch a beat to land before anyone reads.
      await page.waitForTimeout(200);
      return true;
    }
  }
  return false;
}

/**
 * Structural sanity that has nothing to do with the workflow.
 *
 * A restored image must still BE a database: foreign keys intact, no orphaned
 * children, the schema version still present. Run after undo/redo storms, where
 * the failure mode is not "wrong stage" but "half a database".
 */
export async function checkStructure(
  page: Page,
  findings: Finding[],
  where: string,
): Promise<number> {
  let bad = 0;
  const checks: Array<{ id: string; claim: string; query: string }> = [
    {
      id: "S1",
      claim: "every slide points at a section request that exists",
      query: `SELECT sl.id FROM slides sl
               LEFT JOIN section_requests sr ON sr.id = sl.section_request_id
              WHERE sr.id IS NULL LIMIT 5`,
    },
    {
      id: "S2",
      claim: "every section request points at a block that exists",
      query: `SELECT sr.id FROM section_requests sr
               LEFT JOIN samples s ON s.id = sr.sample_id WHERE s.id IS NULL LIMIT 5`,
    },
    {
      id: "S3",
      claim: "every block points at a project that exists",
      query: `SELECT s.id FROM samples s
               LEFT JOIN projects p ON p.id = s.project_id WHERE p.id IS NULL LIMIT 5`,
    },
    {
      id: "S4",
      claim: "a slide's stack, when it has one, exists",
      query: `SELECT sl.id FROM slides sl
               LEFT JOIN slide_stacks st ON st.id = sl.stack_id
              WHERE sl.stack_id IS NOT NULL AND st.id IS NULL LIMIT 5`,
    },
    {
      id: "S5",
      claim: "the schema version survives a restore",
      query: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'samples')`,
    },
    {
      id: "S6",
      claim: "slide codes are unique",
      query: `SELECT slide_code, COUNT(*) AS n FROM slides
               GROUP BY slide_code HAVING n > 1 LIMIT 5`,
    },
    {
      id: "S7",
      claim: "block codes are unique",
      query: `SELECT sample_code, COUNT(*) AS n FROM samples
               GROUP BY sample_code HAVING n > 1 LIMIT 5`,
    },
  ];
  for (const check of checks) {
    const rows = await sql(page, check.query).catch((e) => [{ error: String(e) }]);
    if (rows.length > 0) {
      bad += 1;
      findings.push({
        where,
        severity: "defect",
        detail: `STRUCTURE ${check.id} — ${check.claim}; ${rows.length} violation(s): ${JSON.stringify(
          rows.slice(0, 3),
        )}`,
        corroboration: "a pure schema-level join, independent of every workflow predicate",
      });
    }
  }
  return bad;
}

/** A compact census, for reading the shape of a run at a glance. */
export async function census(page: Page): Promise<Record<string, number>> {
  const rows = await sql<Record<string, number>>(
    page,
    `SELECT
       (SELECT COUNT(*) FROM samples)                                        AS samples,
       (SELECT COUNT(*) FROM section_requests)                               AS groups,
       (SELECT COUNT(*) FROM slides)                                         AS slides,
       (SELECT COUNT(*) FROM slides WHERE current_stage = 'removed')         AS removed,
       (SELECT COUNT(*) FROM slide_stacks WHERE closed_at IS NULL)           AS open_racks,
       (SELECT COUNT(*) FROM sample_timeline_events)                         AS events`,
  );
  return rows[0] ?? {};
}
