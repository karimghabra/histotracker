import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  acknowledgeRequestsForSlide,
  addSample,
  assignExtraSlideToAssay,
  createSectionRequests,
  completeSectionImaging as completeSectionImagingDb,
  removeSectionRequest,
  removeSamples as removeSamplesDb,
  removeSlide,
  reassignSlide as reassignSlideDb,
  addSlideToSection as addSlideToSectionDb,
  splitSlidesIntoNewRack as splitSlidesIntoNewRackDb,
  mergeSlideStacks as mergeSlideStacksDb,
  relabelSlideToSample as relabelSlideToSampleDb,
  closeSlideStack,
  closeSlideStackIfEmpty,
  removeSectionRequestIfEmpty,
  removeSlidesForStack,
  restoreDbPreservingSession,
  getSample,
  getSectionRequest,
  getSlide,
  getSlideStack,
  listSlidesForSectionRequest,
  moveProcessingBatch as moveProcessingBatchDb,
  planProcessingBatch as planProcessingBatchDb,
  confirmProcessingBatchStart as confirmProcessingBatchStartDb,
  updateBatchMembers,
  requestStainForSample as requestStainForSampleDb,
  withdrawStainRequest as withdrawStainRequestDb,
  recordAuditEvent,
  snapshotDb,
  updateProcessingBatchStart,
  revertSectionToStage,
  revertToStage,
  setBlockExhausted,
  setSamplesProcessingType as setSamplesProcessingTypeDb,
  setSampleArchived,
  setSamplesArchived,
  setSampleNote,
  setSampleDescription,
  setSlideNotes,
  setSlidesDepthTag,
  setPickedUp,
  setSamplePriority,
  setSectionTimestamp,
  setSlidePicturesTaken as setSlidePicturesTakenDb,
  setStageTimestamp,
  startProcessingBatch as startProcessingBatchDb,
  updateSlideAssignment,
  updateSampleStage,
  updateSectioningPlan,
  updateSectionStage,
  updateSlideStackStage,
} from "../lib/db";
import type { DbImage } from "../lib/db";
import type { NewSampleInput, ProcessingType, Sample, SlidePurpose } from "../lib/types";
import { sampleNoteLabel } from "../lib/sampleNotes";
import type { SampleNoteField } from "../lib/sampleNotes";
import { SECTION_STAGE_LABELS, SECTION_STAGE_ORDER, STAGE_LABELS, STAGE_ORDER } from "../lib/stages";
import { useUndoStore } from "../lib/undo";
import { composeDescription, displayCode, nowTimestamp } from "../lib/utils";
import { readOnlyMessage, useReadOnly, useReadOnlyReason } from "../lib/readOnly";

/**
 * Central mutation layer. Every action performs its DB write, invalidates the
 * relevant queries, and records a WHOLE-DATABASE snapshot for undo. Because the
 * DB is the single source of truth, undo/redo just swap the entire SQLite file
 * back or forward and let the queries refetch — there are no per-row restore
 * closures to drift out of sync (issue #31; undo/redo rework).
 */
