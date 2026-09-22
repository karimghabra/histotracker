import type { Page } from "@playwright/test";
import { SHIM_FS_DB_NAME, SHIM_FS_STORE, SHIM_FS_VERSION } from "../../src/test/shim-fs";

/**
 * The suites' way into the browser shims' virtual filesystem (src/test/shim-fs.ts).
 *
 * Specs used to read the storage the shim happened to use — a scan of
 * `localStorage` for keys beginning `histometer-shim-fs:`. That made every one of
 * them a second copy of a decision that belongs to one module, and all of them
 * broke together the day it changed (it had to: localStorage tops out at about
 * 3.7 MB of bytes, which a lab-sized database passes at around sixty blocks).
 *
 * So ask the filesystem instead. Bytes cross the `page.evaluate` boundary as
 * base64, because a Uint8Array does not survive the trip.
 */

interface ShimFsAccess {
  read(path: string): Promise<string | null>;
  write(path: string, b64: string): Promise<void>;
  list(prefix?: string): Promise<Array<{ path: string; size: number }>>;
  remove(path: string): Promise<void>;
  clear(): Promise<void>;
}

/** The path the SQL shim keeps the live database image at. */
export const SHIM_DB_FILE = "histometer-shim.db";
/** Where the backup commands keep their images. */
export const SHIM_BACKUP_DIR = "backups/";

/** One file's bytes, base64-encoded, or null when there is no such file. */
export function readShimFile(page: Page, path: string): Promise<string | null> {
  return page.evaluate((p) => {
    const access = (window as unknown as { __SHIM_FS__?: ShimFsAccess }).__SHIM_FS__;
    if (!access) throw new Error("the shim filesystem is not loaded on this page");
    return access.read(p);
  }, path);
}

/** Every stored path that begins with `prefix`, with each file's size, sorted by path. */
export function listShimFiles(
  page: Page,
  prefix = "",
): Promise<Array<{ path: string; size: number }>> {
  return page.evaluate((p) => {
    const access = (window as unknown as { __SHIM_FS__?: ShimFsAccess }).__SHIM_FS__;
    if (!access) throw new Error("the shim filesystem is not loaded on this page");
    return access.list(p);
  }, prefix);
}

/** Write bytes (base64) to a path, as a Rust command's `save_file` would. */
export function writeShimFile(page: Page, path: string, b64: string): Promise<void> {
  return page.evaluate(
    ([p, data]) => {
      const access = (window as unknown as { __SHIM_FS__?: ShimFsAccess }).__SHIM_FS__;
      if (!access) throw new Error("the shim filesystem is not loaded on this page");
      return access.write(p as string, data as string);
    },
    [path, b64] as const,
  );
}

/**
 * The first file under `prefix` whose path ends with `suffix`, decoded as text.
 *
 * What the export specs want: the app names its CSV and workbook files with a
 * timestamp, so they are found by extension rather than by name.
 */
export async function readShimTextBySuffix(
  page: Page,
  suffix: string,
  prefix = "",
): Promise<string | null> {
  const b64 = await findShimFileBySuffix(page, suffix, prefix);
  return b64 === null ? null : Buffer.from(b64, "base64").toString("utf8");
}

/** The first file under `prefix` whose path ends with `suffix`, base64-encoded. */
export async function findShimFileBySuffix(
  page: Page,
  suffix: string,
  prefix = "",
): Promise<string | null> {
  const files = await listShimFiles(page, prefix);
  const match = files.find((f) => f.path.endsWith(suffix));
  return match ? await readShimFile(page, match.path) : null;
}

/**
 * Put a database image in place, so the next `page.goto("/")` opens the app on
 * it — the browser equivalent of installing a build over an existing lab's file.
 *
 * Two things rule out the `addInitScript` this replaces. The virtual filesystem
 * is IndexedDB, so writing to it is asynchronous, and Playwright does not wait
 * for an init script's promise before the page's own scripts run. And the image
 * cannot be planted on a page that has booted the app either: the app opens the
 * database and persists it within the first second, which overwrites whatever
 * was planted underneath it.
 *
 * So the plant happens on a bare page served on the app's origin and nowhere
 * else — enough to reach this origin's IndexedDB, with nothing running that
 * could write over the image. It addresses the store directly, by the names the
 * shim itself exports, because at that point the shim is not loaded.
 */
export async function plantShimImage(page: Page, b64: string): Promise<void> {
  const url = "**/__plant-shim-image";
  await page.route(url, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><head><title>plant</title></head><body></body></html>",
    }),
  );
  try {
    await page.goto("/__plant-shim-image");
    await page.evaluate(
      ([dbName, store, version, path, data]) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open(dbName as string, version as number);
          open.onupgradeneeded = () => open.result.createObjectStore(store as string);
          open.onerror = () => reject(open.error ?? new Error("indexedDB.open failed"));
          open.onsuccess = () => {
            const binary = atob(data as string);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            const tx = open.result.transaction(store as string, "readwrite");
            tx.objectStore(store as string).put(bytes, path as string);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("planting the image failed"));
            tx.onabort = () => reject(tx.error ?? new Error("planting the image was aborted"));
          };
        }),
      [SHIM_FS_DB_NAME, SHIM_FS_STORE, SHIM_FS_VERSION, SHIM_DB_FILE, b64] as const,
    );
  } finally {
    await page.unroute(url);
  }
}

/**
 * Wait until the SQL shim has a database open on this page.
 *
 * A page load is a relaunch here, and the app paints its shell before `getDb()`
 * has resolved — so "the heading is visible" does not mean "the database is
 * open". The shim installs `__SHIM_SELECT__` at the end of opening one, which
 * makes its presence the honest signal, and a spec that reads the database
 * straight after a relaunch waits for this rather than for the heading.
 */
export async function waitForShimDatabase(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __SHIM_SELECT__?: unknown }).__SHIM_SELECT__ === "function",
    undefined,
    { timeout: 30_000 },
  );
}
