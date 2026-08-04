# 0.7.3 pre-release audit

Eleven defects found reviewing the 0.7.3 working tree, each independently
re-checked by a second reviewer trying to refute it. Ten further claims were
raised and refuted; they are not listed here. Severities below are the
**post-refutation** grade, not the finder's original.

Ten are fixed. One is a deliberate no-change, argued at the bottom.

| # | Sev | Where | Defect | Status |
|---|-----|-------|--------|--------|
| 2 | high | `db.ts` `ensureSlidesForSectionRequest` | A READ called a function that WRITES. On a viewer the write is refused and the refusal propagates out of the read, so one uninitialised group blanked the slide list for every group on the card — the exact read #72 promises. | ✅ fixed |
| 1 | med | `db.ts` `deleteSlidesForStack` | Emptied a cut group but never deleted it → "×0" dead card. The cleanup was wired into `removeSlides` only, so the two removal paths disagreed on the same slides in the same drawer. | ✅ fixed |
| 5 | med | `workflow-test.mjs` | Port of `splitContaminatedStainRacks` was still the 0.7.2 stack-column rule, so the #81 repair gate passed under **both** the fixed and the broken implementation. | ✅ fixed |
| 6 | med | both ports | Stray-slide query was single-column; `db.ts` requires all four substage columns NULL. The ports would evict a coverslipped member the app keeps. | ✅ fixed |
| 3 | med | `App.tsx` | Auto-advance not gated on viewer: mutated on mount and every 60 s, was refused, and the global handler flashed a read-only banner nobody triggered — masking real messages in that slot. | ✅ fixed |
| 10 | med | `NewSampleDialog.tsx` | Mismatch warning counted non-empty lines while the splitter mapped positionally, so a leading/interior blank silently shifted every description **and kept the warning silent**. | ✅ fixed |
| 11 | med | `tests/` (11 specs) | **Root cause of the flaky #32.** dnd-kit keeps a capture-phase click swallower for 50 ms after every drop; `dragOnto` returned at `mouse.up()`. | ✅ fixed |
| 4 | low | `Board.tsx` | `onConfirmStart` passed unconditionally → viewers got an enabled "Confirm start" that only produced an error banner. | ✅ fixed |
| 8 | low | 3 sites | `pending_stains` rendered raw → printed `[{"assay_type":"ihc","assay_name":"CD3"}]`. | ✅ fixed |
| 9 | low | `db.ts` ×2 | `ORDER BY slide_ordinal` across sections; the ordinal restarts per group, so grouped cut groups interleaved (A, C, B, D). | ✅ fixed |
| 7 | med | `db.ts:2125` | Existing DBs carry groups emptied by 0.7.0–0.7.2 with `duplicates > 0` and no slides; the first 0.7.3 open refills them. | ⛔ **no change — see below** |

Each fix was observed **failing with the fix removed**. New gates: `issue #83`
(rack path), `issue #81` (cut-group contamination + coverslipped stray),
`issue #75` (multi-section ordering), a viewer e2e test that plants an
uninitialised sibling group, and `normalizePastedLines` unit tests.

## #7 — why no translation ships

The proposal was a one-time `schema_meta` pass zeroing `duplicates` for
zero-slide groups, discriminating on stage so genuinely uninitialised pre-0.4.6
rows still initialise. **That discriminator does not hold.** Both 0.7.x removal
paths can leave the section at `needs_sectioning`:

- `listExtraSlides` filters on the **slide's** stage (`sl.current_stage='extra'`),
  not the section's — so removing extras from the inventory never required the
  section to have advanced.
- Deleting a stain rack reaches slides via `stack_id`. `requestStainForSample`
  deliberately leaves `section_requests.current_stage` alone, so the group is
  still `needs_sectioning` when its slides are deleted. This is exactly the
  sequence finding #1 reproduced.

So "duplicates > 0, zero slides, needs_sectioning" is the *same row shape* for a
group emptied last week and a genuine pre-0.4.6 group nobody has opened. Nothing
else separates them: `slides_issued` is 0 for a never-cut sample and can also be
0 after removals, and both carry `stage_needs_sectioning_at` from creation.

Weighing the two errors:

- **Translate, and get it wrong** → a legitimate legacy cut group is pinned at
  `duplicates = 0`, never initialises, and shows as a permanent "×0" card. Not
  self-healing, and it destroys a real cutting plan.
- **Don't translate** → a group emptied under 0.7.0–0.7.2 refills **once** with
  fresh letters. The technician removes those slides again, `duplicates` now
  follows to 0, and it stays gone. Self-healing after one repetition.

0.7.2 refilled such a group on *every* open, so not translating is already a
strict improvement. Silently guessing on a production database to save one
repetition is the wrong trade — this needs a decision from someone who knows
whether pre-0.4.6 cut groups actually exist in the live database. If they do
not, the blanket pass becomes safe and is a three-line addition.
