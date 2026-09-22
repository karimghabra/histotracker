import { test, expect, type Page } from "@playwright/test";
import { listShimFiles, SHIM_DB_FILE } from "../helpers/shim-fs";

/**
 * The harness's own instrument check.
 *
 * Everything else in this directory asks whether the app is right. These ask
 * whether the rig measuring it is, because for three nights it was not: the
 * browser shims kept the database base64-encoded in localStorage, which tops out
 * around 3.7 MB of bytes, and threw the QuotaExceededError away with a comment
 * saying there was nothing useful to do about it. A stress run seeding 130
 * blocks passed that ceiling at about sixty, went on writing to a live database
 * nothing was storing, and every page reload after that reopened a frozen image.
 * tests/stress3 reloads on purpose, so it read the frozen image back and reported
 * that hundreds of slide rows had been destroyed. They had not. A good change was
 * reverted on the strength of it.
 *
 * So: the filesystem has to hold a lab-sized database, and it must never again
 * drop a write quietly. Both are asserted here rather than assumed, because a
 * test rig that lies is worse than no test rig.
 */

/** Open on an empty database, no sign-in: these drive the shim, not the app. */
async function boot(page: Page): Promise<void> {
  await page.goto("/?freshdb=1");
  await opened(page);
}

/**
 * Wait for the database itself, not for the shell around it: the app renders its
 * heading before `getDb()` has resolved, and the shim installs its escape
 * hatches at the end of opening.
 */
async function opened(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Open Histology Workflow" })).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForFunction(
    () => typeof (window as unknown as { __SHIM_SQL__?: unknown }).__SHIM_SQL__ === "function",
    undefined,
    { timeout: 20_000 },
  );
}

/** Run one statement through the SQL shim's escape hatch, and persist it. */
async function write(page: Page, statement: string): Promise<void> {
  await page.evaluate(
    (q) =>
      (window as unknown as { __SHIM_SQL__: (s: string) => Promise<void> }).__SHIM_SQL__(q),
    statement,
  );
}

async function select<T>(page: Page, query: string): Promise<T[]> {
  return page.evaluate(
    (q) => (window as unknown as { __SHIM_SELECT__: (s: string) => unknown[] }).__SHIM_SELECT__(q),
    query,
  ) as Promise<T[]>;
}

const MEGABYTE = 1024 * 1024;

