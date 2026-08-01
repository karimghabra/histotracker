import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { compareSampleCodes, compareSlideCodes } from "../lib/utils";
import type { ProcessingBatch, Sample, SectionRequest, Slide, SlideStack } from "../lib/types";
import {
  BLOCK_QUEUE_KEYS,
  BOARD_LANES,
  LANE_COLORS,
  QUEUE_BY_KEY,
  SECTION_QUEUE_ENTRY,
  SECTION_QUEUE_KEYS,
  SECTION_STAGE_ORDER,
  SECTION_STAGE_TO_QUEUE,
  STAGE_ORDER,
  STAGE_TO_QUEUE,
} from "../lib/stages";
import { ProcessingBatchRow } from "./ProcessingBatchRow";
import { QueueColumn } from "./QueueColumn";
import { SampleCard } from "./SampleCard";
import { SectionCard } from "./SectionCard";
import { StackCard } from "./StackCard";
import { ExtraSlideInventory, groupExtraSlides } from "./ExtraSlideInventory";

type EmbeddedSort = "embedded_date" | "name" | "sample_id";
type ExtraSlidesSort = "sample_id" | "name";

/** Shared empty list so an absent queue keeps a stable identity across renders. */
const NO_STACKS: SlideStack[] = [];
type ActiveDrag =
  | { type: "block"; sample: Sample; count?: number }
  | { type: "section"; section: SectionRequest; count?: number }
  | { type: "stack"; stack: SlideStack; count?: number }
  | { type: "batch"; batch: ProcessingBatch }
  | null;

function sortEmbedded(samples: Sample[], key: EmbeddedSort): Sample[] {
  const copy = [...samples];
  copy.sort((a, b) => {
    if (a.is_priority !== b.is_priority) return b.is_priority - a.is_priority;
    switch (key) {
      case "name":
        return (a.sample_description || a.sample_code).localeCompare(
          b.sample_description || b.sample_code,
        );
      case "sample_id":
        return (
          (a.project_code ?? "").localeCompare(b.project_code ?? "") ||
          (a.project_sample_number ?? 0) - (b.project_sample_number ?? 0)
        );
      case "embedded_date":
      default:
        return (a.stage_embedded_at ?? "").localeCompare(b.stage_embedded_at ?? "");
    }
  });
  return copy;
}

function sortExtraSlides(slides: Slide[], key: ExtraSlidesSort): Slide[] {
  const copy = [...slides];
  copy.sort((a, b) => {
    if ((a.is_priority ?? 0) !== (b.is_priority ?? 0)) return (b.is_priority ?? 0) - (a.is_priority ?? 0);
    switch (key) {
      case "name":
        return (a.sample_description || a.parent_code || a.slide_code).localeCompare(
          b.sample_description || b.parent_code || b.slide_code,
        );
      case "sample_id":
      default:
        // Numeric-aware on the sample code, and slide-letter-aware on the code
        // itself — plain localeCompare mis-orders both once sample codes stop
        // being fixed-width (#87) and at the A..Z→AA wrap (#75).
        return (
          (a.project_code ?? "").localeCompare(b.project_code ?? "") ||
          compareSampleCodes(a.parent_code ?? "", b.parent_code ?? "") ||
          compareSlideCodes(a.slide_code, b.slide_code)
        );
    }
  });
  return copy;
}

