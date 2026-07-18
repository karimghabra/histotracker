import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  acknowledgeRequestsForSlide,
  addSample,
  assignExtraSlideToAssay,
  createSectionRequests,
  completeSectionImaging as completeSectionImagingDb,
  deleteSample,
  deleteProcessingBatch,
  deleteSectionRequest,
  deleteSlide,
  deleteSlideStack,
  deleteSlideStackIfEmpty,
  deleteSlidesForStack,
  getOpenSlideStack,
  getProcessingBatchSamples,
  getSample,
  getSlideStack,
  getSectionRequest,
  getSlide,
  listSlidesForSectionRequest,
  listSlidesForStack,
  listChecklistRunsForScope,
  moveProcessingBatch as moveProcessingBatchDb,
  reinsertSample,
  reinsertSectionRequest,
  reinsertSlide,
  reinsertSlideStack,
  reinsertChecklistRuns,
  recordAuditEvent,
  restoreSample,
  restoreSectionRequest,
  restoreSlide,
  restoreSlideStack,
  updateProcessingBatchStart,
  revertSectionToStage,
  revertToStage,
  setBlockExhausted,
  setPickedUp,
  setSamplePriority,
  setSectionTimestamp,
  setSlidePicturesTaken as setSlidePicturesTakenDb,
  setStageTimestamp,
  startProcessingBatch as startProcessingBatchDb,
  updateSlideAssignment,
  updateSampleDetails,
  updateSampleStage,
  updateSectioningPlan,
  updateSectionStage,
  updateSlideStackStage,
} from "../lib/db";
import type { NewSampleInput, ProcessingType, Sample, SectionRequest, Slide, SlidePurpose, SlideStack } from "../lib/types";
import { SECTION_STAGE_LABELS, SECTION_STAGE_ORDER, STAGE_LABELS, STAGE_ORDER } from "../lib/stages";
import { useUndoStore } from "../lib/undo";
import { nowTimestamp } from "../lib/utils";

/**
 * Central mutation layer. Every action performs its DB write, invalidates the
 * relevant queries, and records an undo/redo command (snapshot-based).
 */