test("a database far past localStorage's ceiling still relaunches intact", async ({ page }) => {
  await boot(page);

  // Eight megabytes of incompressible text, written a megabyte at a time through
  // the app's own persistence path. The old store gave out somewhere in the
  // fourth of these and said nothing.
  await write(page, `CREATE TABLE pad (id INTEGER PRIMARY KEY AUTOINCREMENT, filler TEXT NOT NULL)`);
  for (let i = 0; i < 8; i += 1) {
    await write(page, `INSERT INTO pad (filler) VALUES (hex(randomblob(500000)))`);
  }
  // A row of the app's own, so the check is not only about the padding.
  await write(
    page,
    `INSERT INTO projects (code, name, team_lead, is_active) VALUES ('BG', 'Big Lab', '', 1)`,
  );

  const stored = await listShimFiles(page, SHIM_DB_FILE);
  expect(stored, "the database image is a file in the virtual filesystem").toHaveLength(1);
  expect(
    stored[0].size,
    "the whole image is stored, not the 3.7 MB localStorage would have taken",
  ).toBeGreaterThan(7 * MEGABYTE);

  // A reload is a relaunch here (src/test/browser-sql-shim.ts), so this is the
  // exact step that used to reopen a frozen image.
  await page.goto("/");
  await opened(page);

  const padding = await select<{ n: number; bytes: number }>(
    page,
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(filler)), 0) AS bytes FROM pad`,
  );
  expect(padding[0]?.n, "every padding row survived the relaunch").toBe(8);
  expect(padding[0]?.bytes, "and with every byte of it").toBe(8_000_000);
  await expect(page.locator("aside").getByText("Big Lab")).toBeVisible();
});

test("a write the virtual filesystem cannot make fails the run instead of vanishing", async ({
  page,
}) => {
  await boot(page);

  // Break the store underneath the shim, the way a quota does. Nothing about the
  // failure is specific to quota: what is asserted is that ANY failed write is
  // reported rather than absorbed.
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function put() {
      throw new DOMException("simulated store failure", "QuotaExceededError");
    } as unknown as typeof IDBObjectStore.prototype.put;
  });

  const refusal = await page.evaluate(async () => {
    const fs = (window as unknown as {
      __SHIM_FS__: { write(path: string, b64: string): Promise<void> };
    }).__SHIM_FS__;
    try {
      await fs.write("histometer-shim.db", btoa("x".repeat(4096)));
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });

  expect(refusal, "the failed write is thrown at the caller, not swallowed").not.toBeNull();
  expect(refusal, "and it names the file").toContain("histometer-shim.db");
  // A size, not a particular one: whichever write reaches the broken store first
  // is the one that latches, and the app persists on its own schedule.
  expect(refusal, "and how large it was").toMatch(/\(\d[\d,]* bytes\)/);
  expect(refusal, "and says what it means").toContain("lost a write");

  // And it latches: a run that has lost a write cannot carry on reading a
  // database that is no longer the one under test, which is how the lie spread.
  const afterwards = await page.evaluate(async () => {
    const fs = (window as unknown as {
      __SHIM_FS__: { read(path: string): Promise<string | null> };
    }).__SHIM_FS__;
    try {
      await fs.read("histometer-shim.db");
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });
  expect(afterwards, "every later operation refuses too").toContain("lost a write");
});

test("a lost write is still refused after a reload, until a fresh start lifts it", async ({
  page,
}) => {
  await boot(page);

  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function put() {
      throw new DOMException("simulated store failure", "QuotaExceededError");
    } as unknown as typeof IDBObjectStore.prototype.put;
  });
  const refusal = await page.evaluate(async () => {
    const fs = (window as unknown as {
      __SHIM_FS__: { write(path: string, b64: string): Promise<void> };
    }).__SHIM_FS__;
    try {
      await fs.write("histometer-shim.db", btoa("x".repeat(4096)));
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });
  expect(refusal).toContain("lost a write");

  // The reload is the step that used to reopen the last image the store had
  // taken, and it also drops the broken `put`: the store works again, and the
  // refusal must stand regardless.
  await page.goto("/");
  await page.waitForFunction(
    () => typeof (window as unknown as { __SHIM_FS__?: unknown }).__SHIM_FS__ === "object",
    undefined,
    { timeout: 20_000 },
  );
  const afterReload = await page.evaluate(async () => {
    const fs = (window as unknown as {
      __SHIM_FS__: { read(path: string): Promise<string | null> };
    }).__SHIM_FS__;
    try {
      await fs.read("histometer-shim.db");
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });
  expect(afterReload, "the reloaded page refuses the filesystem too").toBe(refusal);
  expect(
    await page.evaluate(
      () => typeof (window as unknown as { __SHIM_SELECT__?: unknown }).__SHIM_SELECT__,
    ),
    "and no database opens on the image the lost write left behind",
  ).toBe("undefined");

  // A deliberate fresh start is the one way out.
  await boot(page);
  await write(
    page,
    `INSERT INTO projects (code, name, team_lead, is_active) VALUES ('FR', 'Fresh Lab', '', 1)`,
  );
  const fresh = await select<{ n: number }>(
    page,
    `SELECT COUNT(*) AS n FROM projects WHERE code = 'FR'`,
  );
  expect(fresh[0]?.n).toBe(1);
});

test("a connection closed by a restore cannot write its old image back over the new one", async ({
  page,
}) => {
  await boot(page);

  const outcome = await page.evaluate(async () => {
    const db = (await import("/src/lib/db.ts")) as unknown as {
      getDb(): Promise<{ execute(q: string): Promise<unknown> }>;
      snapshotDb(): Promise<Uint8Array>;
      resetDb(): Promise<void>;
      setSignedOutReadOnly(readOnly: boolean): void;
    };
    // Past the sign-in gate, so what answers the stale write is the connection.
    db.setSignedOutReadOnly(false);
    const shim = window as unknown as {
      __SHIM_SQL__: (s: string) => Promise<void>;
      __SHIM_FS__: { write(path: string, b64: string): Promise<void> };
    };
    const image = await db.snapshotDb();
    await shim.__SHIM_SQL__(
      `INSERT INTO projects (code, name, team_lead, is_active) VALUES ('ST', 'Stale Lab', '', 1)`,
    );
    const stale = await db.getDb();
    // restoreDb's own steps, with the stale write landing between the new image
    // reaching the file and the connection over it opening.
    await db.resetDb();
    let binary = "";
    for (const byte of image) binary += String.fromCharCode(byte);
    await shim.__SHIM_FS__.write("histometer-shim.db", btoa(binary));
    let refusal: string | null = null;
    try {
      await stale.execute(
        `INSERT INTO projects (code, name, team_lead, is_active) VALUES ('LT', 'Late Lab', '', 1)`,
      );
    } catch (err) {
      refusal = (err as Error).message;
    }
    await db.getDb();
    return refusal;
  });
  expect(outcome, "the closed connection refuses the write").toContain("closed");

  // Relaunch, so what is checked is the stored file, not a connection's memory.
  await page.goto("/");
  await opened(page);
  const rows = await select<{ code: string }>(
    page,
    `SELECT code FROM projects WHERE code IN ('ST', 'LT') ORDER BY code`,
  );
  expect(rows, "the restored image is the one on file").toEqual([]);
});
