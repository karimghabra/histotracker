// Which releases `pnpm test:compat` checks (scripts/release-compat.mjs).

/**
 * The release installed at the lab. Bump it when the lab installs a new one;
 * a PR is judged against this build.
 */
export const IN_USE_RELEASE = "app-v0.17.0";

/**
 * A release whose schema is older than this branch's: it predates migration 24,
 * which app-v0.13.0 added. The backups it took stand for the old backups still
 * on the lab's disk, and the harness reverts to one and relaunches. Any release
 * that lacks a migration this branch registers will do; the harness fails if
 * this one stops qualifying.
 */
export const OLD_BACKUP_RELEASE = "app-v0.12.0";

/** The releases named on the command line, or else the one in use. */
export function releasesToTest(named) {
  return named.length ? [...named] : [IN_USE_RELEASE];
}
