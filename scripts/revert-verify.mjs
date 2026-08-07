#!/usr/bin/env node
/**
 * Revert-verification harness.
 *
 * A test that passes proves nothing until it has been seen to FAIL without its
 * fix. Three of the four bugs in this cycle were second reports on issues
 * already marked fixed, and the 0.7.3 audit found assertions that could not fail
 * at all — so each new check is put back in front of the bug it is supposed to
 * catch.
 *
 * Usage: node scripts/revert-verify.mjs <case>
 * Each case patches source, runs one Playwright test, and restores the source
 * whatever happens. Anchors are RegExp with `\r?\n`: the repo is CRLF, and plain
 * multi-line string anchors silently miss.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const CASES = {
  // #83 — put the fixed near-white Tailwind paints back.
  "83-dark": {
    grep: "#83: a removed slide's row is readable in a dark theme",
    edits: [
      {
        file: "src/components/LogsView.tsx",
        find: /className=\{cn\(match && "row-match", removed && "row-removed"\)\}/,
        replace: 'className={cn(match && "bg-amber-100/50", removed && "bg-red-50/60")}',
      },
      {
        file: "src/components/LogsView.tsx",
        find: /<div className="note-removed rounded-md border px-2 py-1\.5">/,
        replace: '<div className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5">',
      },
    ],
  },

  // #86 — make the shared description a pure fallback again.
  "86-compose": {
    grep: "#86/#88: a batch shows a row per sample and blocks Create until each is filled",
    edits: [
      {
        file: "src/lib/utils.ts",
        find: /  if \(s && o\) return `\$\{s\} \| \$\{o\}`;/,
        replace: "  if (s && o) return o;",
      },
    ],
  },

  // #91 — drop the "still waiting for the processor" filter from the Add list.
  "91-candidates": {
    grep: "#91: the Add list does not offer a block from the Embedded Inventory",
    edits: [
      {
        file: "src/App.tsx",
        find: /        PREPROCESSING_STAGES\.has\(s\.current_stage\) &&\r?\n/,
        replace: "",
      },
    ],
  },

  // #95 — stamp the cut at INSERT again, the way 0.7.4 did. EXPECTED VACUOUS
  // against the e2e test: the read rule catches it too. The write side is
  // covered by the harness gate `issue(95, …)`, which was revert-verified
  // separately. Kept so the pairing is documented rather than rediscovered.
  "95-cut": {
    grep: "#95: a queued slide has no Cut step until the group is sectioned",
    edits: [
      {
        file: "src/lib/db.ts",
        find:
          /            \(section_request_id, slide_ordinal, slide_code, purpose, assignment_saved, current_stage\)\r?\n           VALUES \(\?, \?, \?, 'extra', 1, 'extra'\)`,\r?\n          \[sectionId, ordinal, slideCodeFor\(parentCode, nextOrdinal\)\],/,
        replace:
          "            (section_request_id, slide_ordinal, slide_code, purpose, assignment_saved, current_stage, stage_cut_at)\n" +
          "           VALUES (?, ?, ?, 'extra', 1, 'extra', ?)`,\n" +
          "          [sectionId, ordinal, slideCodeFor(parentCode, nextOrdinal), timestamp],",
      },
    ],
  },

  // #95, the read side. The e2e test is defended by TWO independent mechanisms —
  // the write no longer stamps a queued slide, and the read refuses to report a
  // cut for one — so removing either alone leaves it passing (as `95-cut`
  // demonstrates: that one is instead covered by the harness gate, which tests
  // the write directly). This case removes the read rule, which is also the
  // mechanism that fixes rows ALREADY written by 0.7.4.
  "95-render": {
    grep: "#95: a queued slide has no Cut step until the group is sectioned",
    edits: [
      {
        file: "src/lib/utils.ts",
        find: /  if \(slide\.section_stage === "needs_sectioning"\) return "";\r?\n/,
        replace: "",
      },
    ],
  },

  // Both #95 mechanisms at once — the state a 0.7.4 build was actually in.
  "95-both": {
    grep: "#95: a queued slide has no Cut step until the group is sectioned",
    edits: [
      {
        file: "src/lib/utils.ts",
        find: /  if \(slide\.section_stage === "needs_sectioning"\) return "";\r?\n/,
        replace: "",
      },
      {
        file: "src/lib/db.ts",
        find:
          /            \(section_request_id, slide_ordinal, slide_code, purpose, assignment_saved, current_stage\)\r?\n           VALUES \(\?, \?, \?, 'extra', 1, 'extra'\)`,\r?\n          \[sectionId, ordinal, slideCodeFor\(parentCode, nextOrdinal\)\],/,
        replace:
          "            (section_request_id, slide_ordinal, slide_code, purpose, assignment_saved, current_stage, stage_cut_at)\n" +
          "           VALUES (?, ?, ?, 'extra', 1, 'extra', ?)`,\n" +
          "          [sectionId, ordinal, slideCodeFor(parentCode, nextOrdinal), timestamp],",
      },
    ],
  },

  // #96 — put Archive back on the board drawer in place of Delete.
  "96-delete": {
    grep: "#96: the sample drawer deletes without erasing, and no longer archives",
    edits: [
      {
        file: "src/components/SampleDetailsDrawer.tsx",
        find: /          onClick=\{\(\) => setShowRemoval\(true\)\}/,
        replace: "          onClick={() => void 0}",
      },
      {
        file: "src/components/SampleDetailsDrawer.tsx",
        find: /          title=\{deleteLabel\}\r?\n          aria-label=\{deleteLabel\}/,
        replace:
          "          title={`Archive ${displayCode(sample.sample_code)}`}\n" +
          "          aria-label={`Archive ${displayCode(sample.sample_code)}`}",
      },
    ],
  },

  // #96, the other half — a removed block has to SAY it was removed, and why.
  // Strip the row's flag and its reason panel.
  //
  // (Note for anyone extending this: reverting the `current_stage != 'removed'`
  // clause in listOpenSamples does NOT fail anything, because 'removed' maps to
  // no board queue in stages.ts and the card is dropped anyway. The clause is
  // deliberate defence in depth, not the load-bearing part — the same reasoning
  // as the slide-level filters in #83.)
  "96-logged": {
    grep: "#96: the sample drawer deletes without erasing, and no longer archives",
    edits: [
      {
        file: "src/components/LogsView.tsx",
        find: /            \{sample\.current_stage === "removed" && \(\r?\n              <span\r?\n                className="whitespace-nowrap rounded-full bg-red-600[\s\S]*?\r?\n            \)\}\r?\n/,
        replace: "",
      },
      {
        file: "src/components/LogsView.tsx",
        find: /            \{sample\.current_stage === "removed" && \(\r?\n              <div className="note-removed[\s\S]*?\r?\n            \)\}\r?\n/,
        replace: "",
      },
    ],
  },

  // #92 — stamp the settings seed as fresh, so staleTime suppresses the read.
  "92-settings": {
    grep: "#92: cutting defaults are configurable and take effect",
    edits: [
      {
        file: "src/hooks/useData.ts",
        find: /    initialDataUpdatedAt: 0,\r?\n/,
        replace: "",
      },
    ],
  },

  // #93/#94 — put Manage, Backups and the theme picker back in the header.
  "94-header": {
    grep: "#93/#94: Manifest and the set-up controls have moved",
    edits: [
      {
        file: "src/App.tsx",
        find: /                \{\/\* Manage, Backups and the theme picker moved into Settings\r?\n/,
        replace:
          '                <Button variant="subtle" className="px-2" onClick={() => setShowUsers(true)}>Manage</Button>\n' +
          '                {/* Manage, Backups and the theme picker moved into Settings\n',
      },
    ],
  },
};

const name = process.argv[2];
const spec = CASES[name];
if (!spec) {
  console.error(`unknown case: ${name}\navailable: ${Object.keys(CASES).join(", ")}`);
  process.exit(2);
}

const originals = new Map();
try {
  for (const edit of spec.edits) {
    const path = join(ROOT, edit.file);
    if (!originals.has(path)) originals.set(path, readFileSync(path, "utf8"));
    const before = readFileSync(path, "utf8");
    if (!edit.find.test(before)) throw new Error(`anchor missed in ${edit.file}: ${edit.find}`);
    writeFileSync(path, before.replace(edit.find, edit.replace));
  }
  console.log(`[revert-verify] ${name}: fix removed, running "${spec.grep}"`);
  // Vite HMR needs a moment to serve the reverted bundle; navigating too soon
  // loads the FIXED build and reports a real assertion as vacuous.
  execSync("node -e \"setTimeout(()=>{}, 4000)\"", { stdio: "ignore" });
  let failed = false;
  try {
    execSync(
      `npx playwright test tests/e2e --retries=0 --reporter=line -g ${JSON.stringify(spec.grep)}`,
      { cwd: ROOT, stdio: "inherit" },
    );
  } catch {
    failed = true;
  }
  console.log(
    failed
      ? `\n[revert-verify] ${name}: PASS — the test fails without its fix.`
      : `\n[revert-verify] ${name}: VACUOUS — the test still passes with the fix removed!`,
  );
  process.exitCode = failed ? 0 : 1;
} finally {
  for (const [path, text] of originals) writeFileSync(path, text);
  console.log("[revert-verify] source restored");
}