export function useActions() {
  const qc = useQueryClient();
  const record = useUndoStore((s) => s.record);
  const beginNoteSave = useUndoStore((s) => s.beginNoteSave);
  const endNoteSave = useUndoStore((s) => s.endNoteSave);
  const readOnly = useReadOnly();
  const reason = useReadOnlyReason();

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["open-samples"] });
    qc.invalidateQueries({ queryKey: ["open-sections"] });
    qc.invalidateQueries({ queryKey: ["open-slide-stacks"] });
    qc.invalidateQueries({ queryKey: ["processing-batches"] });
    qc.invalidateQueries({ queryKey: ["section-slides"] });
    qc.invalidateQueries({ queryKey: ["sample-slides"] });
    qc.invalidateQueries({ queryKey: ["stack-slides"] });
    qc.invalidateQueries({ queryKey: ["imaging-slides"] });
    qc.invalidateQueries({ queryKey: ["protocol-checklist"] });
    qc.invalidateQueries({ queryKey: ["sample-timeline"] });
    qc.invalidateQueries({ queryKey: ["extra-slides"] });
    qc.invalidateQueries({ queryKey: ["stain-requests"] });
    qc.invalidateQueries({ queryKey: ["all-samples"] });
    qc.invalidateQueries({ queryKey: ["all-slides"] });
    qc.invalidateQueries({ queryKey: ["slide-removals"] });
    qc.invalidateQueries({ queryKey: ["sample-removals"] });
    qc.invalidateQueries({ queryKey: ["audit-events"] });
    // Undo/redo swap the whole DB image; the session-preserving restore re-adds
    // the current users + signed-in user, so refetch those too (#1).
    qc.invalidateQueries({ queryKey: ["users"] });
    qc.invalidateQueries({ queryKey: ["active-user"] });
  }, [qc]);

  // Run a mutation as a single undoable step: capture the DB before the writes,
  // perform them, refetch, and record the pre-state under `label`. The returned
  // value is passed through so callers can still get ids/results.
  const commit = useCallback(
    async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      // ONE read-only refusal for every mutation in the app (#72).
      //
      // Gating was previously per-component opt-in, so each new control was a
      // fresh chance to forget — and a forgotten one failed SILENTLY, because
      // db.ts's guardWrites rejects into a promise nobody awaits. The user
      // clicked "Placed in fixative" and simply nothing happened, twice.
      // Refusing here means a missed surface is merely UGLY (a clear message)
      // rather than mysterious, and the component-level gating above it is now
      // presentation, not the safety mechanism.
      //
      // Since #128 there are two reasons to be here, and they call for different
      // words: a viewer is told to use the workstation, an unsigned user is told
      // to sign in — which is the whole fix, and one click away.
      if (readOnly) throw new Error(readOnlyMessage(reason));
      const before = await snapshotDb();
      const result = await fn();
      invalidate();
      record({ label, snapshot: before });
      return result;
    },
    [invalidate, reason, record, readOnly],
  );

  function validateForwardSampleMove(sample: Sample, stageKey: string) {
    const targetOrder = STAGE_ORDER[stageKey] ?? 0;
    const currentOrder = STAGE_ORDER[sample.current_stage] ?? 0;
    if (targetOrder <= currentOrder || stageKey === "analyzed") return;
    if (stageKey === "processing_started") {
      throw new Error("Start processing through the batch-start review.");
    }
    const requiredPrevious: Record<string, string> = {
      processed: "processing_started",
      needs_embedding: "processed",
      embedded: "needs_embedding",
    };
    const required = requiredPrevious[stageKey];
    if (required && sample.current_stage !== required) {
      throw new Error(
        `${sample.sample_code} must be in ${STAGE_LABELS[required] ?? required} before ${
          STAGE_LABELS[stageKey] ?? stageKey
        }.`,
      );
    }
  }

  async function applySampleMove(sample: Sample, stageKey: string) {
    const targetOrder = STAGE_ORDER[stageKey] ?? 0;
    const currentOrder = STAGE_ORDER[sample.current_stage] ?? 0;
    if (targetOrder < currentOrder) {
      await revertToStage(sample.id, stageKey);
    } else {
      validateForwardSampleMove(sample, stageKey);
      if (sample.current_stage === "processed" && targetOrder > currentOrder) {
        await setPickedUp(sample.id, nowTimestamp());
      }
      await updateSampleStage(sample.id, stageKey);
    }
  }

  const moveSamples = useCallback(
    async (sampleIds: number[], stageKey: string) => {
      if (sampleIds.length === 0) return;
      const before = (await Promise.all(sampleIds.map(getSample))).filter(
        (s): s is Sample => s !== null,
      );
      if (before.length === 0) return;
      // Validate every forward move up front so a mixed batch never leaves a
      // partially-applied state behind (nothing is written until all pass).
      for (const sample of before) {
        const targetOrder = STAGE_ORDER[stageKey] ?? 0;
        const currentOrder = STAGE_ORDER[sample.current_stage] ?? 0;
        if (targetOrder > currentOrder) validateForwardSampleMove(sample, stageKey);
      }
      const label =
        before.length === 1
          ? `Move ${before[0].sample_code} → ${STAGE_LABELS[stageKey] ?? stageKey}`
          : `Move ${before.length} samples → ${STAGE_LABELS[stageKey] ?? stageKey}`;
      await commit(label, async () => {
        for (const sample of before) await applySampleMove(sample, stageKey);
      });
    },
    [commit],
  );

  const moveSample = useCallback(
    (sampleId: number, stageKey: string) => moveSamples([sampleId], stageKey),
    [moveSamples],
  );

  const startProcessingBatch = useCallback(
    (input: {
      sampleIds: number[];
      processingType: ProcessingType;
      operatorName: string;
      startedAt: string;
      checklistLabels: string[];
      notes?: string;
    }) =>
      commit(
        `Start ${input.processingType.toLowerCase()} batch · ${input.sampleIds.length} samples`,
        () => startProcessingBatchDb(input),
      ),
    [commit],
  );

  const planProcessingBatch = useCallback(
    (input: {
      sampleIds: number[];
      processingType: ProcessingType;
      operatorName: string;
      plannedStartAt: string;
      notes?: string;
    }) =>
      commit(
        `Plan ${input.processingType.toLowerCase()} batch · ${input.sampleIds.length} samples`,
        () => planProcessingBatchDb(input),
      ),
    [commit],
  );

  const confirmProcessingBatchStart = useCallback(
    (batchId: number, actualStartedAt?: string) =>
      commit("Confirm processing start", () =>
        confirmProcessingBatchStartDb(batchId, actualStartedAt),
      ),
    [commit],
  );

  const editBatchMembers = useCallback(
    (batchId: number, sampleIds: number[]) =>
      commit("Edit run samples", () => updateBatchMembers(batchId, sampleIds)),
    [commit],
  );

  const moveProcessingBatch = useCallback(
    (batchId: number, stageKey: string) =>
      commit("Move processing batch", () => moveProcessingBatchDb(batchId, stageKey)),
    [commit],
  );

  const editBatchStart = useCallback(
    (batchId: number, startedAt: string) =>
      commit("Edit processing start time", () => updateProcessingBatchStart(batchId, startedAt)),
    [commit],
  );

  const editTimestamp = useCallback(
    async (sampleId: number, column: string, value: string | null) => {
      const before = await getSample(sampleId);
      if (!before) return;
      await commit(`Edit time · ${displayCode(before.sample_code)}`, () =>
        setStageTimestamp(sampleId, column, value),
      );
    },
    [commit],
  );

  /**
   * Correct one of a sample's four notes. A note is typed once, at intake, and
   * read back later in the log; until this existed the log was where you found
   * out a note was wrong and also where you could do nothing about it.
   *
   * Unchanged text is dropped rather than committed, so reading a note — which
   * means focusing and blurring a textarea — never buries the user's real undo
   * history under no-op entries.
   */
  const editSampleNote = useCallback(
    async (sampleId: number, field: SampleNoteField, text: string) => {
      beginNoteSave();
      try {
        const before = await getSample(sampleId);
        if (!before) return;
        if ((before[field] ?? "") === text.trim()) return;
        // displayCode, because this label is shown to the user in the undo flash
        // and every other surface calls the block EE-1, not EE-0001 (#87).
        await commit(
          `Edit ${displayCode(before.sample_code)} ${sampleNoteLabel(field).toLowerCase()}`,
          () => setSampleNote(sampleId, field, text),
        );
      } finally {
        endNoteSave();
      }
    },
    [commit, beginNoteSave, endNoteSave],
  );

  /**
   * Change just the description (#79). saveDetails() needs the whole
   * NewSampleInput, which makes it awkward to call from a plain text field and
   * risks writing stale values for every other column; this touches one column.
   */
  const editSampleDescription = useCallback(
    async (sampleId: number, description: string) => {
      const before = await getSample(sampleId);
      if (!before || (before.sample_description ?? "") === description.trim()) return;
      await commit(`Edit ${displayCode(before.sample_code)} description`, () =>
        setSampleDescription(sampleId, description),
      );
    },
    [commit],
  );
  const tagSlidesDepth = useCallback(
    (slideIds: number[], label: string, note: string) =>
      commit(
        label.trim() ? `Tag ${slideIds.length} slide(s) · ${label.trim()}` : `Clear depth tag`,
        () => setSlidesDepthTag(slideIds, label, note),
      ),
    [commit],
  );

  const editSlideNotes = useCallback(
    (slideId: number, notes: string) => commit("Edit slide notes", () => setSlideNotes(slideId, notes)),
    [commit],
  );

  const saveSectioningPlan = useCallback(
    async (sampleId: number, plan: Array<{ duplicates: number; stains?: string }>) => {
      const before = await getSample(sampleId);
      if (!before) return;
      await commit(`Sectioning plan · ${before.sample_code}`, () =>
        updateSectioningPlan(sampleId, plan),
      );
    },
    [commit],
  );

  // removeSample/removeSamples are GONE (#83) — see the note where
  // deleteSample() used to live in db.ts. Use setArchived/setArchivedSamples.

  /**
   * Create N samples as ONE undo entry. `descriptions[i]` overrides the shared
   * description for sample i; a blank or missing entry keeps the shared one
   * (#86). The loop is sequential and awaited, so index i maps deterministically
   * to the i-th minted code.
   *
   * `embeddingNotes`, when given, is sample i's OWN embedding note and replaces
   * `input.embedding_notes` outright — unlike a description it is not composed
   * with the shared value, because "one note for all" and "a note for each" are
   * two modes the dialog chooses between, not a prefix and a suffix (#137).
   */
  const createSamples = useCallback(
    (
      input: NewSampleInput,
      projectCode: string,
      quantity: number,
      each?: { descriptions?: string[]; embeddingNotes?: string[] },
    ) => {
      const count = Math.max(1, Math.floor(quantity));
      return commit(count === 1 ? "Create sample" : `Create ${count} samples`, async () => {
        const ids: number[] = [];
        for (let i = 0; i < count; i += 1) {
          // The shared field is a PREFIX, not a fallback (#86) — see
          // composeDescription. Same helper the dialog previews with, so what
          // the technician reads in the row list is what gets stored.
          const resolved = composeDescription(input.sample_description, each?.descriptions?.[i] ?? "");
          const embedding = each?.embeddingNotes
            ? (each.embeddingNotes[i] ?? "")
            : input.embedding_notes;
          ids.push(
            await addSample(
              { ...input, sample_description: resolved, embedding_notes: embedding },
              projectCode,
            ),
          );
        }
        return ids;
      });
    },
    [commit],
  );

  // ---- Section requests (children of embedded blocks) ----------------------

  // Cut each block by its own reviewed/edited plan (the batch navigator sends
  // one entry per block; a single block is just one entry).
  const sendPlansToCutting = useCallback(
    (
      entries: Array<{
        sampleId: number;
        groups: Array<{ duplicates: number; stains?: string; assay_type?: string; assay_name?: string }>;
      }>,
    ) =>
      commit(entries.length > 1 ? `Send for cutting · ${entries.length} blocks` : "Send for cutting", async () => {
        let total = 0;
        for (const { sampleId, groups } of entries) {
          total += (await createSectionRequests(sampleId, groups)).length;
        }
        return total;
      }),
    [commit],
  );

  const moveSections = useCallback(
    async (sectionIds: number[], stageKey: string) => {
      if (sectionIds.length === 0) return;
      const before = (await Promise.all(sectionIds.map(getSectionRequest))).filter(
        (s): s is NonNullable<typeof s> => s !== null,
      );
      if (before.length === 0) return;
      const targetOrder = SECTION_STAGE_ORDER[stageKey] ?? 0;

      // Preflight: don't start assays until every slide's disposition is saved.
      if (stageKey === "stain_requested") {
        const incomplete = await Promise.all(
          before.map(async (section) => {
            const slides = await listSlidesForSectionRequest(section.id);
            return slides.some((slide) => slide.assignment_saved === 0) ? section.id : null;
          }),
        );
        const incompleteIds = incomplete.filter((id): id is number => id !== null);
        if (incompleteIds.length > 0) {
          throw new Error(`Save every slide assignment before starting assays (sections: ${incompleteIds.join(", ")}).`);
        }
      }
      for (const section of before) {
        const currentOrder = SECTION_STAGE_ORDER[section.current_stage] ?? 0;
        if (
          stageKey === "pictures_taken" &&
          currentOrder < (SECTION_STAGE_ORDER.stained ?? Number.MAX_SAFE_INTEGER)
        ) {
          throw new Error("Complete staining before moving slides to pictures or analysis.");
        }
      }
      const label =
        before.length === 1
          ? `Move section → ${SECTION_STAGE_LABELS[stageKey] ?? stageKey}`
          : `Move ${before.length} sections → ${SECTION_STAGE_LABELS[stageKey] ?? stageKey}`;
      await commit(label, async () => {
        for (const section of before) {
          const currentOrder = SECTION_STAGE_ORDER[section.current_stage] ?? 0;
          if (targetOrder < currentOrder) await revertSectionToStage(section.id, stageKey);
          else await updateSectionStage(section.id, stageKey);
        }
      });
    },
    [commit],
  );

  const moveSection = useCallback(
    (sectionId: number, stageKey: string) => moveSections([sectionId], stageKey),
    [moveSections],
  );

  const editSectionTimestamp = useCallback(
    (sectionId: number, column: string, value: string | null) =>
      commit("Edit section time", () => setSectionTimestamp(sectionId, column, value)),
    [commit],
  );

  const assignSlide = useCallback(
    async (
      slideId: number,
      purpose: SlidePurpose,
      assayType: "" | "stain" | "ihc",
      assayName: string,
    ) => {
      const before = await getSlide(slideId);
      if (!before) return;
      await commit(`Assign ${before.slide_code}`, async () => {
        await updateSlideAssignment(slideId, purpose, assayType, assayName);
        if (purpose === "stain") await acknowledgeRequestsForSlide(slideId);
      });
    },
    [commit],
  );

  const assignExtraSlide = useCallback(
    async (input: { slideId: number; assayType: "stain" | "ihc"; assayName: string }) => {
      const before = await getSlide(input.slideId);
      if (!before) return;
      await commit(`Assign ${before.slide_code}`, async () => {
        await assignExtraSlideToAssay(input);
        await acknowledgeRequestsForSlide(input.slideId);
      });
    },
    [commit],
  );

  // Request a new stain for a sample (issues #2, #39, #41).
  const requestStain = useCallback(
    (sampleId: number, assayType: "stain" | "ihc", assayName: string) =>
      commit(`Request ${assayName}`, () =>
        requestStainForSampleDb({ sampleId, assayType, assayName }),
      ),
    [commit],
  );

  /**
   * Add one agent to EVERY selected block (#109).
   *
   * The drawer has always been multi-select — the checklist, Start Run, Delete
   * and Mark Exhausted all act on the selection — but the stain dropdown read
   * `sample.id` and quietly did one block, so selecting twelve and asking for
   * H&E gave you one slide and no hint that the other eleven were skipped.
   *
   * A refusal is per-block, not per-batch: an exhausted block with no extras
   * left legitimately rejects a request (#70), and that must not abandon the
   * eleven blocks behind it in the loop. Failures are collected and returned so
   * the caller can name them. Still ONE undo step — the snapshot is taken before
   * the first write, so Ctrl+Z puts all of it back.
   */
  const requestStainForSamples = useCallback(
    (sampleIds: number[], assayType: "stain" | "ihc", assayName: string) =>
      commit(
        sampleIds.length === 1
          ? `Request ${assayName}`
          : `Request ${assayName} · ${sampleIds.length} blocks`,
        async () => {
          const added: number[] = [];
          const pulled: number[] = [];
          // Blocks whose request joined a cut they were already queued for
          // (#125) — neither "pulled from stock" nor "needs cutting", and
          // reporting it as either would be a lie about what happens next.
          const joined: number[] = [];
          const failed: Array<{ sampleId: number; message: string }> = [];
          for (const sampleId of sampleIds) {
            try {
              const result = await requestStainForSampleDb({ sampleId, assayType, assayName });
              if (result.target === "extra") pulled.push(sampleId);
              else if (result.target === "cut") joined.push(sampleId);
              else added.push(sampleId);
            } catch (error) {
              failed.push({
                sampleId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
          return { added, pulled, joined, failed };
        },
      ),
    [commit],
  );

  /** Take back an outstanding stain request (#112). */
  const withdrawStainRequest = useCallback(
    (sampleId: number, assayType: string, assayName: string) =>
      commit(`Withdraw ${assayName} request`, () =>
        withdrawStainRequestDb(sampleId, assayType, assayName),
      ),
    [commit],
  );

  /**
   * One more slide off the same ribbon, into a group that already exists.
   *
   * The alternative was a whole new cutting plan, which records a second trip to
   * the microtome that never happened.
   */
  const addSlideToSection = useCallback(
    (
      sectionId: number,
      target: { assayType: "stain" | "ihc"; assayName: string } | { extra: true },
    ) =>
      commit(
        "extra" in target ? "Add an extra slide to this cut" : `Add a ${target.assayName} slide to this cut`,
        () => addSlideToSectionDb(sectionId, target),
      ),
    [commit],
  );

  /** File a slide under the block it actually came from, with a reason (C4). */
  const relabelSlideToSample = useCallback(
    (slideId: number, targetSampleId: number, reason: string) =>
      commit("Relabel a slide onto another block", () =>
        relabelSlideToSampleDb(slideId, targetSampleId, reason),
      ),
    [commit],
  );

  /** Move a slide to a different agent, or back to extras (#115). */
  const reassignSlide = useCallback(
    (
      slideId: number,
      target: { assayType: "stain" | "ihc"; assayName: string } | { extra: true },
    ) =>
      commit(
        "extra" in target ? "Return slide to extras" : `Reassign slide → ${target.assayName}`,
        () => reassignSlideDb(slideId, target),
      ),
    [commit],
  );

  /**
   * Move a whole selection onto another agent, or back to extras (#126).
   *
   * ONE undo step for the lot — the snapshot is taken before the first write, so
   * Ctrl+Z puts every slide back where it was rather than unpicking them one at
   * a time.
   *
   * Failures are collected, not thrown. `reassignSlide` legitimately refuses
   * individual slides (an uncut one, one that has already been imaged), and a
   * technician moving twelve slides should not lose the eleven that were fine
   * because the twelfth was photographed this morning. Same shape as
   * `requestStainForSamples`, and for the same reason.
   */
  const reassignSlides = useCallback(
    (
      slideIds: number[],
      target: { assayType: "stain" | "ihc"; assayName: string } | { extra: true },
    ) =>
      commit(
        "extra" in target
          ? `Return ${slideIds.length} slide${slideIds.length === 1 ? "" : "s"} to extras`
          : `Reassign ${slideIds.length} slide${slideIds.length === 1 ? "" : "s"} → ${target.assayName}`,
        async () => {
          const moved: number[] = [];
          const failed: Array<{ slideId: number; message: string }> = [];
          for (const slideId of slideIds) {
            try {
              await reassignSlideDb(slideId, target);
              moved.push(slideId);
            } catch (error) {
              failed.push({
                slideId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
          // Say so if some were refused — silently moving eleven of twelve is
          // the failure mode that gets noticed a week later.
          if (failed.length > 0 && moved.length === 0) throw new Error(failed[0].message);
          if (failed.length > 0) {
            throw new Error(
              `Moved ${moved.length}; ${failed.length} refused — ${failed[0].message}`,
            );
          }
          return { moved, failed };
        },
      ),
    [commit],
  );

  /** Divide a rack in two (#124). */
  const splitSlidesIntoNewRack = useCallback(
    (slideIds: number[]) =>
      commit(
        `Split ${slideIds.length} slide${slideIds.length === 1 ? "" : "s"} into a new rack`,
        () => splitSlidesIntoNewRackDb(slideIds),
      ),
    [commit],
  );

  /** Pour several racks into one (#124). */
  const mergeSlideStacks = useCallback(
    (stackIds: number[]) =>
      commit(`Merge ${stackIds.length} racks`, () => mergeSlideStacksDb(stackIds)),
    [commit],
  );

  const setSlidePicturesTaken = useCallback(
    async (slideId: number, complete: boolean) => {
      const before = await getSlide(slideId);
      if (!before) return;
      await commit(`${complete ? "Image" : "Reopen imaging for"} ${before.slide_code}`, () =>
        setSlidePicturesTakenDb(slideId, complete),
      );
    },
    [commit],
  );

  const completeSectionImaging = useCallback(
    (sectionIds: number[]) =>
      commit(`Complete imaging (${sectionIds.length})`, async () => {
        await Promise.all(sectionIds.map((id) => completeSectionImagingDb(id)));
      }),
    [commit],
  );

  const moveSlideStacks = useCallback(
    async (stackIds: number[], stageKey: string) => {
      if (stackIds.length === 0) return;
      const targetOrder = SECTION_STAGE_ORDER[stageKey];
      if (targetOrder === undefined) throw new Error(`Unknown slide-stack stage: ${stageKey}`);
      const sources = (await Promise.all(stackIds.map((id) => getSlideStack(id)))).filter(
        (stack): stack is NonNullable<typeof stack> => stack !== null,
      );
      for (const stack of sources) {
        if (targetOrder <= (SECTION_STAGE_ORDER[stack.current_stage] ?? -1)) {
          throw new Error("Slide stacks can only move forward through the workflow.");
        }
      }
      await commit(
        `Move ${sources.length} slide stack${sources.length === 1 ? "" : "s"} → ${SECTION_STAGE_LABELS[stageKey] ?? stageKey}`,
        async () => {
          for (const stack of sources) await updateSlideStackStage(stack.id, stageKey);
        },
      );
    },
    [commit],
  );

  const completeSlideStacksImaging = useCallback(
    (stackIds: number[]) => moveSlideStacks(stackIds, "pictures_taken"),
    [moveSlideStacks],
  );

  // Every removal below takes a REASON and destroys nothing (#83). The slides
  // keep their rows, their timestamps and their letters; they leave the board and
  // their rack, and the Logs view shows them flagged with the reason. See
  // `removeSlide` in db.ts for why the stage carries this rather than a column.
  const removeSlideStacks = useCallback(
    (stackIds: number[], reason: string) => {
      if (stackIds.length === 0) return Promise.resolve();
      return commit(
        `Remove ${stackIds.length} slide stack${stackIds.length === 1 ? "" : "s"}`,
        async () => {
          for (const id of stackIds) {
            await removeSlidesForStack(id, reason);
            await closeSlideStack(id);
          }
        },
      );
    },
    [commit],
  );

  const removeSlides = useCallback(
    async (slideIds: number[], reason: string) => {
      if (slideIds.length === 0) return;
      // Capture the parent stacks AND cut groups so we can retire any that go
      // empty — read them first, because removal detaches each slide from its
      // stack, so afterwards nothing points back (#83).
      const parents = await Promise.all(slideIds.map(getSlide));
      const stackIds = [
        ...new Set(parents.map((slide) => slide?.stack_id).filter((id): id is number => id != null)),
      ];
      const sectionIds = [
        ...new Set(
          parents.map((slide) => slide?.section_request_id).filter((id): id is number => id != null),
        ),
      ];
      await commit(`Remove ${slideIds.length} slide${slideIds.length === 1 ? "" : "s"}`, async () => {
        for (const id of slideIds) await removeSlide(id, reason);
        for (const id of stackIds) await closeSlideStackIfEmpty(id);
        for (const id of sectionIds) await removeSectionRequestIfEmpty(id);
      });
    },
    [commit],
  );

  const removeSections = useCallback(
    async (sectionIds: number[], reason: string) => {
      if (sectionIds.length === 0) return;
      const stackIds = [
        ...new Set(
          (await Promise.all(sectionIds.map((id) => listSlidesForSectionRequest(id))))
            .flat()
            .map((slide) => slide.stack_id)
            .filter((id): id is number => id != null),
        ),
      ];
      await commit(sectionIds.length === 1 ? "Remove cut group" : `Remove ${sectionIds.length} cut groups`, async () => {
        for (const id of sectionIds) await removeSectionRequest(id, reason);
        for (const id of stackIds) await closeSlideStackIfEmpty(id);
      });
    },
    [commit],
  );

  const setExhausted = useCallback(
    async (sampleId: number, exhausted: boolean) => {
      const before = await getSample(sampleId);
      if (!before) return;
      await commit(
        exhausted ? `Exhaust ${before.sample_code}` : `Restore ${before.sample_code}`,
        () => setBlockExhausted(sampleId, exhausted),
      );
    },
    [commit],
  );

  const setExhaustedSamples = useCallback(
    (sampleIds: number[], exhausted: boolean) =>
      commit(`${exhausted ? "Exhaust" : "Restore"} ${sampleIds.length} samples`, async () => {
        for (const id of sampleIds) await setBlockExhausted(id, exhausted);
      }),
    [commit],
  );

  // #134 — switch blocks between the Short and Long runs, in bulk, before they
  // reach the processor. Returns how many actually moved: the data layer skips
  // blocks past pre-processing, so "switch 11" can legitimately move 10, and the
  // caller has to be able to say which happened.
  const setSamplesProcessingType = useCallback(
    (sampleIds: number[], processingType: "Short" | "Long") =>
      commit(`Switch ${sampleIds.length} blocks to the ${processingType} run`, () =>
        setSamplesProcessingTypeDb(sampleIds, processingType),
      ),
    [commit],
  );

  // #74 — archiving is a reversible flag, not a delete, so it rides the normal
  // undo stack and never touches numbering.
  const setArchived = useCallback(
    async (sampleId: number, archived: boolean) => {
      const before = await getSample(sampleId);
      if (!before) return;
      await commit(
        archived ? `Archive ${before.sample_code}` : `Unarchive ${before.sample_code}`,
        () => setSampleArchived(sampleId, archived),
      );
    },
    [commit],
  );

  const setArchivedSamples = useCallback(
    (sampleIds: number[], archived: boolean) =>
      commit(
        `${archived ? "Archive" : "Unarchive"} ${sampleIds.length} sample${sampleIds.length === 1 ? "" : "s"}`,
        () => setSamplesArchived(sampleIds, archived),
      ),
    [commit],
  );

  // #96 — the board's own removal. Distinct from archiving: archiving hides a
  // block you still expect to want, this records one that should not be on the
  // board at all, with the reason. Nothing is deleted either way.
  const removeSamples = useCallback(
    (sampleIds: number[], reason: string) =>
      commit(
        sampleIds.length === 1 ? "Remove sample" : `Remove ${sampleIds.length} samples`,
        () => removeSamplesDb(sampleIds, reason),
      ),
    [commit],
  );

  const togglePriority = useCallback(
    async (sampleId: number) => {
      const before = await getSample(sampleId);
      if (!before) return;
      const next = before.is_priority !== 1;
      await commit(
        next ? `Prioritize ${before.sample_code}` : `Remove priority from ${before.sample_code}`,
        () => setSamplePriority(sampleId, next),
      );
    },
    [commit],
  );

  const undo = useCallback(async (): Promise<string | null> => {
    const { undoStack } = useUndoStore.getState();
    if (undoStack.length === 0) return null;
    const label = undoStack[undoStack.length - 1].label;
    const current = await snapshotDb();
    const entry = useUndoStore.getState().commitUndo({ label, snapshot: current });
    if (!entry) return null;
    await restoreDbPreservingSession(entry.snapshot as DbImage);
    invalidate();
    await recordAuditEvent("undo", "undo_command", `Undid: ${entry.label}`, entry.label);
    return entry.label;
  }, [invalidate]);

  const redo = useCallback(async (): Promise<string | null> => {
    const { redoStack } = useUndoStore.getState();
    if (redoStack.length === 0) return null;
    const label = redoStack[redoStack.length - 1].label;
    const current = await snapshotDb();
    const entry = useUndoStore.getState().commitRedo({ label, snapshot: current });
    if (!entry) return null;
    await restoreDbPreservingSession(entry.snapshot as DbImage);
    invalidate();
    await recordAuditEvent("redo", "undo_command", `Redid: ${entry.label}`, entry.label);
    return entry.label;
  }, [invalidate]);

  return {
    moveSamples,
    startProcessingBatch,
    planProcessingBatch,
    confirmProcessingBatchStart,
    editBatchMembers,
    moveProcessingBatch,
    editBatchStart,
    editTimestamp,
    editSampleNote,
    editSampleDescription,
    editSlideNotes,
    tagSlidesDepth,
    saveSectioningPlan,
    createSamples,
    markAnalyzed: (sampleId: number) => moveSample(sampleId, "analyzed"),
    sendPlansToCutting,
    moveSection,
    moveSections,
    assignSlide,
    assignExtraSlide,
    requestStain,
    requestStainForSamples,
    reassignSlide,
    reassignSlides,
    splitSlidesIntoNewRack,
    mergeSlideStacks,
    addSlideToSection,
    relabelSlideToSample,
    withdrawStainRequest,
    setSlidePicturesTaken,
    completeSectionImaging,
    moveSlideStacks,
    completeSlideStacksImaging,
    removeSlideStacks,
    removeSlides,
    editSectionTimestamp,
    removeSections,
    markSectionAnalyzed: (sectionId: number) => moveSection(sectionId, "analyzed"),
    setExhausted,
    setExhaustedSamples,
    setSamplesProcessingType,
    setArchived,
    setArchivedSamples,
    removeSamples,
    togglePriority,
    undo,
    redo,
  } as const;
}
