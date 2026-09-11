// Which releases `pnpm test:compat` checks. With no arguments (what CI runs)
// that is the release in use and nothing else; named releases replace it.

import { describe, expect, it } from "vitest";
import { IN_USE_RELEASE, releasesToTest } from "../../scripts/compat-releases.mjs";

describe("the releases pnpm test:compat checks", () => {
  it("with no arguments, the release in use and nothing else", () => {
    expect(releasesToTest([])).toEqual([IN_USE_RELEASE]);
  });

  it("with releases named, exactly those, in the order given", () => {
    expect(releasesToTest(["app-v0.18.0", "origin/claude/xyz"])).toEqual(["app-v0.18.0", "origin/claude/xyz"]);
    expect(releasesToTest(["app-v0.16.0"])).toEqual(["app-v0.16.0"]);
  });
});