export function useActions() {
  const qc = useQueryClient();
  const record = useUndoStore((s) => s.record);
  const popUndo = useUndoStore((s) => s.popUndo);
  const popRedo = useUndoStore((s) => s.popRedo);

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
  }, [qc]);

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

  // Record a command that restores a sample between two snapshots.
  const recordRestore = useCallback(
    (label: string, before: Sample, after: Sample) => {
      record({
        label,
        undo: async () => {
          await restoreSample(before);
          invalidate();
        },
        redo: async () => {
          await restoreSample(after);
          invalidate();
        },
      });
    },
    [invalidate, record],
  );

  // Same, for section-request snapshots.
  const recordRestoreSection = useCallback(
    (
      label: string,
      before: SectionRequest,
      after: SectionRequest,
      beforeSlides: Awaited<ReturnType<typeof listSlidesForSectionRequest>>,
      afterSlides: Awaited<ReturnType<typeof listSlidesForSectionRequest>>,
    ) => {
      record({
        label,
        undo: async () => {
          await restoreSectionRequest(before);
          for (const slide of beforeSlides) await restoreSlide(slide);
          invalidate();
        },
        redo: async () => {
          await restoreSectionRequest(after);
          for (const slide of afterSlides) await restoreSlide(slide);
          invalidate();
        },
      });
    },
    [invalidate, record],
  );

  const moveSample = useCallback(
    async (sampleId: number, stageKey: string) => {
      const before = await getSample(sampleId);
      if (!before) return;
      const targetOrder = STAGE_ORDER[stageKey] ?? 0;
      const currentOrder = STAGE_ORDER[before.current_stage] ?? 0;

      if (targetOrder < currentOrder) {
        await revertToStage(sampleId, stageKey);
      } else {
        validateForwardSampleMove(before, stageKey);
        // Leaving the processor-pickup queue records the pickup time.
        if (before.current_stage === "processed" && targetOrder > currentOrder) {
          await setPickedUp(sampleId, nowTimestamp());
        }
        await updateSampleStage(sampleId, stageKey);
      }
      invalidate();
      const after = await getSample(sampleId);
      if (after) {
        recordRestore(`Move ${before.sample_code} → ${STAGE_LABELS[stageKey] ?? stageKey}`, before, after);
      }
    },
    [invalidate, recordRestore],
  );

  const moveSamples = useCallback(
    async (sampleIds: number[], stageKey: string) => {
      if (sampleIds.length === 0) return;
      if (sampleIds.length === 1) return moveSample(sampleIds[0], stageKey);
      const before = (await Promise.all(sampleIds.map(getSample))).filter(
        (s): s is Sample => s !== null,
      );
      for (const sample of before) validateForwardSampleMove(sample, stageKey);
      for (const sample of before) {
        const targetOrder = STAGE_ORDER[stageKey] ?? 0;
        const currentOrder = STAGE_ORDER[sample.current_stage] ?? 0;
        if (targetOrder < currentOrder) {
          await revertToStage(sample.id, stageKey);
        } else {
          if (sample.current_stage === "processed" && targetOrder > currentOrder) {
            await setPickedUp(sample.id, nowTimestamp());
          }
          await updateSampleStage(sample.id, stageKey);
        }
      }
      invalidate();
      const after = (await Promise.all(sampleIds.map(getSample))).filter(
        (s): s is Sample => s !== null,
      );
      record({
        label: `Move ${before.length} samples → ${STAGE_LABELS[stageKey] ?? stageKey}`,
        undo: async () => {
          for (const snapshot of before) await restoreSample(snapshot);
          invalidate();
        },
        redo: async () => {
          for (const snapshot of after) await restoreSample(snapshot);
          invalidate();
        },
      });
    },
    [invalidate, moveSample, record],
  );

  const startProcessingBatch = useCallback(
    async (input: {
      sampleIds: number[];
      processingType: ProcessingType;
      operatorName: string;
      startedAt: string;
      checklistLabels: string[];
      notes?: string;
    }) => {
      const before = (await Promise.all(input.sampleIds.map(getSample))).filter(
        (s): s is Sample => s !== null,
      );
      let batchId = await startProcessingBatchDb(input);
      invalidate();
      const after = (await Promise.all(input.sampleIds.map(getSample))).filter(
        (s): s is Sample => s !== null,
      );
      record({
        label: `Start ${input.processingType.toLowerCase()} batch · ${input.sampleIds.length} samples`,
        undo: async () => {
          for (const snapshot of before) await restoreSample(snapshot);
          await deleteProcessingBatch(batchId);
          invalidate();
        },
        redo: async () => {
          batchId = await startProcessingBatchDb(input);
          for (const snapshot of after) await restoreSample(snapshot);
          invalidate();
        },
      });
      return batchId;
    },
    [invalidate, record],
  );

  const moveProcessingBatch = useCallback(
    async (batchId: number, stageKey: string) => {
      const before = await getProcessingBatchSamples(batchId);
      await moveProcessingBatchDb(batchId, stageKey);
      invalidate();
      const after = await getProcessingBatchSamples(batchId);
      record({
        label: `Move processing batch · ${before.length} samples`,
        undo: async () => {
          for (const snapshot of before) await restoreSample(snapshot);
          invalidate();
        },
        redo: async () => {
          for (const snapshot of after) await restoreSample(snapshot);
          invalidate();
        },
      });
    },
    [invalidate, record],
  );

  // Correct a processing batch's start time; undo restores the previous time
  // (members share it, so re-applying recomputes ready_at both ways). Issue #6.
  const editBatchStart = useCallback(
    async (batchId: number, startedAt: string) => {
      const members = await getProcessingBatchSamples(batchId);
      const oldStart = members[0]?.processing_started_at ?? null;
      await updateProcessingBatchStart(batchId, startedAt);
      invalidate();
      if (!oldStart) return;
      record({
        label: "Edit processing start time",
        undo: async () => {
          await updateProcessingBatchStart(batchId, oldStart);
          invalidate();
        },
        redo: async () => {
          await updateProcessingBatchStart(batchId, startedAt);
          invalidate();
        },
      });
    },
    [invalidate, record],
  );

  const editTimestamp = useCallback(
    async (sampleId: number, column: string, value: string | null) => {
      const before = await getSample(sampleId);
      if (!before) return;
      await setStageTimestamp(sampleId, column, value);
      invalidate();
      const after = await getSample(sampleId);
      if (after) recordRestore(`Edit time · ${before.sample_code}`, before, after);
    },
    [invalidate, recordRestore],
  );

  const saveDetails = useCallback(
    async (sampleId: number, input: Omit<NewSampleInput, "project_id">) => {
      const before = await getSample(sampleId);
      if (!before) return;
      await updateSampleDetails(sampleId, input);
      invalidate();
      const after = await getSample(sampleId);
      if (after) recordRestore(`Edit ${before.sample_code}`, before, after);
    },
    [invalidate, recordRestore],
  );

  const saveSectioningPlan = useCallback(
    async (sampleId: number, plan: Array<{ depth_um: number; duplicates: number }>) => {
      const before = await getSample(sampleId);
      if (!before) return;
      await updateSectioningPlan(sampleId, plan);
      invalidate();
      const after = await getSample(sampleId);
      if (after) recordRestore(`Sectioning plan · ${before.sample_code}`, before, after);
    },
    [invalidate, recordRestore],
  );

  const removeSample = useCallback(
    async (sampleId: number) => {
      const before = await getSample(sampleId);
      if (!before) return;
      await deleteSample(sampleId);
      invalidate();
      record({
        label: `Delete ${before.sample_code}`,
        undo: async () => {
          await reinsertSample(before);
          invalidate();
        },
        redo: async () => {
          await deleteSample(sampleId);
          invalidate();
        },
      });
    },
    [invalidate, record],
  );

  const createSample = useCallback(
    async (input: NewSampleInput, projectCode: string) => {
      const newId = await addSample(input, projectCode);
      invalidate();
      const after = await getSample(newId);
      record({
        label: after ? `Create ${after.sample_code}` : "Create sample",
        undo: async () => {
          await deleteSample(newId);
          invalidate();
        },
        redo: async () => {
          if (after) await reinsertSample(after);
          invalidate();
        },
      });
      return newId;
    },
    [invalidate, record],
  );

  // Create N samples that share the same details (issue #1). Codes are issued
  // sequentially so each gets its own project number; the whole batch is a
  // single undo entry.
  const createSamples = useCallback(
    async (input: NewSampleInput, projectCode: string, quantity: number) => {
      const count = Math.max(1, Math.floor(quantity));
      const ids: number[] = [];
      for (let i = 0; i < count; i += 1) {
        ids.push(await addSample(input, projectCode));
      }
      invalidate();
      const created = (await Promise.all(ids.map(getSample))).filter(
        (s): s is Sample => s !== null,
      );
      record({
        label:
          created.length === 1
            ? created[0]
              ? `Create ${created[0].sample_code}`
              : "Create sample"
            : `Create ${created.length} samples`,
        undo: async () => {
          for (const id of ids) await deleteSample(id);
          invalidate();
        },
        redo: async () => {
          for (const snapshot of created) await reinsertSample(snapshot);
          invalidate();
        },
      });
      return ids;
    },
    [invalidate, record],
  );

  const removeSamples = useCallback(
    async (sampleIds: number[]) => {
      for (const sampleId of sampleIds) await removeSample(sampleId);
    },
    [removeSample],
  );

  // ---- Section requests (children of embedded blocks) ----------------------

  const sendSectionsToCutting = useCallback(
    async (
      sampleId: number,
      groups: Array<{ depth_um: number; duplicates: number; stains?: string }>,
    ) => {
      const beforeBlock = await getSample(sampleId);
      const ids = await createSectionRequests(sampleId, groups);
      invalidate();
      const afterBlock = await getSample(sampleId);
      const created = (await Promise.all(ids.map((id) => getSectionRequest(id)))).filter(
        (r): r is SectionRequest => r !== null,
      );
      const createdSlides = (
        await Promise.all(ids.map((id) => listSlidesForSectionRequest(id)))
      ).flat();
      record({
        label: `Send ${ids.length} section${ids.length === 1 ? "" : "s"} to cutting`,
        undo: async () => {
          for (const id of ids) await deleteSectionRequest(id);
          if (beforeBlock) await restoreSample(beforeBlock);
          invalidate();
        },
        redo: async () => {
          for (const snap of created) await reinsertSectionRequest(snap);
          for (const slide of createdSlides) await reinsertSlide(slide);
          if (afterBlock) await restoreSample(afterBlock);
          invalidate();
        },
      });
      return ids.length;
    },
    [invalidate, record],
  );

  // Apply one sectioning plan to several embedded blocks at once (issue #8),
  // recorded as a single undo entry.
  const sendSectionsToCuttingForSamples = useCallback(
    async (
      sampleIds: number[],
      groups: Array<{ depth_um: number; duplicates: number; stains?: string }>,
    ) => {
      if (sampleIds.length === 0) return 0;
      if (sampleIds.length === 1) return sendSectionsToCutting(sampleIds[0], groups);
      const beforeBlocks = (await Promise.all(sampleIds.map(getSample))).filter(
        (s): s is Sample => s !== null,
      );
      const allIds: number[] = [];
      for (const sampleId of sampleIds) {
        const ids = await createSectionRequests(sampleId, groups);
        allIds.push(...ids);
      }
      invalidate();
      const afterBlocks = (await Promise.all(sampleIds.map(getSample))).filter(
        (s): s is Sample => s !== null,
      );
      const created = (await Promise.all(allIds.map((id) => getSectionRequest(id)))).filter(
        (r): r is SectionRequest => r !== null,
      );
      const createdSlides = (
        await Promise.all(allIds.map((id) => listSlidesForSectionRequest(id)))
      ).flat();
      record({
        label: `Send ${allIds.length} sections to cutting · ${sampleIds.length} blocks`,
        undo: async () => {
          for (const id of allIds) await deleteSectionRequest(id);
          for (const snapshot of beforeBlocks) await restoreSample(snapshot);
          invalidate();
        },
        redo: async () => {
          for (const snap of created) await reinsertSectionRequest(snap);
          for (const slide of createdSlides) await reinsertSlide(slide);
          for (const snapshot of afterBlocks) await restoreSample(snapshot);
          invalidate();
        },
      });
      return allIds.length;
    },
    [invalidate, record, sendSectionsToCutting],
  );

  const moveSection = useCallback(
    async (sectionId: number, stageKey: string) => {
      const before = await getSectionRequest(sectionId);
      if (!before) return;
      const beforeSlides = await listSlidesForSectionRequest(sectionId);
      const targetOrder = SECTION_STAGE_ORDER[stageKey] ?? 0;
      const currentOrder = SECTION_STAGE_ORDER[before.current_stage] ?? 0;
      if (
        stageKey === "pictures_taken" &&
        currentOrder < (SECTION_STAGE_ORDER.stained ?? Number.MAX_SAFE_INTEGER)
      ) {
        throw new Error("Complete staining before moving slides to pictures or analysis.");
      }
      if (targetOrder < currentOrder) {
        await revertSectionToStage(sectionId, stageKey);
      } else {
        await updateSectionStage(sectionId, stageKey);
      }
      invalidate();
      const after = await getSectionRequest(sectionId);
      if (after) {
        const afterSlides = await listSlidesForSectionRequest(sectionId);
        recordRestoreSection(
          `Move section → ${SECTION_STAGE_LABELS[stageKey] ?? stageKey}`,
          before,
          after,
          beforeSlides,
          afterSlides,
        );
      }
    },
    [invalidate, recordRestoreSection],
  );

  // Move several sections at once as a SINGLE undo entry (issue #16): a batch
  // move must undo as one action, not one item at a time.
  const moveSections = useCallback(
    async (sectionIds: number[], stageKey: string) => {
      if (sectionIds.length === 0) return;
      if (sectionIds.length === 1) return moveSection(sectionIds[0], stageKey);
      const before = (await Promise.all(sectionIds.map(getSectionRequest))).filter(
        (s): s is SectionRequest => s !== null,
      );
      const beforeSlides = (await Promise.all(before.map((section) =>
        listSlidesForSectionRequest(section.id),
      ))).flat();
      const targetOrder = SECTION_STAGE_ORDER[stageKey] ?? 0;
      if (stageKey === "stain_requested") {
        const incomplete = await Promise.all(before.map(async (section) => {
          const slides = await listSlidesForSectionRequest(section.id);
          return slides.some((slide) => slide.assignment_saved === 0) ? section.id : null;
        }));
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
      for (const section of before) {
        const currentOrder = SECTION_STAGE_ORDER[section.current_stage] ?? 0;
        if (targetOrder < currentOrder) await revertSectionToStage(section.id, stageKey);
        else await updateSectionStage(section.id, stageKey);
      }
      invalidate();
      const after = (await Promise.all(sectionIds.map(getSectionRequest))).filter(
        (s): s is SectionRequest => s !== null,
      );
      const afterSlides = (await Promise.all(after.map((section) =>
        listSlidesForSectionRequest(section.id),
      ))).flat();
      record({
        label: `Move ${before.length} sections → ${SECTION_STAGE_LABELS[stageKey] ?? stageKey}`,
        undo: async () => {
          for (const snapshot of before) await restoreSectionRequest(snapshot);
          for (const slide of beforeSlides) await restoreSlide(slide);
          invalidate();
        },
        redo: async () => {
          for (const snapshot of after) await restoreSectionRequest(snapshot);
          for (const slide of afterSlides) await restoreSlide(slide);
          invalidate();
        },
      });
    },
    [invalidate, moveSection, record],
  );

  const editSectionTimestamp = useCallback(
    async (sectionId: number, column: string, value: string | null) => {
      const before = await getSectionRequest(sectionId);
      if (!before) return;
      const beforeSlides = await listSlidesForSectionRequest(sectionId);
      await setSectionTimestamp(sectionId, column, value);
      invalidate();
      const after = await getSectionRequest(sectionId);
      if (after) {
        const afterSlides = await listSlidesForSectionRequest(sectionId);
        recordRestoreSection("Edit section time", before, after, beforeSlides, afterSlides);
      }
    },
    [invalidate, recordRestoreSection],
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
      await updateSlideAssignment(slideId, purpose, assayType, assayName);
      // Fulfilling a requested stain auto-acknowledges the matching request.
      if (purpose === "stain") await acknowledgeRequestsForSlide(slideId);
      invalidate();
      const after = await getSlide(slideId);
      if (!after) return;
      record({
        label: `Assign ${before.slide_code}`,
        undo: async () => {
          await updateSlideAssignment(
            before.id,
            before.purpose,
            before.assay_type || (before.stain_name ? "stain" : ""),
            before.assay_name || before.stain_name,
          );
          invalidate();
        },
        redo: async () => {
          await updateSlideAssignment(after.id, after.purpose, after.assay_type, after.assay_name);
          invalidate();
        },
      });
    },
    [invalidate, record],
  );

  // Assign an extra slide from inventory to stain/IHC work. Undo reverses the
  // slide move plus any section create/delete the merge performed (issue #10).
  const assignExtraSlide = useCallback(
    async (input: { slideId: number; assayType: "stain" | "ihc"; assayName: string }) => {
      const slideBefore = await getSlide(input.slideId);
      if (!slideBefore) return;
      const formerSectionBefore = await getSectionRequest(slideBefore.section_request_id);
      const stackBefore = formerSectionBefore
        ? await getOpenSlideStack(
            formerSectionBefore.sample_id,
            formerSectionBefore.depth_um,
            "stain_requested",
          )
        : null;
      const result = await assignExtraSlideToAssay(input);
      // Fulfilling a requested stain auto-acknowledges the matching request.
      await acknowledgeRequestsForSlide(input.slideId);
      invalidate();
      const slideAfter = await getSlide(input.slideId);
      const stackAfter = await getSlideStack(result.stackId);
      record({
        label: `Assign ${slideBefore.slide_code}`,
        undo: async () => {
          await restoreSlide(slideBefore);
          if (result.createdStackId != null) await deleteSlideStackIfEmpty(result.createdStackId);
          else if (stackBefore) await restoreSlideStack(stackBefore);
          invalidate();
        },
        redo: async () => {
          if (result.createdStackId != null && stackAfter) await reinsertSlideStack(stackAfter);
          if (slideAfter) await restoreSlide(slideAfter);
          if (stackAfter) await restoreSlideStack(stackAfter);
          invalidate();
        },
      });
    },
    [invalidate, record],
  );

  const setSlidePicturesTaken = useCallback(
    async (slideId: number, complete: boolean) => {
      const before = await getSlide(slideId);
      if (!before) return;
      await setSlidePicturesTakenDb(slideId, complete);
      invalidate();
      const after = await getSlide(slideId);
      if (!after) return;
      record({
        label: `${complete ? "Image" : "Reopen imaging for"} ${before.slide_code}`,
        undo: async () => {
          await setSlidePicturesTakenDb(before.id, Boolean(before.stage_pictures_taken_at));
          invalidate();
        },
        redo: async () => {
          await setSlidePicturesTakenDb(after.id, Boolean(after.stage_pictures_taken_at));
          invalidate();
        },
      });
    },
    [invalidate, record],
  );

  const completeSectionImaging = useCallback(
    async (sectionIds: number[]) => {
      const before = (await Promise.all(sectionIds.map(getSectionRequest))).filter(
        (section): section is SectionRequest => section !== null,
      );
      const beforeSlides = (await Promise.all(sectionIds.map(listSlidesForSectionRequest))).flat();
      await Promise.all(sectionIds.map((id) => completeSectionImagingDb(id)));
      invalidate();
      const after = (await Promise.all(sectionIds.map(getSectionRequest))).filter(
        (section): section is SectionRequest => section !== null,
      );
      const afterSlides = (await Promise.all(sectionIds.map(listSlidesForSectionRequest))).flat();
      record({
        label: `Complete imaging (${sectionIds.length})`,
        undo: async () => {
          for (const section of before) await restoreSectionRequest(section);
          for (const slide of beforeSlides) await restoreSlide(slide);
          invalidate();
        },
        redo: async () => {
          for (const section of after) await restoreSectionRequest(section);
          for (const slide of afterSlides) await restoreSlide(slide);
          invalidate();
        },
      });
    },
    [invalidate, record],
  );

  const replaceSlideStackSet = useCallback(
    async (
      affectedIds: number[],
      stacks: SlideStack[],
      slides: Slide[],
      checklistRuns: Awaited<ReturnType<typeof listChecklistRunsForScope>>,
    ) => {
      for (const id of affectedIds) {
        if (await getSlideStack(id)) {
          await deleteSlidesForStack(id);
          await deleteSlideStack(id);
        }
      }
      for (const stack of stacks) await reinsertSlideStack(stack);
      for (const slide of slides) await reinsertSlide(slide);
      await reinsertChecklistRuns(checklistRuns);
    },
    [],
  );

  const moveSlideStacks = useCallback(
    async (stackIds: number[], stageKey: string) => {
      const sources = (await Promise.all(stackIds.map(getSlideStack))).filter(
        (stack): stack is SlideStack => stack !== null,
      );
      const targetOrder = SECTION_STAGE_ORDER[stageKey];
      if (targetOrder === undefined) throw new Error(`Unknown slide-stack stage: ${stageKey}`);
      for (const stack of sources) {
        if (targetOrder <= (SECTION_STAGE_ORDER[stack.current_stage] ?? -1)) {
          throw new Error("Slide stacks can only move forward through the workflow.");
        }
      }

      const mergeTargets = (await Promise.all(sources.map((stack) =>
        stageKey === "analyzed"
          ? Promise.resolve(null)
          : getOpenSlideStack(stack.sample_id, stack.depth_um, stageKey, stack.id),
      ))).filter((stack): stack is SlideStack => stack !== null);
      const before = [...new Map([...sources, ...mergeTargets].map((stack) => [stack.id, stack])).values()];
      const beforeSlides = (await Promise.all(before.map((stack) => listSlidesForStack(stack.id)))).flat();
      const beforeChecklists = (await Promise.all(
        before.map((stack) => listChecklistRunsForScope("slide_stack", stack.id)),
      )).flat();

      const resultIds: number[] = [];
      for (const stack of sources) resultIds.push(await updateSlideStackStage(stack.id, stageKey));
      const after = (await Promise.all([...new Set(resultIds)].map(getSlideStack))).filter(
        (stack): stack is SlideStack => stack !== null,
      );
      const afterSlides = (await Promise.all(after.map((stack) => listSlidesForStack(stack.id)))).flat();
      const afterChecklists = (await Promise.all(
        after.map((stack) => listChecklistRunsForScope("slide_stack", stack.id)),
      )).flat();
      const affectedIds = [...new Set([...before.map((stack) => stack.id), ...after.map((stack) => stack.id)])];

      invalidate();
      record({
        label: `Move ${sources.length} slide stack${sources.length === 1 ? "" : "s"} → ${SECTION_STAGE_LABELS[stageKey] ?? stageKey}`,
        undo: async () => {
          await replaceSlideStackSet(affectedIds, before, beforeSlides, beforeChecklists);
          invalidate();
        },
        redo: async () => {
          await replaceSlideStackSet(affectedIds, after, afterSlides, afterChecklists);
          invalidate();
        },
      });
    },
    [invalidate, record, replaceSlideStackSet],
  );

  const completeSlideStacksImaging = useCallback(
    (stackIds: number[]) => moveSlideStacks(stackIds, "pictures_taken"),
    [moveSlideStacks],
  );

  const removeSlideStacks = useCallback(
    async (stackIds: number[]) => {
      const stacks = (await Promise.all(stackIds.map(getSlideStack))).filter(
        (stack): stack is SlideStack => stack !== null,
      );
      if (stacks.length === 0) return;
      const slides = (await Promise.all(stacks.map((stack) => listSlidesForStack(stack.id)))).flat();
      const checklistRuns = (await Promise.all(
        stacks.map((stack) => listChecklistRunsForScope("slide_stack", stack.id)),
      )).flat();
      for (const stack of stacks) {
        await deleteSlidesForStack(stack.id);
        await deleteSlideStack(stack.id);
      }
      invalidate();
      record({
        label: `Delete ${stacks.length} slide stack${stacks.length === 1 ? "" : "s"}`,
        undo: async () => {
          for (const stack of stacks) await reinsertSlideStack(stack);
          for (const slide of slides) await reinsertSlide(slide);
          await reinsertChecklistRuns(checklistRuns);
          invalidate();
        },
        redo: async () => {
          for (const stack of stacks) {
            await deleteSlidesForStack(stack.id);
            await deleteSlideStack(stack.id);
          }
          invalidate();
        },
      });
    },
    [invalidate, record],
  );

  const removeSlides = useCallback(
    async (slideIds: number[]) => {
      const slides = (await Promise.all(slideIds.map(getSlide))).filter(
        (slide): slide is Slide => slide !== null,
      );
      if (slides.length === 0) return;
      const stackIds = [...new Set(slides.map((slide) => slide.stack_id).filter((id): id is number => id !== null))];
      const stackSnapshots = (await Promise.all(stackIds.map(getSlideStack))).filter(
        (stack): stack is SlideStack => stack !== null,
      );
      const checklistRuns = new Map<number, Awaited<ReturnType<typeof listChecklistRunsForScope>>>();
      for (const stack of stackSnapshots) {
        checklistRuns.set(stack.id, await listChecklistRunsForScope("slide_stack", stack.id));
      }
      for (const slide of slides) await deleteSlide(slide.id);
      const deletedStacks: SlideStack[] = [];
      for (const stack of stackSnapshots) {
        if (await deleteSlideStackIfEmpty(stack.id)) deletedStacks.push(stack);
      }
      invalidate();
      record({
        label: `Delete ${slides.length} slide${slides.length === 1 ? "" : "s"}`,
        undo: async () => {
          for (const stack of deletedStacks) await reinsertSlideStack(stack);
          for (const slide of slides) await reinsertSlide(slide);
          for (const stack of deletedStacks) {
            await reinsertChecklistRuns(checklistRuns.get(stack.id) ?? []);
          }
          for (const stack of stackSnapshots) await restoreSlideStack(stack);
          invalidate();
        },
        redo: async () => {
          for (const slide of slides) await deleteSlide(slide.id);
          for (const stack of deletedStacks) await deleteSlideStackIfEmpty(stack.id);
          invalidate();
        },
      });
    },
    [invalidate, record],
  );

  const removeSections = useCallback(
    async (sectionIds: number[]) => {
      const before = (await Promise.all(sectionIds.map(getSectionRequest))).filter(
        (section): section is SectionRequest => section !== null,
      );
      if (before.length === 0) return;
      const slides = (await Promise.all(before.map((section) => listSlidesForSectionRequest(section.id)))).flat();
      const stackIds = [...new Set(slides.map((slide) => slide.stack_id).filter((id): id is number => id !== null))];
      const stackSnapshots = (await Promise.all(stackIds.map(getSlideStack))).filter(
        (stack): stack is SlideStack => stack !== null,
      );
      const checklistRuns = new Map<number, Awaited<ReturnType<typeof listChecklistRunsForScope>>>();
      for (const stack of stackSnapshots) {
        checklistRuns.set(stack.id, await listChecklistRunsForScope("slide_stack", stack.id));
      }
      for (const section of before) await deleteSectionRequest(section.id);
      const stacks: SlideStack[] = [];
      for (const stack of stackSnapshots) {
        if (await deleteSlideStackIfEmpty(stack.id)) stacks.push(stack);
      }
      invalidate();
      record({
        label: before.length === 1 ? "Delete section" : `Delete ${before.length} cut groups`,
        undo: async () => {
          for (const section of before) await reinsertSectionRequest(section);
          for (const stack of stacks) await reinsertSlideStack(stack);
          for (const slide of slides) await reinsertSlide(slide);
          for (const stack of stacks) {
            await reinsertChecklistRuns(checklistRuns.get(stack.id) ?? []);
          }
          for (const stack of stackSnapshots) await restoreSlideStack(stack);
          invalidate();
        },
        redo: async () => {
          for (const section of before) await deleteSectionRequest(section.id);
          for (const stack of stackSnapshots) {
            if (stacks.some((deleted) => deleted.id === stack.id)) await deleteSlideStack(stack.id);
          }
          invalidate();
        },
      });
    },
    [invalidate, record],
  );

  const removeSection = useCallback(
    (sectionId: number) => removeSections([sectionId]),
    [removeSections],
  );

  const setExhausted = useCallback(
    async (sampleId: number, exhausted: boolean) => {
      const before = await getSample(sampleId);
      if (!before) return;
      await setBlockExhausted(sampleId, exhausted);
      invalidate();
      const after = await getSample(sampleId);
      if (after) {
        recordRestore(
          exhausted ? `Exhaust ${before.sample_code}` : `Restore ${before.sample_code}`,
          before,
          after,
        );
      }
    },
    [invalidate, recordRestore],
  );

  const setExhaustedSamples = useCallback(
    async (sampleIds: number[], exhausted: boolean) => {
      const before = (await Promise.all(sampleIds.map(getSample))).filter(
        (item): item is Sample => item !== null,
      );
      for (const item of before) await setBlockExhausted(item.id, exhausted);
      invalidate();
      const after = (await Promise.all(sampleIds.map(getSample))).filter(
        (item): item is Sample => item !== null,
      );
      record({
        label: `${exhausted ? "Exhaust" : "Restore"} ${before.length} samples`,
        undo: async () => {
          for (const snapshot of before) await restoreSample(snapshot);
          invalidate();
        },
        redo: async () => {
          for (const snapshot of after) await restoreSample(snapshot);
          invalidate();
        },
      });
    },
    [invalidate, record],
  );

  const togglePriority = useCallback(
    async (sampleId: number) => {
      const before = await getSample(sampleId);
      if (!before) return;
      await setSamplePriority(sampleId, before.is_priority !== 1);
      invalidate();
      const after = await getSample(sampleId);
      if (after) {
        recordRestore(
          after.is_priority === 1 ? `Prioritize ${before.sample_code}` : `Remove priority from ${before.sample_code}`,
          before,
          after,
        );
      }
    },
    [invalidate, recordRestore],
  );

  const undo = useCallback(async (): Promise<string | null> => {
    const cmd = popUndo();
    if (!cmd) return null;
    await cmd.undo();
    await recordAuditEvent("undo", "undo_command", `Undid: ${cmd.label}`, cmd.label);
    return cmd.label;
  }, [popUndo]);

  const redo = useCallback(async (): Promise<string | null> => {
    const cmd = popRedo();
    if (!cmd) return null;
    await cmd.redo();
    await recordAuditEvent("redo", "undo_command", `Redid: ${cmd.label}`, cmd.label);
    return cmd.label;
  }, [popRedo]);

  return {
    moveSample,
    moveSamples,
    startProcessingBatch,
    moveProcessingBatch,
    editBatchStart,
    editTimestamp,
    saveDetails,
    saveSectioningPlan,
    removeSample,
    removeSamples,
    createSample,
    createSamples,
    markAnalyzed: (sampleId: number) => moveSample(sampleId, "analyzed"),
    sendSectionsToCutting,
    sendSectionsToCuttingForSamples,
    moveSection,
    moveSections,
    assignSlide,
    assignExtraSlide,
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
