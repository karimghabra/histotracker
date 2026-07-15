import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { ProcessingBatch, Sample, SectionRequest, Slide } from "../lib/types";
import {
  BLOCK_QUEUE_KEYS,
  BOARD_LANES,
  LANE_COLORS,
  QUEUE_BY_KEY,
  SECTION_QUEUE_ENTRY,
  SECTION_QUEUE_KEYS,
  SECTION_STAGE_TO_QUEUE,
  STAGE_TO_QUEUE,
} from "../lib/stages";
import { ProcessingBatchRow } from "./ProcessingBatchRow";
import { QueueColumn } from "./QueueColumn";
import { SampleCard } from "./SampleCard";
import { SectionCard } from "./SectionCard";
import { ExtraSlideInventory } from "./ExtraSlideInventory";

type EmbeddedSort = "embedded_date" | "name" | "sample_id";
type ActiveDrag =
  | { type: "block"; sample: Sample; count?: number }
  | { type: "section"; section: SectionRequest; count?: number }
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
  batches,
  extraSlides,
  onSelectSample,
  onSampleSelectionChange,
  onSelectSection,
  onMoveSamples,
  onMoveSections,
  onRequestProcessingBatch,
  onMoveProcessingBatch,
  onSelectProcessingBatch,
  onToggleSamplePriority,
}: {
  samples: Sample[];
  sections: SectionRequest[];
  batches: ProcessingBatch[];
  extraSlides: Slide[];
  selectedSampleId: number | null;
  selectedSectionId: number | null;
  onSelectSample: (id: number) => void;
  onSampleSelectionChange: (ids: number[]) => void;
  onSelectSection: (id: number) => void;
  onMoveSamples: (sampleIds: number[], stageKey: string) => void;
  onMoveSections: (sectionIds: number[], stageKey: string) => void;
  onRequestProcessingBatch: (sampleIds: number[]) => void;
  onMoveProcessingBatch: (batchId: number, stageKey: string) => void;
  onSelectProcessingBatch: (batchId: number) => void;
  onToggleSamplePriority: (sampleId: number) => void;
}) {
  const [active, setActive] = useState<ActiveDrag>(null);
  const [selectedBlocks, setSelectedBlocks] = useState<Set<number>>(new Set());
  const [selectedSections, setSelectedSections] = useState<Set<number>>(new Set());
  const blockAnchor = useRef<number | null>(null);
  const sectionAnchor = useRef<number | null>(null);
  const [embeddedFilter, setEmbeddedFilter] = useState<number | "all">("all");
  const [embeddedSort, setEmbeddedSort] = useState<EmbeddedSort>("embedded_date");
  const [assignmentView, setAssignmentView] = useState<"fresh" | "inventory">("fresh");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    const clear = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSelectedBlocks(new Set());
      setSelectedSections(new Set());
    };
    window.addEventListener("keydown", clear);
    return () => window.removeEventListener("keydown", clear);
  }, []);

  useEffect(() => {
    onSampleSelectionChange([...selectedBlocks]);
  }, [onSampleSelectionChange, selectedBlocks]);

  const batchMemberIds = useMemo(
    () => new Set(batches.flatMap((batch) => batch.member_ids)),
    [batches],
  );
  const visibleBlockOrder = useMemo(
    () => samples.filter((sample) => !batchMemberIds.has(sample.id)).map((sample) => sample.id),
    [batchMemberIds, samples],
  );
  const visibleSectionOrder = useMemo(() => sections.map((section) => section.id), [sections]);

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

  function selectBlock(id: number, event: MouseEvent<HTMLDivElement>) {
    setSelectedSections(new Set());
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
      setSelectedBlocks(new Set([id]));
      blockAnchor.current = id;
    }
    onSelectSample(id);
  }

  function toggleBlock(id: number) {
    setSelectedSections(new Set());
    const target = samples.find((sample) => sample.id === id);
    if (!target) return;
    const targetQueue = STAGE_TO_QUEUE[target.current_stage];
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
    onSelectSample(id);
  }

  function selectSection(id: number, event: MouseEvent<HTMLDivElement>) {
    setSelectedBlocks(new Set());
    if (event.shiftKey) {
      setSelectedSections(new Set(rangeSelection(visibleSectionOrder, sectionAnchor.current, id)));
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedSections((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      sectionAnchor.current = id;
    } else {
      setSelectedSections(new Set([id]));
      sectionAnchor.current = id;
    }
    onSelectSection(id);
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
    } else {
      setActive(data);
    }
  }

  function handleEnd(event: DragEndEvent) {
    setActive(null);
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
      if (overId === "processing") onRequestProcessingBatch(ids);
      else onMoveSamples(ids, QUEUE_BY_KEY[overId].entryStage);
      setSelectedBlocks(new Set());
    } else if (data.type === "batch") {
      if (overId !== "processor_pickup" && overId !== "needs_embedding") return;
      onMoveProcessingBatch(data.batch.id, QUEUE_BY_KEY[overId].entryStage);
    } else {
      if (!SECTION_QUEUE_KEYS.has(overId)) return;
      const ids = selectedSections.has(data.section.id)
        ? [...selectedSections]
        : [data.section.id];
      const selected = sections.filter((section) => ids.includes(section.id));
      if (selected.every((section) => SECTION_STAGE_TO_QUEUE[section.current_stage] === overId)) {
        return;
      }
      onMoveSections(ids, SECTION_QUEUE_ENTRY[overId]);
      setSelectedSections(new Set());
    }
  }

  const selectClass =
    "w-full rounded-md border border-line bg-white px-1.5 py-1 text-[11px] text-ink outline-none";

  return (
    <DndContext sensors={sensors} onDragStart={handleStart} onDragEnd={handleEnd}>
      <div className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        {BOARD_LANES.map((lane, laneIndex) => (
          <div
            key={lane.title}
            className="flex min-h-0 shrink-0 flex-col overflow-hidden"
            style={{ height: "calc(50% - 0.375rem)" }}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <span
                className="h-3.5 w-1 rounded-full"
                style={{ backgroundColor: LANE_COLORS[laneIndex] }}
              />
              <h2 className="text-[13px] font-semibold text-ink">{lane.title}</h2>
              {(selectedBlocks.size > 1 || selectedSections.size > 1) && (
                <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">
                  {selectedBlocks.size || selectedSections.size} selected
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-x-auto thin-scroll">
              <div
                className="grid h-full min-h-0 gap-2"
                style={{
                  minWidth: laneIndex === 1 ? "930px" : "720px",
                  gridTemplateColumns:
                    laneIndex === 1
                      ? "1.45fr repeat(4, minmax(0, 1fr))"
                      : "repeat(4, minmax(0, 1fr))",
                }}
              >
                {lane.queues.map((queueKey) => {
                  const queue = QUEUE_BY_KEY[queueKey];

                  if (SECTION_QUEUE_KEYS.has(queueKey)) {
                    const items = sectionsByQueue[queueKey] ?? [];
                    const isAssignment = queueKey === "slide_assignment";
                    const showingInventory = isAssignment && assignmentView === "inventory";
                    const selectedCount = items.filter((item) => selectedSections.has(item.id)).length;
                    return (
                      <QueueColumn
                        key={queueKey}
                        queue={queue}
                        count={showingInventory ? extraSlides.length : items.length}
                        selectedCount={selectedCount}
                        onToggleAll={
                          !showingInventory && items.length > 0
                            ? () => {
                                setSelectedBlocks(new Set());
                                setSelectedSections(
                                  selectedCount === items.length
                                    ? new Set()
                                    : new Set(items.map((item) => item.id)),
                                );
                              }
                            : undefined
                        }
                        headerExtra={isAssignment ? (
                          <div className="grid grid-cols-2 rounded-md border border-line bg-panel p-0.5 text-[10px]">
                            <button
                              onClick={() => setAssignmentView("fresh")}
                              className={`rounded px-1 py-1 ${assignmentView === "fresh" ? "bg-brand text-white" : "text-ink-soft hover:bg-surface"}`}
                            >
                              Fresh ({items.length})
                            </button>
                            <button
                              onClick={() => setAssignmentView("inventory")}
                              className={`rounded px-1 py-1 ${assignmentView === "inventory" ? "bg-brand text-white" : "text-ink-soft hover:bg-surface"}`}
                            >
                              Extras ({extraSlides.length})
                            </button>
                          </div>
                        ) : undefined}
                      >
                        {showingInventory ? <ExtraSlideInventory slides={extraSlides} /> : items.map((section) => (
                          <SectionCard
                            key={section.id}
                            section={section}
                            selected={selectedSections.has(section.id)}
                            onSelect={selectSection}
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
                          onSelect={onSelectProcessingBatch}
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
                          onTogglePriority={onToggleSamplePriority}
                        />
                      ))}
                    </QueueColumn>
                  );
                })}
              </div>
            </div>
          </div>
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
        ) : active?.type === "batch" ? (
          <ProcessingBatchRow batch={active.batch} overlay />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
