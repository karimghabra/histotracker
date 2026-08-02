import { CheckCircle2, ListChecks, Layers, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useActions } from "../hooks/useActions";
import { useStackSlides } from "../hooks/useData";
import { syncAssayStackWorkflowStep } from "../lib/db";
import { SECTION_STAGES } from "../lib/stages";
import type { SlideStack } from "../lib/types";
import { Button } from "./ui";
import { ProtocolChecklist } from "./ProtocolChecklist";
import { useReadOnly } from "../lib/readOnly";
import { displayCode } from "../lib/utils";

// Drying is no longer tracked (#80). The stage and its column are retained in
// the schema (append-only contract, and legacy rows may still carry a stamp),
// but it is not a step the lab records, so it does not appear on the timeline —
// it was rendering a permanent "Dried –" row on every rack.
const STACK_TIMELINE_KEYS = new Set([
  "stained",
  "ihc_complete",
  "coverslipped",
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
  // A viewer reads the rack and its protocol progress; it cannot drive them (#72).
  const readOnly = useReadOnly();
  const [error, setError] = useState<string | null>(null);
  const [selectingSlides, setSelectingSlides] = useState(false);
  const [selectedSlideIds, setSelectedSlideIds] = useState<Set<number>>(new Set());
  const activeStacks = selectedStacks.length > 0 ? selectedStacks : [stack];
  const activeIds = activeStacks.map((candidate) => candidate.id);
  const stainStackIds = activeStacks
    .filter((candidate) => candidate.current_stage === "stain_requested" && candidate.has_stain === 1)
    .map((candidate) => candidate.id);
  const ihcStackIds = activeStacks
    .filter((candidate) => candidate.current_stage === "stain_requested" && candidate.has_ihc === 1)
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

  // The aggregate stack row loses the pre-imaging stamps (Stained/Coverslipped/
  // Dried…) when a stain rack scatters into a per-sample imaging stack — the old
  // rack is deleted and only the new stage is stamped. The SLIDES keep their own
  // stamps, so build the timeline from them (latest across the stack's slides),
  // falling back to the stack column for stack-only markers (e.g. IHC Complete).
  const stageTimes = useMemo(() => {
    const merged: Record<string, string | null> = {};
    for (const stage of SECTION_STAGES) {
      const col = stage.column;
      let latest: string | null = null;
      for (const slide of slides) {
        const v = (slide as unknown as Record<string, string | null>)[col];
        if (v && (latest === null || v > latest)) latest = v;
      }
      merged[col] = latest ?? (stack as unknown as Record<string, string | null>)[col] ?? null;
    }
    return merged;
  }, [slides, stack]);

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
            <span className="truncate">
              {displayCode(stack.parent_code ?? "")}{stack.kind === "stain" ? " · stain rack" : ""}
            </span>
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
              {/* Removing a slide used to be hidden behind this bare 14px icon
                  with no label — the same discoverability failure as #79. The
                  Extras drawer already does it properly (permanent checkboxes +
                  a labelled button), so this now says what it is (#73). */}
              {!readOnly && (
                <button
                  type="button"
                  aria-label={selectingSlides ? "Cancel slide selection" : "Select slides to remove"}
                  onClick={() => {
                    setSelectingSlides((current) => !current);
                    setSelectedSlideIds(new Set());
                  }}
                  className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium ${
                    selectingSlides
                      ? "bg-brand text-white"
                      : "text-ink-soft hover:bg-black/5 hover:text-ink"
                  }`}
                >
                  <ListChecks size={13} /> {selectingSlides ? "Cancel" : "Remove slides"}
                </button>
              )}
            </div>
          </div>
          {!readOnly && selectingSlides && (
            <Button
              variant="subtle"
              className="mb-2 w-full justify-center text-red-600"
              disabled={selectedSlideIds.size === 0}
              onClick={() => {
                if (
                  confirm(
                    `Delete ${selectedSlideIds.size} selected slide${selectedSlideIds.size === 1 ? "" : "s"}? You can undo this.\n\n` +
                      `Slide letters are not reused, so the next slide cut will continue the sequence.`,
                  )
                ) {
                  void run(() => removeSlides([...selectedSlideIds]));
                  setSelectedSlideIds(new Set());
                  setSelectingSlides(false);
                }
              }}
            >
              <Trash2 size={14} />
              {selectedSlideIds.size > 0
                ? `Remove ${selectedSlideIds.size} slide${selectedSlideIds.size === 1 ? "" : "s"}`
                : "Tick the slides to remove"}
            </Button>
          )}
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
                      aria-label={`Select ${displayCode(slide.slide_code)}`}
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
                      aria-label={`Images captured for ${displayCode(slide.slide_code)}`}
                      onChange={() => void run(() => setSlidePicturesTaken(slide.id, !imaged))}
                      className="h-3.5 w-3.5 shrink-0 accent-[var(--color-brand)]"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-ink">{displayCode(slide.slide_code)}</span>
                    <span className="block truncate text-[10px] text-ink-faint">
                      {slide.assay_name || slide.stain_name}{slide.parent_code ? ` | ${displayCode(slide.parent_code)}` : ""}
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

        {/* The protocol checkboxes write on every tick, so a viewer must not be
            offered them — that is the hanging spinner in #72. */}
        {readOnly && stack.current_stage === "stain_requested" && (
          <p className="mb-4 rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] text-ink-faint">
            Read-only viewer — the stain protocol is run on the workstation.
          </p>
        )}
        {!readOnly && stack.current_stage === "stain_requested" && assayTypes.includes("stain") && (
          <ProtocolChecklist
            scopeType="slide_stack"
            scopeId={stack.id}
            stageKey="stain_workflow_v5"
            protocolName="Stain workflow"
            // Drying is no longer tracked (#80). The stage_key stays at _v5 on
            // purpose: ensureChecklist REUSES an existing run, so racks already
            // mid-protocol keep the three steps they started with and finish the
            // way the technician expects, while every new rack gets two.
            labels={["Stained", "Coverslipped"]}
            batchScopeIds={stainStackIds.filter((id) => id !== stack.id)}
            onStepChange={(sortOrder, complete, scopeIds) =>
              Promise.all(scopeIds.map((id) => syncAssayStackWorkflowStep(id, "stain", sortOrder, complete))).then(() => undefined)
            }
          />
        )}
        {!readOnly && stack.current_stage === "stain_requested" && assayTypes.includes("ihc") && (
          <ProtocolChecklist
            scopeType="slide_stack"
            scopeId={stack.id}
            stageKey="ihc_workflow_v5"
            protocolName="IHC workflow"
            labels={["IHC stained", "Coverslipped"]}
            batchScopeIds={ihcStackIds.filter((id) => id !== stack.id)}
            onStepChange={(sortOrder, complete, scopeIds) =>
              Promise.all(scopeIds.map((id) => syncAssayStackWorkflowStep(id, "ihc", sortOrder, complete))).then(() => undefined)
            }
          />
        )}

        <h3 className="mb-2 text-xs font-semibold uppercase text-ink-faint">Stack timeline</h3>
        <ol className="space-y-1">
          {SECTION_STAGES.filter((stage) => STACK_TIMELINE_KEYS.has(stage.key)).map((stage) => {
            const at = stageTimes[stage.column];
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

      {!readOnly && (
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
      )}
    </div>
  );
}
