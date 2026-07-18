import { CheckCircle2, ListChecks, Layers, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useActions } from "../hooks/useActions";
import { useStackSlides } from "../hooks/useData";
import { syncAssayStackWorkflowStep } from "../lib/db";
import { SECTION_STAGES } from "../lib/stages";
import type { SlideStack } from "../lib/types";
import { Button } from "./ui";
import { ProtocolChecklist } from "./ProtocolChecklist";

const STACK_TIMELINE_KEYS = new Set([
  "stained",
  "ihc_complete",
  "refrax_complete",
  "coverslipped",
  "dried",
  "ready_for_imaging",
  "pictures_taken",
  "analyzed",
]);

export function StackDetailsDrawer({
  stack,
  selectedStacks = [],
  width = 416,
  onClose,
}: {
  stack: SlideStack;
  selectedStacks?: SlideStack[];
  width?: number;
  onClose: () => void;
}) {
  const {
    setSlidePicturesTaken,
    completeSlideStacksImaging,
    moveSlideStacks,
    removeSlideStacks,
    removeSlides,
  } = useActions();
  const { data: slides = [] } = useStackSlides(stack.id);
  const [error, setError] = useState<string | null>(null);
  const [selectingSlides, setSelectingSlides] = useState(false);
  const [selectedSlideIds, setSelectedSlideIds] = useState<Set<number>>(new Set());
  const activeStacks = selectedStacks.length > 0 ? selectedStacks : [stack];
  const activeIds = activeStacks.map((candidate) => candidate.id);
  const stainingIds = activeStacks
    .filter((candidate) => candidate.current_stage === "stain_requested")
    .map((candidate) => candidate.id);
  const imagingIds = activeStacks
    .filter((candidate) => candidate.current_stage === "ready_for_imaging")
    .map((candidate) => candidate.id);
  const analysisIds = activeStacks
    .filter((candidate) => candidate.current_stage === "pictures_taken")
    .map((candidate) => candidate.id);
  const assayTypes = useMemo(
    () => [...new Set(slides.map((slide) => slide.assay_type))]
      .filter((value): value is "stain" | "ihc" => value === "stain" || value === "ihc"),
    [slides],
  );
  const imagedCount = slides.filter((slide) => Boolean(slide.stage_pictures_taken_at)).length;

  useEffect(() => {
    setSelectingSlides(false);
    setSelectedSlideIds(new Set());
  }, [stack.id]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <div className="flex h-full shrink-0 flex-col border-l border-line bg-panel" style={{ width }}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <Layers size={16} className="shrink-0" />
            <span className="truncate">{stack.parent_code} slide stack</span>
          </h2>
          <p className="truncate text-xs text-ink-faint">
            {stack.parent_description || stack.project_name || `Stack ${stack.id}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close slide stack details"
          className="rounded-md p-1 text-ink-faint hover:bg-black/5 hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 thin-scroll">
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase text-ink-faint">Assay slides</h3>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-[11px] text-ink-soft">{slides.length} total</span>
              {selectingSlides && selectedSlideIds.size > 0 && (
                <button
                  type="button"
                  title="Delete selected slides"
                  aria-label="Delete selected slides"
                  onClick={() => {
                    if (confirm(`Delete ${selectedSlideIds.size} selected slide${selectedSlideIds.size === 1 ? "" : "s"}? You can undo this.`)) {
                      void run(() => removeSlides([...selectedSlideIds]));
                      setSelectedSlideIds(new Set());
                      setSelectingSlides(false);
                    }
                  }}
                  className="rounded-md p-1 text-red-600 hover:bg-red-50"
                >
                  <Trash2 size={14} />
                </button>
              )}
              <button
                type="button"
                title={selectingSlides ? "Cancel slide selection" : "Select slides"}
                aria-label={selectingSlides ? "Cancel slide selection" : "Select slides"}
                onClick={() => {
                  setSelectingSlides((current) => !current);
                  setSelectedSlideIds(new Set());
                }}
                className={`rounded-md p-1 ${selectingSlides ? "bg-brand text-white" : "text-ink-faint hover:bg-black/5 hover:text-ink"}`}
              >
                <ListChecks size={14} />
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            {slides.map((slide) => {
              const imaged = Boolean(slide.stage_pictures_taken_at);
              const showImaging = ["ready_for_imaging", "pictures_taken"].includes(stack.current_stage);
              return (
                <div key={slide.id} className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
                  {selectingSlides ? (
                    <input
                      type="checkbox"
                      checked={selectedSlideIds.has(slide.id)}
                      aria-label={`Select ${slide.slide_code}`}
                      onChange={() => setSelectedSlideIds((current) => {
                        const next = new Set(current);
                        if (next.has(slide.id)) next.delete(slide.id);
                        else next.add(slide.id);
                        return next;
                      })}
                      className="h-3.5 w-3.5 shrink-0 accent-[var(--color-brand)]"
                    />
                  ) : showImaging && (
                    <input
                      type="checkbox"
                      checked={imaged}
                      aria-label={`Images captured for ${slide.slide_code}`}
                      onChange={() => void run(() => setSlidePicturesTaken(slide.id, !imaged))}
                      className="h-3.5 w-3.5 shrink-0 accent-[var(--color-brand)]"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-ink">{slide.slide_code}</span>
                    <span className="block truncate text-[10px] text-ink-faint">
                      {slide.assay_name || slide.stain_name} | {slide.cut_depth_um ?? slide.depth_um ?? "?"} um
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] uppercase text-ink-faint">{slide.assay_type}</span>
                </div>
              );
            })}
          </div>
          {["ready_for_imaging", "pictures_taken"].includes(stack.current_stage) && slides.length > 0 && (
            <p className="mt-2 text-[11px] text-ink-faint">{imagedCount}/{slides.length} imaged</p>
          )}
        </section>

        {stack.current_stage === "stain_requested" && assayTypes.includes("stain") && (
          <ProtocolChecklist
            scopeType="slide_stack"
            scopeId={stack.id}
            stageKey="stain_workflow_v3"
            protocolName="Stain workflow"
            labels={["Stained", "Coverslipped", "Dried"]}
            batchScopeIds={stainingIds.filter((id) => id !== stack.id)}
            onStepChange={(sortOrder, complete, scopeIds) =>
              Promise.all(scopeIds.map((id) => syncAssayStackWorkflowStep(id, "stain", sortOrder, complete))).then(() => undefined)
            }
          />
        )}
        {stack.current_stage === "stain_requested" && assayTypes.includes("ihc") && (
          <ProtocolChecklist
            scopeType="slide_stack"
            scopeId={stack.id}
            stageKey="ihc_workflow_v3"
            protocolName="IHC workflow"
            labels={["IHC stained", "Coverslipped", "Dried"]}
            batchScopeIds={stainingIds.filter((id) => id !== stack.id)}
            onStepChange={(sortOrder, complete, scopeIds) =>
              Promise.all(scopeIds.map((id) => syncAssayStackWorkflowStep(id, "ihc", sortOrder, complete))).then(() => undefined)
            }
          />
        )}

        <h3 className="mb-2 text-xs font-semibold uppercase text-ink-faint">Stack timeline</h3>
        <ol className="space-y-1">
          {SECTION_STAGES.filter((stage) => STACK_TIMELINE_KEYS.has(stage.key)).map((stage) => {
            const at = (stack as unknown as Record<string, string | null>)[stage.column];
            return (
              <li key={stage.key} className="flex items-center gap-2 text-xs">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${at ? "bg-brand" : "bg-line"}`} />
                <span className="flex-1 text-ink-soft">{stage.label}</span>
                <span className="text-[11px] text-ink-faint">{at ?? "-"}</span>
              </li>
            );
          })}
        </ol>
        {error && <p className="mt-3 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">{error}</p>}
      </div>

      <div className="border-t border-line px-4 py-3">
        <div className="flex items-center gap-2">
          {stack.current_stage === "stain_requested" ? (
            <Button variant="primary" className="flex-1" disabled title="Complete all applicable protocol steps to continue.">
              <CheckCircle2 size={15} /> Workflow In Progress
            </Button>
          ) : stack.current_stage === "ready_for_imaging" ? (
            <Button variant="primary" className="flex-1" onClick={() => void run(() => completeSlideStacksImaging(imagingIds))}>
              <CheckCircle2 size={15} /> {imagingIds.length > 1 ? `Complete Imaging (${imagingIds.length})` : "Complete Imaging"}
            </Button>
          ) : (
            <Button variant="primary" className="flex-1" onClick={() => void run(() => moveSlideStacks(analysisIds, "analyzed"))}>
              <CheckCircle2 size={15} /> {analysisIds.length > 1 ? `Mark Analyzed (${analysisIds.length})` : "Mark Analyzed"}
            </Button>
          )}
          <Button
            variant="danger"
            title="Delete selected slide stacks"
            onClick={() => {
              if (confirm(`Delete ${activeIds.length === 1 ? "this slide stack" : `${activeIds.length} slide stacks`}? You can undo this.`)) {
                void removeSlideStacks(activeIds);
                onClose();
              }
            }}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      </div>
    </div>
  );
}