function rangeSelection(order: number[], anchor: number | null, target: number): number[] {
  if (anchor === null) return [target];
  const start = order.indexOf(anchor);
  const end = order.indexOf(target);
  if (start < 0 || end < 0) return [target];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

export function Board({
  samples,
  sections,
  stacks,
  batches,
  extraSlides,
  selectedSampleId,
  selectedSectionId,
  selectedStackId,
  onSelectSample,
  onSampleSelectionChange,
  onSelectSection,
  onSectionSelectionChange,
  onSelectStack,
  onStackSelectionChange,
  onSelectExtraSlideSample,
  onCloseDrawers,
  onMoveSamples,
  onMoveSections,
  onMoveStacks,
  onRequestProcessingBatch,
  onMoveProcessingBatch,
  onSelectProcessingBatch,
  onConfirmProcessingBatchStart,
  onToggleSamplePriority,
  readOnly = false,
}: {
  samples: Sample[];
  sections: SectionRequest[];
  stacks: SlideStack[];
  batches: ProcessingBatch[];
  extraSlides: Slide[];
  selectedSampleId: number | null;
  selectedSectionId: number | null;
  selectedStackId: number | null;
  onSelectSample: (id: number) => void;
  onSampleSelectionChange: (ids: number[]) => void;
  onSelectSection: (id: number) => void;
  onSectionSelectionChange: (ids: number[]) => void;
  onSelectStack: (id: number) => void;
  onStackSelectionChange: (ids: number[]) => void;
  onSelectExtraSlideSample: (sampleId: number) => void;
  /** Clear the open detail drawer (used when a tile is de-selected, #61). */
  onCloseDrawers: () => void;
  onMoveSamples: (sampleIds: number[], stageKey: string) => void;
  onMoveSections: (sectionIds: number[], stageKey: string) => void;
  onMoveStacks: (stackIds: number[], stageKey: string) => void;
  onRequestProcessingBatch: (sampleIds: number[]) => void;
  onMoveProcessingBatch: (batchId: number, stageKey: string) => void;
  onSelectProcessingBatch: (batchId: number) => void;
  onConfirmProcessingBatchStart: (batchId: number) => void;
  onToggleSamplePriority: (sampleId: number) => void;
  /** Viewer role: disable drag-to-move and the priority toggle. */
  readOnly?: boolean;
}) {
  const [active, setActive] = useState<ActiveDrag>(null);
  const [selectedBlocks, setSelectedBlocks] = useState<Set<number>>(new Set());
  const [selectedSections, setSelectedSections] = useState<Set<number>>(new Set());
  const [selectedStacks, setSelectedStacks] = useState<Set<number>>(new Set());
  // Selection highlight for the non-card items (issues #15, #17): only one of
  // block / section / batch / extras-stack is highlighted at a time.
  const [selectedBatch, setSelectedBatch] = useState<number | null>(null);
  const [selectedExtraSample, setSelectedExtraSample] = useState<number | null>(null);
  const blockAnchor = useRef<number | null>(null);
  const sectionGroupAnchor = useRef<number | null>(null);
  const stackAnchor = useRef<number | null>(null);
  const [embeddedFilter, setEmbeddedFilter] = useState<number | "all">("all");
  const [embeddedSort, setEmbeddedSort] = useState<EmbeddedSort>("embedded_date");
  const [extraSlidesFilter, setExtraSlidesFilter] = useState<string>("all");
  const [extraSlidesSort, setExtraSlidesSort] = useState<ExtraSlidesSort>("sample_id");
  // Ready for Imaging fills up fast, so it gets its own project + stain filters (#82).
  const [imagingProjectFilter, setImagingProjectFilter] = useState<string>("all");
  const [imagingStainFilter, setImagingStainFilter] = useState<string>("all");
  const [topLaneHeight, setTopLaneHeight] = useState(
    () => Number(window.localStorage.getItem("histometer-board-top-height") ?? "50"),
  );
  const boardRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    const clear = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSelectedBlocks(new Set());
      setSelectedSections(new Set());
      setSelectedStacks(new Set());
      setSelectedBatch(null);
      setSelectedExtraSample(null);
    };
    window.addEventListener("keydown", clear);
    return () => window.removeEventListener("keydown", clear);
  }, []);

  // Selecting any block or section clears the batch / extras-stack highlight so
  // only one thing is ever highlighted (issues #15, #17).
  useEffect(() => {
    if (selectedBlocks.size > 0 || selectedSections.size > 0 || selectedStacks.size > 0) {
      setSelectedBatch(null);
      setSelectedExtraSample(null);
    }
  }, [selectedBlocks, selectedSections, selectedStacks]);

  useEffect(() => {
    onSampleSelectionChange([...selectedBlocks]);
  }, [onSampleSelectionChange, selectedBlocks]);

  useEffect(() => {
    onSectionSelectionChange([...selectedSections]);
  }, [onSectionSelectionChange, selectedSections]);

  useEffect(() => {
    onStackSelectionChange([...selectedStacks]);
  }, [onStackSelectionChange, selectedStacks]);

  useEffect(() => {
    window.localStorage.setItem("histometer-board-top-height", String(topLaneHeight));
  }, [topLaneHeight]);

  const batchMemberIds = useMemo(
    () => new Set(batches.flatMap((batch) => batch.member_ids)),
    [batches],
  );
  const visibleBlockOrder = useMemo(
    () => samples.filter((sample) => !batchMemberIds.has(sample.id)).map((sample) => sample.id),
    [batchMemberIds, samples],
  );
  const visibleStackOrder = useMemo(() => stacks.map((stack) => stack.id), [stacks]);

  const blocksByQueue = useMemo(() => {
    const map: Record<string, Sample[]> = {};
    for (const sample of samples) {
      if (batchMemberIds.has(sample.id)) continue;
      const key = STAGE_TO_QUEUE[sample.current_stage];
      if (key && BLOCK_QUEUE_KEYS.has(key)) (map[key] ??= []).push(sample);
    }
    return map;
  }, [batchMemberIds, samples]);

  const batchesByQueue = useMemo(() => {
    const map: Record<string, ProcessingBatch[]> = {};
    for (const batch of batches) {
      const key = STAGE_TO_QUEUE[batch.current_stage];
      if (key) (map[key] ??= []).push(batch);
    }
    return map;
  }, [batches]);

  const sectionsByQueue = useMemo(() => {
    const map: Record<string, SectionRequest[]> = {};
    for (const section of sections) {
      const key = SECTION_STAGE_TO_QUEUE[section.current_stage];
      if (key) (map[key] ??= []).push(section);
    }
    return map;
  }, [sections]);

  const stacksByQueue = useMemo(() => {
    const map: Record<string, SlideStack[]> = {};
    for (const stack of stacks) {
      const key = SECTION_STAGE_TO_QUEUE[stack.current_stage];
      if (key) (map[key] ??= []).push(stack);
    }
    return map;
  }, [stacks]);

  // Needs Sectioning shows ONE card per sample (issue #33): all of a sample's
  // not-yet-sectioned cut groups aggregate into a single card that marks
  // sectioned as a unit.
  const needsSectioningGroups = useMemo(() => {
    const bySample = new Map<number, SectionRequest[]>();
    for (const section of sectionsByQueue.needs_sectioning ?? []) {
      const arr = bySample.get(section.sample_id) ?? [];
      arr.push(section);
      bySample.set(section.sample_id, arr);
    }
    return [...bySample.values()];
  }, [sectionsByQueue]);
  const sectionGroupOrder = useMemo(
    () => needsSectioningGroups.map((group) => group[0].id),
    [needsSectioningGroups],
  );

  const projectsInEmbedded = useMemo(() => {
    const seen = new Map<number, string>();
    for (const sample of blocksByQueue.embedded_inventory ?? []) {
      if (sample.project_code) seen.set(sample.project_id, sample.project_code);
    }
    return [...seen.entries()];
  }, [blocksByQueue]);

  const displayedEmbeddedItems = useMemo(() => {
    let items = blocksByQueue.embedded_inventory ?? [];
    if (embeddedFilter !== "all") {
      items = items.filter((sample) => sample.project_id === embeddedFilter);
    }
    return sortEmbedded(items, embeddedSort);
  }, [blocksByQueue, embeddedFilter, embeddedSort]);

  // ---- Ready for Imaging filters (#82) ----
  const agentsOf = (stack: SlideStack): string[] =>
    (stack.agent_names ?? "").split(",").map((a) => a.trim()).filter(Boolean);

  // Stable identity when the queue is empty, so the memos and effects below
  // don't re-run on every render just because `?? []` minted a new array.
  const imagingStacks = stacksByQueue.analysis_pending ?? NO_STACKS;
  const projectsInImaging = useMemo(
    () => [...new Set(imagingStacks.map((s) => s.project_code).filter(Boolean) as string[])].sort(),
    [imagingStacks],
  );
  const stainsInImaging = useMemo(
    () => [...new Set(imagingStacks.flatMap(agentsOf))].sort((a, b) => a.localeCompare(b)),
    [imagingStacks],
  );
  const displayedImagingStacks = useMemo(() => {
    let items = imagingStacks;
    if (imagingProjectFilter !== "all") {
      items = items.filter((stack) => stack.project_code === imagingProjectFilter);
    }
    if (imagingStainFilter !== "all") {
      items = items.filter((stack) =>
        agentsOf(stack).some((a) => a.toLowerCase() === imagingStainFilter.toLowerCase()),
      );
    }
    return items;
  }, [imagingStacks, imagingProjectFilter, imagingStainFilter]);

  // #85 — a controlled <select> whose value is no longer among its options does
  // NOT go blank: react-dom's updateOptions re-selects the FIRST option and
  // fires no change event. So when the last stack of the filtered project is
  // marked Analyzed, its <option> disappears, the control starts reading
  // "All Projects", but this state still says "EE" — and the queue quietly
  // filters itself down to nothing while other projects' stacks sit there
  // unshown. Drop the filter for real once its value is off the menu, so the
  // control and the list agree.
  useEffect(() => {
    if (imagingProjectFilter !== "all" && !projectsInImaging.includes(imagingProjectFilter)) {
      setImagingProjectFilter("all");
    }
  }, [imagingProjectFilter, projectsInImaging]);

  useEffect(() => {
    if (imagingStainFilter !== "all" && !stainsInImaging.includes(imagingStainFilter)) {
      setImagingStainFilter("all");
    }
  }, [imagingStainFilter, stainsInImaging]);

  const projectsInExtraSlides = useMemo(() => {
    return [...new Set(extraSlides.map((slide) => slide.project_code).filter(Boolean) as string[])];
  }, [extraSlides]);

  const displayedExtraSlides = useMemo(() => {
    let items = extraSlides;
    if (extraSlidesFilter !== "all") {
      items = items.filter((slide) => slide.project_code === extraSlidesFilter);
    }
    return sortExtraSlides(items, extraSlidesSort);
  }, [extraSlides, extraSlidesFilter, extraSlidesSort]);
  const displayedExtraSlideGroups = useMemo(
    () => groupExtraSlides(displayedExtraSlides),
    [displayedExtraSlides],
  );

  function startBoardResize() {
    const onMove = (event: globalThis.MouseEvent) => {
      if (!boardRef.current) return;
      const rect = boardRef.current.getBoundingClientRect();
      const next = ((event.clientY - rect.top) / rect.height) * 100;
      setTopLaneHeight(Math.min(78, Math.max(22, next)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Clicking a processing batch (#17) or an extras stack (#15) highlights that
  // item and clears every other selection.
  function handleSelectBatch(id: number) {
    setSelectedBlocks(new Set());
    setSelectedSections(new Set());
    setSelectedStacks(new Set());
    setSelectedExtraSample(null);
    setSelectedBatch(id);
    onSelectProcessingBatch(id);
  }

  function handleSelectExtraSample(id: number) {
    setSelectedBlocks(new Set());
    setSelectedSections(new Set());
    setSelectedStacks(new Set());
    setSelectedBatch(null);
    setSelectedExtraSample(id);
    onSelectExtraSlideSample(id);
  }

  function selectBlock(id: number, event: MouseEvent<HTMLDivElement>) {
    setSelectedSections(new Set());
    setSelectedStacks(new Set());
    const targetQueue = STAGE_TO_QUEUE[samples.find((sample) => sample.id === id)?.current_stage ?? ""];
    const queueOrder = targetQueue === "embedded_inventory"
      ? displayedEmbeddedItems.map((sample) => sample.id)
      : visibleBlockOrder.filter((sampleId) => {
          const candidate = samples.find((sample) => sample.id === sampleId);
          return candidate && STAGE_TO_QUEUE[candidate.current_stage] === targetQueue;
        });
    if (event.shiftKey) {
      setSelectedBlocks(new Set(rangeSelection(queueOrder, blockAnchor.current, id)));
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedBlocks((current) => {
        const sameQueue = [...current].every((sampleId) => queueOrder.includes(sampleId));
        const next = sameQueue ? new Set(current) : new Set<number>();
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      blockAnchor.current = id;
    } else {
      // Plain click on the already-open tile → de-select and close the panel,
      // rather than re-opening it (#61).
      if (selectedSampleId === id && selectedBlocks.size === 1 && selectedBlocks.has(id)) {
        setSelectedBlocks(new Set());
        onCloseDrawers();
        return;
      }
      setSelectedBlocks(new Set([id]));
      blockAnchor.current = id;
    }
    onSelectSample(id);
  }

  function toggleBlock(id: number) {
    setSelectedSections(new Set());
    setSelectedStacks(new Set());
    const target = samples.find((sample) => sample.id === id);
    if (!target) return;
    const targetQueue = STAGE_TO_QUEUE[target.current_stage];
    const wasSelected = selectedBlocks.has(id);
    setSelectedBlocks((current) => {
      const sameQueue = [...current].every((sampleId) => {
        const sample = samples.find((candidate) => candidate.id === sampleId);
        return sample && STAGE_TO_QUEUE[sample.current_stage] === targetQueue;
      });
      const next = sameQueue ? new Set(current) : new Set<number>();
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    blockAnchor.current = id;
    // Ticking a box opens the panel; un-ticking the open tile closes it (#61).
    if (wasSelected) {
      if (selectedSampleId === id) onCloseDrawers();
    } else {
      onSelectSample(id);
    }
  }

  // Select a whole sample's Needs Sectioning group (issue #37): plain click
  // replaces, ctrl toggles the group, shift ranges across sample groups.
  function selectSectionGroup(group: SectionRequest[], event: MouseEvent<HTMLDivElement>) {
    setSelectedBlocks(new Set());
    setSelectedStacks(new Set());
    const ids = group.map((section) => section.id);
    const repId = group[0].id;
    if (event.shiftKey) {
      const range = rangeSelection(sectionGroupOrder, sectionGroupAnchor.current, repId);
      const rangeIds = range.flatMap(
        (rep) => needsSectioningGroups.find((g) => g[0].id === rep)?.map((section) => section.id) ?? [],
      );
      setSelectedSections(new Set(rangeIds));
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedSections((current) => {
        const next = new Set(current);
        const allSelected = ids.every((id) => next.has(id));
        for (const id of ids) {
          if (allSelected) next.delete(id);
          else next.add(id);
        }
        return next;
      });
      sectionGroupAnchor.current = repId;
    } else {
      // Re-click on the open group → de-select + close the panel (#61).
      if (selectedSectionId != null && ids.includes(selectedSectionId) &&
          selectedSections.size === ids.length && ids.every((id) => selectedSections.has(id))) {
        setSelectedSections(new Set());
        onCloseDrawers();
        return;
      }
      setSelectedSections(new Set(ids));
      sectionGroupAnchor.current = repId;
    }
    onSelectSection(repId);
  }

  // Checkbox toggle for a Needs Sectioning card (issue #37): add/remove the
  // sample's whole group from the multi-selection without replacing it, so
  // ticking several cards accumulates a selection (no Ctrl needed).
  function toggleSectionGroup(ids: number[]) {
    setSelectedBlocks(new Set());
    setSelectedStacks(new Set());
    const wasSelected = ids.every((id) => selectedSections.has(id));
    setSelectedSections((current) => {
      const next = new Set(current);
      const allSelected = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
    sectionGroupAnchor.current = ids[0] ?? null;
    // Un-ticking the open group closes its panel; ticking opens it (#61).
    if (wasSelected) {
      if (selectedSectionId != null && ids.includes(selectedSectionId)) onCloseDrawers();
    } else if (ids[0] != null) {
      onSelectSection(ids[0]);
    }
  }

  function selectStack(id: number, event: MouseEvent<HTMLDivElement>) {
    setSelectedBlocks(new Set());
    setSelectedSections(new Set());
    if (event.shiftKey) {
      setSelectedStacks(new Set(rangeSelection(visibleStackOrder, stackAnchor.current, id)));
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedStacks((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      stackAnchor.current = id;
    } else {
      // Re-click on the open stack → de-select + close the panel (#61).
      if (selectedStackId === id && selectedStacks.size === 1 && selectedStacks.has(id)) {
        setSelectedStacks(new Set());
        onCloseDrawers();
        return;
      }
      setSelectedStacks(new Set([id]));
      stackAnchor.current = id;
    }
    onSelectStack(id);
  }

  function handleStart(event: DragStartEvent) {
    const data = event.active.data.current as ActiveDrag;
    if (!data) return;
    if (data.type === "block") {
      const ids = selectedBlocks.has(data.sample.id) ? selectedBlocks : new Set([data.sample.id]);
      if (!selectedBlocks.has(data.sample.id)) setSelectedBlocks(ids);
      setActive({ ...data, count: ids.size });
    } else if (data.type === "section") {
      const ids = selectedSections.has(data.section.id)
        ? selectedSections
        : new Set([data.section.id]);
      if (!selectedSections.has(data.section.id)) setSelectedSections(ids);
      setActive({ ...data, count: ids.size });
    } else if (data.type === "stack") {
      const ids = selectedStacks.has(data.stack.id)
        ? selectedStacks
        : new Set([data.stack.id]);
      if (!selectedStacks.has(data.stack.id)) setSelectedStacks(ids);
      setActive({ ...data, count: ids.size });
    } else {
      setActive(data);
    }
  }

  function handleEnd(event: DragEndEvent) {
    setActive(null);
    if (readOnly) return;
    const overId = event.over?.id as string | undefined;
    const data = event.active.data.current as ActiveDrag;
    if (!overId || !data) return;

    if (data.type === "block") {
      if (!BLOCK_QUEUE_KEYS.has(overId)) return;
      const ids = selectedBlocks.has(data.sample.id) ? [...selectedBlocks] : [data.sample.id];
      const selected = samples.filter((sample) => ids.includes(sample.id));
      if (selected.some((sample) => STAGE_TO_QUEUE[sample.current_stage] === "embedded_inventory")) {
        return;
      }
      if (selected.every((sample) => STAGE_TO_QUEUE[sample.current_stage] === overId)) return;
      const targetStage = QUEUE_BY_KEY[overId].entryStage;
      if (selected.some((sample) => (STAGE_ORDER[targetStage] ?? -1) - (STAGE_ORDER[sample.current_stage] ?? -1) !== 1)) {
        return;
      }
      if (overId === "processing") onRequestProcessingBatch(ids);
      else onMoveSamples(ids, QUEUE_BY_KEY[overId].entryStage);
      setSelectedBlocks(new Set());
    } else if (data.type === "batch") {
      // Pickup was folded into the processor window (#18); a batch now advances
      // by dragging it to Needs Embedding (or via its drawer).
      if (overId !== "needs_embedding") return;
      onMoveProcessingBatch(data.batch.id, QUEUE_BY_KEY[overId].entryStage);
    } else if (data.type === "stack") {
      if (!SECTION_QUEUE_KEYS.has(overId)) return;
      const ids = selectedStacks.has(data.stack.id) ? [...selectedStacks] : [data.stack.id];
      const selected = stacks.filter((stack) => ids.includes(stack.id));
      if (selected.every((stack) => SECTION_STAGE_TO_QUEUE[stack.current_stage] === overId)) return;
      const targetStage = SECTION_QUEUE_ENTRY[overId];
      if (selected.some((stack) => (SECTION_STAGE_ORDER[targetStage] ?? -1) - (SECTION_STAGE_ORDER[stack.current_stage] ?? -1) !== 1)) return;
      onMoveStacks(ids, targetStage);
      setSelectedStacks(new Set());
    } else {
      // Section cards live only in Needs Sectioning now. Their single forward
      // move is "mark sectioned" → Staining, which the data layer splits into
      // stain racks + extras inventory (issues #34/#38). Dropping elsewhere is
      // a no-op.
      if (overId !== "staining") return;
      const ids = selectedSections.has(data.section.id)
        ? [...selectedSections]
        : [data.section.id];
      const selected = sections.filter((section) => ids.includes(section.id));
      if (selected.some((section) => SECTION_STAGE_TO_QUEUE[section.current_stage] !== "needs_sectioning")) {
        return;
      }
      onMoveSections(ids, "stain_requested");
      setSelectedSections(new Set());
    }
  }

  const selectClass =
    "w-full rounded-md border border-line bg-white px-1.5 py-1 text-[11px] text-ink outline-none";

  return (
    <DndContext sensors={readOnly ? [] : sensors} onDragStart={handleStart} onDragEnd={handleEnd}>
      <div ref={boardRef} className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        {BOARD_LANES.map((lane, laneIndex) => (
          <Fragment key={lane.title}>
          <div
            className="flex min-h-0 shrink-0 flex-col overflow-hidden"
            style={laneIndex === 0 ? { height: `calc(${topLaneHeight}% - 0.375rem)` } : { flex: 1 }}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <span
                className="h-3.5 w-1 rounded-full"
                style={{ backgroundColor: LANE_COLORS[laneIndex] }}
              />
              <h2 className="text-[13px] font-semibold text-ink">{lane.title}</h2>
              {(selectedBlocks.size > 1 || selectedSections.size > 1 || selectedStacks.size > 1) && (
                <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">
                  {selectedBlocks.size || selectedSections.size || selectedStacks.size} selected
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-x-auto thin-scroll">
              <div
                className="grid h-full min-h-0 gap-2"
                style={{
                  // Top lane's last column (Embedded Inventory) is the wide one.
                  minWidth: laneIndex === 0 ? "930px" : "720px",
                  gridTemplateColumns:
                    laneIndex === 0
                      ? "repeat(3, minmax(0, 1fr)) 1.45fr"
                      : "repeat(4, minmax(0, 1fr))",
                }}
              >
                {lane.queues.map((queueKey) => {
                  const queue = QUEUE_BY_KEY[queueKey];

                  if (SECTION_QUEUE_KEYS.has(queueKey)) {
                    const stackItems = stacksByQueue[queueKey] ?? [];
                    const isDownstream = queueKey === "staining" || queueKey === "analysis_pending";
                    // The former "Assign Slides" column is now the Extras
                    // inventory only (issues #34/#38): pre-assigned slides skip it.
                    const isExtras = queueKey === "slide_assignment";

                    if (isExtras) {
                      return (
                        <QueueColumn
                          key={queueKey}
                          queue={queue}
                          count={displayedExtraSlideGroups.length}
                          headerExtra={
                            <div className="flex gap-1">
                              <select
                                className={selectClass}
                                value={extraSlidesFilter}
                                onChange={(event) => setExtraSlidesFilter(event.target.value)}
                              >
                                <option value="all">All Projects</option>
                                {projectsInExtraSlides.map((code) => (
                                  <option key={code} value={code}>{code}</option>
                                ))}
                              </select>
                              <select
                                className={selectClass}
                                value={extraSlidesSort}
                                onChange={(event) => setExtraSlidesSort(event.target.value as ExtraSlidesSort)}
                              >
                                <option value="sample_id">Sample ID</option>
                                <option value="name">Name</option>
                              </select>
                            </div>
                          }
                        >
                          <ExtraSlideInventory
                            slides={displayedExtraSlides}
                            onSelectSample={handleSelectExtraSample}
                            selectedSampleId={selectedExtraSample}
                          />
                        </QueueColumn>
                      );
                    }

                    // Ready for Imaging renders the FILTERED set (#82); every
                    // other downstream queue renders its stacks unfiltered.
                    const isImaging = queueKey === "analysis_pending";
                    const visibleStacks = isImaging ? displayedImagingStacks : stackItems;
                    const groups = queueKey === "needs_sectioning" ? needsSectioningGroups : [];
                    const groupSelectedCount = groups.filter((group) =>
                      group.every((section) => selectedSections.has(section.id)),
                    ).length;
                    const selectedCount = isDownstream
                      ? visibleStacks.filter((stack) => selectedStacks.has(stack.id)).length
                      : groupSelectedCount;
                    return (
                      <QueueColumn
                        key={queueKey}
                        queue={queue}
                        count={isDownstream ? visibleStacks.length : groups.length}
                        selectedCount={selectedCount}
                        headerExtra={
                          // Keyed off the RAW queue, not the derived option lists:
                          // if the filters vanished the moment the queue emptied,
                          // a stale filter would have no widget left to clear it
                          // (#85).
                          isImaging && imagingStacks.length > 0 ? (
                            <div className="flex gap-1">
                              <select
                                aria-label="Filter imaging by project"
                                className={selectClass}
                                value={imagingProjectFilter}
                                onChange={(event) => setImagingProjectFilter(event.target.value)}
                              >
                                <option value="all">All Projects</option>
                                {projectsInImaging.map((code) => (
                                  <option key={code} value={code}>{code}</option>
                                ))}
                              </select>
                              <select
                                aria-label="Filter imaging by stain"
                                className={selectClass}
                                value={imagingStainFilter}
                                onChange={(event) => setImagingStainFilter(event.target.value)}
                              >
                                <option value="all">All Stains</option>
                                {stainsInImaging.map((name) => (
                                  <option key={name} value={name}>{name}</option>
                                ))}
                              </select>
                            </div>
                          ) : undefined
                        }
                        onToggleAll={
                          isDownstream
                            ? visibleStacks.length > 0
                              ? () => {
                                  setSelectedBlocks(new Set());
                                  setSelectedSections(new Set());
                                  setSelectedStacks(selectedCount === visibleStacks.length ? new Set() : new Set(visibleStacks.map((stack) => stack.id)));
                                }
                              : undefined
                            : groups.length > 0
                              ? () => {
                                  setSelectedBlocks(new Set());
                                  setSelectedStacks(new Set());
                                  setSelectedSections(
                                    groupSelectedCount === groups.length
                                      ? new Set()
                                      : new Set(groups.flatMap((group) => group.map((section) => section.id))),
                                  );
                                }
                              : undefined
                        }
                      >
                        {isDownstream
                          ? visibleStacks.map((stack) => (
                              <StackCard
                                key={stack.id}
                                stack={stack}
                                selected={selectedStacks.has(stack.id)}
                                onSelect={selectStack}
                              />
                            ))
                          : groups.map((group) => (
                              <SectionCard
                                key={group[0].id}
                                section={group[0]}
                                groupedSections={group}
                                selected={group.every((section) => selectedSections.has(section.id))}
                                onSelect={(_, event) => selectSectionGroup(group, event)}
                                onSelectGroup={(_, event) => selectSectionGroup(group, event)}
                                onToggle={toggleSectionGroup}
                              />
                            ))}
                      </QueueColumn>
                    );
                  }

                  let items = blocksByQueue[queueKey] ?? [];
                  const queueBatches = batchesByQueue[queueKey] ?? [];
                  const isEmbedded = queueKey === "embedded_inventory";
                  if (isEmbedded) {
                    items = displayedEmbeddedItems;
                  }
                  const selectedCount = items.filter((item) => selectedBlocks.has(item.id)).length;
                  return (
                    <QueueColumn
                      key={queueKey}
                      queue={queue}
                      count={items.length + queueBatches.length}
                      selectedCount={selectedCount}
                      onToggleAll={
                        items.length > 0
                          ? () => {
                              setSelectedSections(new Set());
                              setSelectedBlocks(
                                selectedCount === items.length
                                  ? new Set()
                                  : new Set(items.map((item) => item.id)),
                              );
                            }
                          : undefined
                      }
                      headerExtra={
                        isEmbedded ? (
                          <div className="flex gap-1">
                            <select
                              className={selectClass}
                              value={String(embeddedFilter)}
                              onChange={(event) =>
                                setEmbeddedFilter(
                                  event.target.value === "all" ? "all" : Number(event.target.value),
                                )
                              }
                            >
                              <option value="all">All Projects</option>
                              {projectsInEmbedded.map(([id, code]) => (
                                <option key={id} value={id}>{code}</option>
                              ))}
                            </select>
                            <select
                              className={selectClass}
                              value={embeddedSort}
                              onChange={(event) => setEmbeddedSort(event.target.value as EmbeddedSort)}
                            >
                              <option value="embedded_date">Date embedded</option>
                              <option value="name">Name</option>
                              <option value="sample_id">Sample ID</option>
                            </select>
                          </div>
                        ) : undefined
                      }
                    >
                      {queueBatches.map((batch) => (
                        <ProcessingBatchRow
                          key={batch.id}
                          batch={batch}
                          selected={selectedBatch === batch.id}
                          onSelect={handleSelectBatch}
                          onConfirmStart={onConfirmProcessingBatchStart}
                        />
                      ))}
                      {items.map((sample) => (
                        <SampleCard
                          key={sample.id}
                          sample={sample}
                          variant={isEmbedded ? "dense" : "default"}
                          selected={selectedBlocks.has(sample.id)}
                          onSelect={selectBlock}
                          onToggle={toggleBlock}
                          onTogglePriority={readOnly ? undefined : onToggleSamplePriority}
                        />
                      ))}
                    </QueueColumn>
                  );
                })}
              </div>
            </div>
          </div>
          {laneIndex === 0 && (
            <div
              key="board-resizer"
              data-board-resizer="true"
              className="group flex h-3 shrink-0 cursor-row-resize items-center justify-center"
              role="separator"
              aria-orientation="horizontal"
              title="Drag to resize top and bottom rows"
              onMouseDown={startBoardResize}
            >
              <div className="h-1 w-16 rounded-full bg-line transition group-hover:bg-brand/60" />
            </div>
          )}
          </Fragment>
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {active?.type === "block" ? (
          <div className="relative min-w-48">
            <SampleCard sample={active.sample} overlay />
            {(active.count ?? 1) > 1 && (
              <span className="absolute -right-2 -top-2 rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-white shadow">
                {active.count}
              </span>
            )}
          </div>
        ) : active?.type === "section" ? (
          <div className="relative min-w-48">
            <SectionCard section={active.section} overlay />
            {(active.count ?? 1) > 1 && (
              <span className="absolute -right-2 -top-2 rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-white shadow">
                {active.count}
              </span>
            )}
          </div>
        ) : active?.type === "stack" ? (
          <div className="relative min-w-48">
            <StackCard stack={active.stack} overlay />
            {(active.count ?? 1) > 1 && (
              <span className="absolute -right-2 -top-2 rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-white shadow">
                {active.count}
              </span>
            )}
          </div>
        ) : active?.type === "batch" ? (
          <ProcessingBatchRow batch={active.batch} overlay />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
