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

  // #97 — drop the Processing column from the Logs table.
  "97-processing": {
    grep: "#97: the Logs show Short vs Long processing",
    edits: [
      {
        file: "src/components/LogsView.tsx",
        find: /        <td className="px-2 py-1\.5 text-ink-soft">\{sample\.processing_type \|\| "—"\}<\/td>\r?\n/,
        replace: "",
      },
      {
        file: "src/components/LogsView.tsx",
        find: /    \{ key: "processing", label: "Processing" \},\r?\n/,
        replace: "",
      },
    ],
  },

  // #98 — call it "Send for Cutting" everywhere again, and show the send button
  // whatever stage the block is at.
  "98-cutting": {
    grep: "#98: it is a Cutting Plan until the block reaches Embedded Inventory",
    edits: [
      {
        file: "src/components/SampleDetailsDrawer.tsx",
        find: /\{isEmbedded \? "Send for Cutting" : "Cutting Plan"\}/,
        replace: "Send for Cutting",
      },
      {
        file: "src/components/SectioningPlanDialog.tsx",
        find: /        \{canSend && \(\r?\n/,
        replace: "        {true && (\n",
      },
    ],
  },

  // #99 — put the project switcher back.
  "99-project": {
    grep: "#99: the drawer has no project switcher",
    edits: [
      {
        file: "src/components/SampleDetailsDrawer.tsx",
        find: /        \{\/\* No project switcher \(#99\)\./,
        replace:
          '        <select aria-label="Sample project" value={sample.project_id} onChange={() => undefined}>\n' +
          "          <option value={sample.project_id}>{sample.project_name}</option>\n" +
          "        </select>\n" +
          "        {/* No project switcher (#99).",
      },
    ],
  },

  // #100/#101 — go back to the frozen intake string.
  "100-stains": {
    grep: "#100/#101: the Stains list is live, one line each, with slide state",
    edits: [
      {
        file: "src/components/SampleDetailsDrawer.tsx",
        find: /        <StainList sampleSlides=\{sampleSlides\} pending=\{pendingAgents\} legacy=\{sample\.stains\} \/>/,
        replace:
          "        {sample.stains && <Section title=\"Stains / IHC\">{sample.stains}</Section>}",
      },
    ],
  },

  // #102 — strip the description and the agents back off the imaging tile.
  "102-tiles": {
    grep: "#102: imaging tiles carry the description and the agents",
    edits: [
      {
        file: "src/components/StackCard.tsx",
        find: /        \{stack\.parent_description && \(\r?\n[\s\S]*?\r?\n        \)\}\r?\n/,
        replace: "",
      },
      {
        file: "src/components/StackCard.tsx",
        find: /        \{agents \|\|\r?\n/,
        replace: "        {\n",
      },
    ],
  },

  // #103 — remove the Needs Embedding filter entirely.
  "103-needs-embedding": {
    grep: "#103: Needs Embedding can be filtered by project and sorted",
    edits: [
      {
        file: "src/components/Board.tsx",
        find: /                  \} else if \(isNeedsEmbedding\) \{\r?\n                    items = displayedNeedsEmbeddingItems;\r?\n/,
        replace: "                  } else if (false) {\n",
      },
    ],
  },

  // #104 — go back to plain useState for a board filter, so it dies with the
  // unmount.
  "104-persist": {
    grep: "#104: filters survive a view switch and reset on sign-out",
    edits: [
      {
        file: "src/components/Board.tsx",
        find: /  const \[needsEmbeddingFilter, setNeedsEmbeddingFilter\] = useViewPref<number \| "all">\("board\.needsEmbeddingFilter", "all"\);/,
        replace:
          '  const [needsEmbeddingFilter, setNeedsEmbeddingFilter] = useState<number | "all">("all");',
      },
    ],
  },

  // #105 — always list removed blocks, so the toggle changes nothing.
  "105-show-removed": {
    grep: "#105: Show removed reveals a deleted block in the Logs",
    edits: [
      {
        file: "src/components/LogsView.tsx",
        find: /      if \(!showRemoved && sample\.current_stage === "removed"\) return false;\r?\n/,
        replace: "",
      },
    ],
  },

  // #106 — rename the project row only, as before.
  "106-rename": {
    grep: "#106: renaming a project renames its samples and slides",
    edits: [
      {
        file: "src/lib/db.ts",
        find: /  if \(!oldCode \|\| oldCode === newCode\) return;\r?\n/,
        replace: "  if (true) return;\n",
      },
    ],
  },

  // #107 — sort Added on the day-granular column again.
  "107-added-sort": {
    grep: "#107: Added sorts by time, not just by day",
    edits: [
      {
        file: "src/components/LogsView.tsx",
        find: /          cmp =\r?\n            \(sa\.stage_received_at \|\| sa\.date_added \|\| ""\)\.localeCompare\(\r?\n              sb\.stage_received_at \|\| sb\.date_added \|\| "",\r?\n            \) \|\| \(sa\.project_sample_number \?\? 0\) - \(sb\.project_sample_number \?\? 0\);/,
        replace:
          '          cmp = (sa.date_added || "").localeCompare(sb.date_added || "");',
      },
    ],
  },

  // #108 — manual sign-out goes back to dropping the session silently.
  "108-signout": {
    grep: "#108: signing out by hand offers the sign-in dialogue",
    edits: [
      {
        file: "src/App.tsx",
        find: /                    onClick=\{\(\) => signOut\(activeUser\.name, "manual"\)\}/,
        replace: "                    onClick={() => selectUser.mutate(null)}",
      },
    ],
  },

  // #109 — point the stain control back at the single block.
  "109-bulk-stain": {
    grep: "#109: adding a stain applies to every selected block",
    edits: [
      {
        file: "src/components/SampleDetailsDrawer.tsx",
        find: /  const stainTargets = removeTargets;/,
        replace: "  const stainTargets = [sample.id];",
      },
    ],
  },

  // #110 — flag on "has a plan" instead of "a plan was saved", which is what
  // makes the whole column light up.
  "110-flag": {
    grep: "#110: the flag reads needs cut, and a saved plan raises it",
    edits: [
      {
        file: "src/components/SampleCard.tsx",
        find: /  const needsCut = Boolean\(pendingStainNames\) \|\| sample\.plan_saved === 1;/,
        replace:
          "  const needsCut = Boolean(pendingStainNames) || Boolean(sample.sectioning_plan);",
      },
    ],
  },

  // #110 parenthetical — hide Save Plan for a batch again.
  "110-bulk-save": {
    grep: "#110: a cutting plan can be saved for a whole selection",
    edits: [
      {
        file: "src/components/SectioningPlanDialog.tsx",
        find: /        \{onSave && \(\r?\n          <Button variant="subtle" onClick=\{saveDraft\} disabled=\{busy\}>/,
        replace:
          "        {onSave && !isBatch && (\n          <Button variant=\"subtle\" onClick={saveDraft} disabled={busy}>",
      },
    ],
  },

  // #112 — key plan_saved off the timeline event alone again, which is never
  // cleared, so one saved plan flags the block for ever.
  "112-flag-clears": {
    grep: "#112: the needs-cut flag clears once the block has been cut",
    edits: [
      {
        file: "src/lib/db.ts",
        find: /            \(\r?\n              s\.sectioning_plan <> '' AND EXISTS \(/,
        replace: "            (\n              1 = 1 AND EXISTS (",
      },
    ],
  },

  // #112 — require an assay_type again, so a typeless group fulfils nothing.
  //
  // EXPECTED VACUOUS against the e2e test, and kept in order to say so: a
  // request added through the drawer always carries a type, and so does the
  // plan built from it, so the old guard was satisfied and that path always
  // worked. The typeless plan is only reachable at the data layer, which is why
  // the trim fix is covered by the harness gate issue(112, "a cut clears the
  // request it fulfils even with no assay type") — revert-verified separately.
  "112-trim": {
    grep: "#112: a cut clears the request it fulfilled",
    edits: [
      {
        file: "src/lib/db.ts",
        find: /    const name = \(g\.assay_name \|\| g\.stains \|\| ""\)\.trim\(\);\r?\n    if \(!name\) continue;\r?\n/,
        replace:
          '    const name = g.assay_type && g.assay_name ? g.assay_name.trim() : "";\n    if (!name) continue;\n',
      },
      // …and the read-time repair would otherwise clean up after it.
      {
        file: "src/lib/db.ts",
        find: /        await reconcileFulfilledRequests\(db\);\r?\n/,
        replace: "",
      },
    ],
  },

  // #112 — take the withdraw control back out.
  "112-withdraw": {
    grep: "#112: an outstanding stain request can be withdrawn by hand",
    edits: [
      {
        file: "src/components/SampleDetailsDrawer.tsx",
        find: /            \{row\.pending && onWithdraw && \(/,
        replace: "            {false && onWithdraw && (",
      },
    ],
  },

  // #111 — drop the Needs Sectioning filter.
  "111-needs-sectioning": {
    grep: "#111: Needs Sectioning can be filtered by project and sorted",
    edits: [
      {
        file: "src/components/Board.tsx",
        find: /                          \) : isNeedsSectioning && needsSectioningGroups\.length > 0 \? \(/,
        replace: "                          ) : false ? (",
      },
    ],
  },

  // #118 — call a block Sectioned as soon as a slide row exists, cut or not.
  "118-sectioned": {
    grep: "#118/#119: a queued block is not Sectioned, and stays in Embedded",
    edits: [
      {
        file: "src/components/LogsView.tsx",
        find: /  const cut = live\.filter\(isCut\);/,
        replace: "  const cut = live;",
      },
    ],
  },

  // #119 — make the phase exclusive again: the furthest one wins, so a block in
  // Embedded Inventory with cut slides drops out of the Embedded filter.
  //
  // Pointed at the #117 test, not the #118/#119 one. In that test nothing has
  // been cut yet, so the block's only phase IS "embedded" and furthest-wins
  // agrees with the set — the assertion cannot tell them apart. The #117 test is
  // where they genuinely disagree: the block is in Embedded Inventory AND its
  // slides are in staining, and it has to appear under both.
  "119-inventory": {
    grep: "#117: the Staining filter finds a block whose slides are in staining",
    edits: [
      {
        file: "src/components/LogsView.tsx",
        find: /      if \(phases\.size > 0 && !\[\.\.\.rowPhases\]\.some\(\(p\) => phases\.has\(p\)\)\) return false;/,
        replace:
          "      if (phases.size > 0 && !phases.has(furthestPhase(rowPhases))) return false;",
      },
    ],
  },

  // #117 — require a staining STAMP again, so a slide sitting in the staining
  // column that has not been stained matches nothing.
  "117-staining": {
    grep: "#117: the Staining filter finds a block whose slides are in staining",
    edits: [
      {
        file: "src/components/LogsView.tsx",
        find: /    if \(queue === "staining"\) phases\.add\("staining"\);/,
        replace:
          '    if (queue === "staining" && slide.stage_stained_at) phases.add("staining");',
      },
    ],
  },

  // #114 — send the Logs back through the sync request dialog.
  "114-direct-add": {
    grep: "#114: the Logs add a stain directly, with no sync request",
    edits: [
      {
        file: "src/components/LogsView.tsx",
        find: /              \{!readOnly && addableAgents\.length > 0 && \(/,
        replace: "              {false && addableAgents.length > 0 && (",
      },
    ],
  },

  // #113 — put Add a Stain back on the embedded drawer.
  "113-no-add": {
    grep: "#113: no Add a Stain in the embedded-inventory drawer",
    edits: [
      {
        file: "src/components/SampleDetailsDrawer.tsx",
        find: /        \{!isEmbedded && \(\r?\n        <div className="mb-4">/,
        replace: '        {true && (\n        <div className="mb-4">',
      },
    ],
  },

  // #116 — take the route back out of the block drawer.
  "116-edit-plan": {
    grep: "#116: an active cutting plan can be reopened from the block drawer",
    edits: [
      {
        file: "src/components/SampleDetailsDrawer.tsx",
        find: /          \{openCutGroups\.map\(\(group\) => \(/,
        replace: "          {[].map((group: { id: number; count: number }) => (",
      },
    ],
  },

  // #115 — remove the reassignment control from the rack drawer.
  "115-reassign": {
    grep: "#115: a slide in staining can be moved to another agent",
    edits: [
      {
        file: "src/components/StackDetailsDrawer.tsx",
        find: /                  \{!readOnly && !selectingSlides && \(\r?\n                    <select\r?\n                      aria-label=\{`Reassign /,
        replace:
          "                  {false && !selectingSlides && (\n                    <select\n                      aria-label={`Reassign ",
      },
    ],
  },

  // #120 — go back to a plain substring test against the stored code.
  "120-search": {
    grep: "#120: the Extras search finds a block by its short code",
    edits: [
      {
        file: "src/lib/utils.ts",
        find: /    \.flatMap\(\(word\) => \[word, \.\.\.sampleCodeVariants\(word\)\]\)\r?\n/,
        replace: "",
      },
      {
        file: "src/lib/utils.ts",
        find: /    return sampleCodeVariants\(term\)\.some\(\(variant\) => hay\.includes\(variant\.toLowerCase\(\)\)\);/,
        replace: "    return false;",
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
