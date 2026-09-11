// Which releases `pnpm test:compat` checks (scripts/release-compat.mjs).

/**
 * The release installed at the lab. Bump it when the lab installs a new one;
 * a PR is judged against this build.
 */
export const IN_USE_RELEASE = "app-v0.17.0";

/** The releases named on the command line, or else the one in use. */
export function releasesToTest(named) {
  return named.length ? [...named] : [IN_USE_RELEASE];
}
