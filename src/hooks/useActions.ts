import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  acknowledgeRequestsForSlide,
  addSample,
  assignExtraSlideToAssay,
  createSectionRequests,
  completeSectionImaging as completeSectionImagingDb,
  deleteSample,
  deleteSectionRequest,
  deleteSlide,
  deleteSlideStack,
  deleteSlideStackIfEmpty,
  deleteSlidesForStack,
  restoreDbPreservingSession,
  getSample,
  getSectionRequest,
  getSlide,
  getSlideStack,
  listSlidesForSectionRequest,
  moveProcessingBatch as moveProcessingBatchDb,
  planProcessingBatch as planProcessingBatchDb,
  confirmProcessingBatchStart as confirmProcessingBatchStartDb,
  updatePlannedBatchMembers,
  requestStainForSample as requestStainForSampleDb,
  recordAuditEvent,
  snapshotDb,
  updateProcessingBatchStart,
  revertSectionToStage,
  revertToStage,
  setBlockExhausted,
  setSampleNotes,
  setSlideNotes,
  setSlidesDepthTag,
  setPickedUp,
  setSamplePriority,
  setSectionTimestamp,
  setSlidePicturesTaken as setSlidePicturesTakenDb,
  setStageTimestamp,
  startProcessingBatch as startProcessingBatchDb,
  updateSlideAssignment,
  updateSampleDetails,
  changeSampleProject as changeSampleProjectDb,
  updateSampleStage,
  updateSectioningPlan,
  updateSectionStage,
  updateSlideStackStage,
} from "../lib/db";
import type { DbImage } from "../lib/db";
import type { NewSampleInput, ProcessingType, Sample, SlidePurpose } from "../lib/types";
import { SECTION_STAGE_LABELS, SECTION_STAGE_ORDER, STAGE_LABELS, STAGE_ORDER } from "../lib/stages";
import { useUndoStore } from "../lib/undo";
import { nowTimestamp } from "../lib/utils";

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

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["open-samples"] });
    qc.invalidateQueries({ queryKey: ["open-sections"] });
    qc.invalidateQueries({ queryKey: ["open-slide-stacks"] });
    qc.invalidateQueries({ queryKey: ["processing-batches"] });
    qc.invalidateQueries({ queryKey: ["section-slides"] });
    qc.invalidateQueries({ queryKey: ["stack-slides"] });
    qc.invalidateQueries({ queryKey: ["imaging-slides"] });
    qc.invalidateQueries({ queryKey: ["protocol-checklist"] });
    qc.invalidateQueries({ queryKey: ["sample-timeline"] });
    qc.invalidateQueries({ queryKey: ["extra-slides"] });
    qc.invalidateQueries({ queryKey: ["stain-requests"] });
    qc.invalidateQueries({ queryKey: ["all-samples"] });
    qc.invalidateQueries({ queryKey: ["all-slides"] });
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
      const before = await snapshotDb();
      const result = await fn();
      invalidate();
      record({ label, snapshot: before });
      return result;
    },
    [invalidate, record],
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

  const editPlannedBatchMembers = useCallback(
    (batchId: number, sampleIds: number[]) =>
      commit("Edit planned run samples", () => updatePlannedBatchMembers(batchId, sampleIds)),
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
      await commit(`Edit time · ${before.sample_code}`, () =>
        setStageTimestamp(sampleId, column, value),
      );
    },
    [commit],
  );

  const saveDetails = useCallback(
    async (sampleId: number, input: Omit<NewSampleInput, "project_id">) => {
      const before = await getSample(sampleId);
      if (!before) return;
      await commit(`Edit ${before.sample_code}`, () => updateSampleDetails(sampleId, input));
    },
    [commit],
  );

  const changeProject = useCallback(
    async (sampleId: number, newProjectId: number) => {
      const before = await getSample(sampleId);
      if (!before) return;
      await commit(`Move ${before.sample_code} to another project`, () =>
        changeSampleProjectDb(sampleId, newProjectId),
      );
    },
    [commit],
  );

  const editSampleNotes = useCallback(
    (sampleId: number, notes: string) => commit("Edit sample notes", () => setSampleNotes(sampleId, notes)),
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

  const removeSample = useCallback(
    async (sampleId: number) => {
      const before = await getSample(sampleId);
      if (!before) return;
      await commit(`Delete ${before.sample_code}`, () => deleteSample(sampleId));
    },
    [commit],
  );

  const removeSamples = useCallback(
    async (sampleIds: number[]) => {
      if (sampleIds.length === 0) return;
      if (sampleIds.length === 1) return removeSample(sampleIds[0]);
      await commit(`Delete ${sampleIds.length} samples`, async () => {
        for (const id of sampleIds) await deleteSample(id);
      });
    },
    [commit, removeSample],
  );

  const createSample = useCallback(
    (input: NewSampleInput, projectCode: string) =>
      commit("Create sample", () => addSample(input, projectCode)),
    [commit],
  );

  // Create N samples that share the same details (issue #1) as a single undo.
  const createSamples = useCallback(
    (input: NewSampleInput, projectCode: string, quantity: number) => {
      const count = Math.max(1, Math.floor(quantity));
      return commit(count === 1 ? "Create sample" : `Create ${count} samples`, async () => {
        const ids: number[] = [];
        for (let i = 0; i < count; i += 1) ids.push(await addSample(input, projectCode));
        return ids;
      });
    },
    [commit],
  );

  // ---- Section requests (children of embedded blocks) ----------------------

  const sendSectionsToCuttingForSamples = useCallback(
    (sampleIds: number[], groups: Array<{ duplicates: number; stains?: string }>) =>
      commit(
        sampleIds.length > 1 ? `Send for cutting · ${sampleIds.length} blocks` : "Send for cutting",
        async () => {
          let total = 0;
          for (const sampleId of sampleIds) {
            const ids = await createSectionRequests(sampleId, groups);
            total += ids.length;
          }
          return total;
        },
      ),
    [commit],
  );

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

  const sendSectionsToCutting = useCallback(
    (sampleId: number, groups: Array<{ duplicates: number; stains?: string }>) =>
      sendSectionsToCuttingForSamples([sampleId], groups),
    [sendSectionsToCuttingForSamples],
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

  const removeSlideStacks = useCallback(
    (stackIds: number[]) => {
      if (stackIds.length === 0) return Promise.resolve();
      return commit(
        `Delete ${stackIds.length} slide stack${stackIds.length === 1 ? "" : "s"}`,
        async () => {
          for (const id of stackIds) {
            await deleteSlidesForStack(id);
            await deleteSlideStack(id);
          }
        },
      );
    },
    [commit],
  );

  const removeSlides = useCallback(
    async (slideIds: number[]) => {
      if (slideIds.length === 0) return;
      // Capture the parent stacks so we can drop any that go empty.
      const stackIds = [
        ...new Set(
          (await Promise.all(slideIds.map(getSlide)))
            .map((slide) => slide?.stack_id)
            .filter((id): id is number => id != null),
        ),
      ];
      await commit(`Delete ${slideIds.length} slide${slideIds.length === 1 ? "" : "s"}`, async () => {
        for (const id of slideIds) await deleteSlide(id);
        for (const id of stackIds) await deleteSlideStackIfEmpty(id);
      });
    },
    [commit],
  );

  const removeSections = useCallback(
    async (sectionIds: number[]) => {
      if (sectionIds.length === 0) return;
      const stackIds = [
        ...new Set(
          (await Promise.all(sectionIds.map((id) => listSlidesForSectionRequest(id))))
            .flat()
            .map((slide) => slide.stack_id)
            .filter((id): id is number => id != null),
        ),
      ];
      await commit(sectionIds.length === 1 ? "Delete section" : `Delete ${sectionIds.length} cut groups`, async () => {
        for (const id of sectionIds) await deleteSectionRequest(id);
        for (const id of stackIds) await deleteSlideStackIfEmpty(id);
      });
    },
    [commit],
  );

  const removeSection = useCallback(
    (sectionId: number) => removeSections([sectionId]),
    [removeSections],
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
    moveSample,
    moveSamples,
    startProcessingBatch,
    planProcessingBatch,
    confirmProcessingBatchStart,
    editPlannedBatchMembers,
    moveProcessingBatch,
    editBatchStart,
    editTimestamp,
    saveDetails,
    changeProject,
    editSampleNotes,
    editSlideNotes,
    tagSlidesDepth,
    saveSectioningPlan,
    removeSample,
    removeSamples,
    createSample,
    createSamples,
    markAnalyzed: (sampleId: number) => moveSample(sampleId, "analyzed"),
    sendSectionsToCutting,
    sendSectionsToCuttingForSamples,
    sendPlansToCutting,
    moveSection,
    moveSections,
    assignSlide,
    assignExtraSlide,
    requestStain,
    setSlidePicturesTaken,
    completeSectionImaging,
    moveSlideStacks,
    completeSlideStacksImaging,
    removeSlideStacks,
    removeSlides,
    editSectionTimestamp,
    removeSection,
    removeSections,
    markSectionAnalyzed: (sectionId: number) => moveSection(sectionId, "analyzed"),
    setExhausted,
    setExhaustedSamples,
    togglePriority,
    undo,
    redo,
  } as const;
}
