import { CheckCircle2, ListChecks, Layers, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useActions } from "../hooks/useActions";
import { useAssayCatalog, useStackSlides } from "../hooks/useData";
import { syncAssayStackWorkflowStep } from "../lib/db";
import { SECTION_STAGES } from "../lib/stages";
import type { SlideStack } from "../lib/types";
import { Button } from "./ui";
import { ProtocolChecklist } from "./ProtocolChecklist";
import { RemovalReasonDialog } from "./RemovalReasonDialog";
import { readOnlyNotice, useReadOnly, useReadOnlyReason } from "../lib/readOnly";
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
    reassignSlide,
    reassignSlides,
    splitSlidesIntoNewRack,
    mergeSlideStacks,
  } = useActions();
  const { data: slides = [] } = useStackSlides(stack.id);
  const { data: catalog = [] } = useAssayCatalog();
  // A viewer reads the rack and its protocol progress; it cannot drive them (#72).
  const readOnly = useReadOnly();
  const reason = useReadOnlyReason();
  const [error, setError] = useState<string | null>(null);
  const [selectingSlides, setSelectingSlides] = useState(false);
  const [selectedSlideIds, setSelectedSlideIds] = useState<Set<number>>(new Set());
  // Which removal the reason dialog is currently collecting a reason for (#83).
  const [removing, setRemoving] = useState<"slides" | "stacks" | null>(null);
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

  // Can the selected racks be poured into one (#124)?
  //
  // The data layer is the authority and refuses anything else — this only
  // decides whether to OFFER the button, and says why when it will not. Same
  // agent, and none of them started: merging a rack that has been through the
  // reagents with one that has not is how a rack ends up holding glass at two
  // different points, which is #81 arriving by a different door.
  const mergeCandidates = activeStacks.filter((candidate) => candidate.kind === "stain");
  const mergeAgents = [
    ...new Set(mergeCandidates.map((candidate) => `${candidate.assay_type}:${candidate.assay_name}`)),
  ];
  const mergeStarted = mergeCandidates.some(
    (candidate) => candidate.current_stage !== "stain_requested",
  );
  const canMerge =
    mergeCandidates.length > 1 &&
    mergeCandidates.length === activeStacks.length &&
    mergeAgents.length === 1 &&
    !mergeStarted;
  const mergeRefusal =
    mergeAgents.length > 1
      ? "Those racks are for different agents."
      : mergeStarted
        ? "One of those racks has already been through the reagents."
        : "Only staining and IHC racks can be merged.";

  // A stack can hold glass in different states — a late arrival from a second
  // rack, or a slide moved in that was already stained (#115). The stack's own
  // protocol is one state for all of them, so these two counts are what tells
  // the operator that the card and the glass do not agree.
  const liveSlides = slides.filter((slide) => slide.current_stage !== "removed");
  const unimagedSlides = liveSlides.filter((slide) => !slide.stage_pictures_taken_at);
  const stainedCount = liveSlides.filter((slide) => Boolean(slide.stage_stained_at)).length;
  const mixedStaining = stainedCount > 0 && stainedCount < liveSlides.length;

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
        {/* The protocol comes FIRST (#122).

            It used to sit below the slide list, which is fine for a rack of
            four and useless for a rack of fifty: the two checkboxes a
            technician ticks at the bench were a long scroll past the glass
            they refer to. The list is reference; the checkboxes are the
            work. */}
        {/* The protocol checkboxes write on every tick, so a viewer must not be
            offered them — that is the hanging spinner in #72. */}
        {readOnly && stack.current_stage === "stain_requested" && (
          <p className="mb-4 rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] text-ink-faint">
            {readOnlyNotice(reason, "Read-only viewer — the stain protocol is run on the workstation.")}
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
                  <ListChecks size={13} /> {selectingSlides ? "Cancel" : "Select slides"}
                </button>
              )}
            </div>
          </div>
          {/* Say it out loud when the rack holds glass at different points. This
              happens legitimately — a slide moved in from another agent brings
              its staining with it (#115) — but the rack's own protocol reports a
              single state, so without this the two simply disagree and the
              reader has to guess which is true. ("above", not "below", since
              #122 moved the checklist to the top of the panel.) */}
          {mixedStaining && (
            <p className="mb-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
              {stainedCount} of {liveSlides.length} slides here were already stained — the protocol
              above tracks this rack, not those slides. Their own dates are shown beside them.
            </p>
          )}
          {!readOnly && selectingSlides && (
            <div className="mb-2 space-y-1.5">
              {/* One selection, two things to do with it (#126).
                  
                  Reassigning was per-slide only, which is fine for the one slide
                  that went on the wrong agent and miserable for the twelve that
                  did — twelve dropdowns, twelve waits, and no way to tell part
                  way through which ones you had already done. The checkboxes
                  were already here for removal; this just lets the same tick
                  list drive the move. */}
              <select
                aria-label="Reassign the selected slides"
                value=""
                disabled={selectedSlideIds.size === 0}
                onChange={(event) => {
                  const next = event.target.value;
                  if (!next) return;
                  event.target.value = "";
                  const ids = [...selectedSlideIds];
                  const target =
                    next === "extra"
                      ? ({ extra: true } as const)
                      : (() => {
                          const [assayType, ...nameParts] = next.split(":");
                          return {
                            assayType: assayType as "stain" | "ihc",
                            assayName: nameParts.join(":"),
                          };
                        })();
                  void run(async () => {
                    await reassignSlides(ids, target);
                    setSelectedSlideIds(new Set());
                    setSelectingSlides(false);
                  });
                }}
                className="w-full rounded-md border border-line bg-panel px-2 py-1.5 text-xs text-ink outline-none focus:border-brand disabled:opacity-50"
              >
                <option value="">
                  {selectedSlideIds.size > 0
                    ? `Move ${selectedSlideIds.size} slide${selectedSlideIds.size === 1 ? "" : "s"} to…`
                    : "Tick slides to move or remove"}
                </option>
                <option value="extra">Back to extras</option>
                <optgroup label="Stains">
                  {catalog
                    .filter((entry) => entry.assay_type === "stain")
                    .map((entry) => (
                      <option key={`bulk-stain-${entry.name}`} value={`stain:${entry.name}`}>
                        {entry.name}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="IHC">
                  {catalog
                    .filter((entry) => entry.assay_type === "ihc")
                    .map((entry) => (
                      <option key={`bulk-ihc-${entry.name}`} value={`ihc:${entry.name}`}>
                        {entry.name}
                      </option>
                    ))}
                </optgroup>
              </select>
              {/* Split (#124). A rack is a physical holder, and half of one
                  often needs to go through now while the rest waits. Doing that
                  by reassigning each slide to another agent and back was the
                  only route before, and it wrote a lie about the agent on every
                  slide it touched. */}
              <Button
                variant="subtle"
                className="w-full justify-center"
                disabled={selectedSlideIds.size === 0 || selectedSlideIds.size >= liveSlides.length}
                title={
                  selectedSlideIds.size >= liveSlides.length && liveSlides.length > 0
                    ? "That is the whole rack — leave at least one slide behind."
                    : undefined
                }
                onClick={() => {
                  const ids = [...selectedSlideIds];
                  void run(async () => {
                    await splitSlidesIntoNewRack(ids);
                    setSelectedSlideIds(new Set());
                    setSelectingSlides(false);
                  });
                }}
              >
                <Layers size={14} />
                {selectedSlideIds.size > 0
                  ? `Split ${selectedSlideIds.size} slide${selectedSlideIds.size === 1 ? "" : "s"} into a new rack`
                  : "Tick the slides to split off"}
              </Button>
              <Button
                variant="subtle"
                className="w-full justify-center text-red-600"
                disabled={selectedSlideIds.size === 0}
                onClick={() => setRemoving("slides")}
              >
                <Trash2 size={14} />
                {selectedSlideIds.size > 0
                  ? `Remove ${selectedSlideIds.size} slide${selectedSlideIds.size === 1 ? "" : "s"}`
                  : "Tick the slides to remove"}
              </Button>
            </div>
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
                    {/* Per-slide truth, beside the slide. The protocol checklist
                        below is ONE state for the whole rack, which cannot say
                        that this slide arrived already stained (or that it did
                        not) — and a rack reading "0/2 complete" over a stained
                        slide is the kind of contradiction nobody reconciles. */}
                    {slide.stage_stained_at && (
                      <span className="block truncate text-[10px] text-brand">
                        Stained {slide.stage_stained_at.slice(0, 10)}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase text-ink-faint">{slide.assay_type}</span>
                  {/* Reassign, even from here (#115). A slide can be put on the
                      wrong agent, or turn out not to be needed, and until now
                      the only options after it reached staining were to leave it
                      wrong or remove it. Moving it re-homes it into the open
                      rack for the new agent and retires this one if it was the
                      last slide in it. */}
                  {!readOnly && !selectingSlides && (
                    <select
                      aria-label={`Reassign ${displayCode(slide.slide_code)}`}
                      value=""
                      onChange={(event) => {
                        const next = event.target.value;
                        if (!next) return;
                        event.target.value = "";
                        if (next === "extra") {
                          void run(() => reassignSlide(slide.id, { extra: true }));
                          return;
                        }
                        const [assayType, ...nameParts] = next.split(":");
                        void run(() =>
                          reassignSlide(slide.id, {
                            assayType: assayType as "stain" | "ihc",
                            assayName: nameParts.join(":"),
                          }),
                        );
                      }}
                      className="shrink-0 rounded border border-line bg-panel px-1 py-0.5 text-[10px] text-ink-soft outline-none focus:border-brand"
                    >
                      <option value="">Move…</option>
                      <option value="extra">Back to extras</option>
                      <optgroup label="Stains">
                        {catalog
                          .filter((entry) => entry.assay_type === "stain")
                          .map((entry) => (
                            <option key={`stain-${entry.name}`} value={`stain:${entry.name}`}>
                              {entry.name}
                            </option>
                          ))}
                      </optgroup>
                      <optgroup label="IHC">
                        {catalog
                          .filter((entry) => entry.assay_type === "ihc")
                          .map((entry) => (
                            <option key={`ihc-${entry.name}`} value={`ihc:${entry.name}`}>
                              {entry.name}
                            </option>
                          ))}
                      </optgroup>
                    </select>
                  )}
                </div>
              );
            })}
          </div>
          {["ready_for_imaging", "pictures_taken"].includes(stack.current_stage) && slides.length > 0 && (
            <p className="mt-2 text-[11px] text-ink-faint">{imagedCount}/{slides.length} imaged</p>
          )}
        </section>

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
            <Button
              variant="primary"
              className="flex-1"
              // Disabled rather than refused after the click: the data layer
              // still refuses (that is the guarantee), but a button that cannot
              // work should say so before it is pressed.
              disabled={unimagedSlides.length > 0}
              title={
                unimagedSlides.length > 0
                  ? `${unimagedSlides
                      .map((slide) => displayCode(slide.slide_code))
                      .join(", ")} ${unimagedSlides.length === 1 ? "has" : "have"} no images captured yet.`
                  : "Record this stack's imaging as finished"
              }
              onClick={() => void run(() => completeSlideStacksImaging(imagingIds))}
            >
              <CheckCircle2 size={15} /> {imagingIds.length > 1 ? `Complete Imaging (${imagingIds.length})` : "Complete Imaging"}
            </Button>
          ) : (
            <Button variant="primary" className="flex-1" onClick={() => void run(() => moveSlideStacks(analysisIds, "analyzed"))}>
              <CheckCircle2 size={15} /> {analysisIds.length > 1 ? `Mark Analyzed (${analysisIds.length})` : "Mark Analyzed"}
            </Button>
          )}
          {activeStacks.length > 1 && (
            <Button
              title={canMerge ? "Pour these racks into one" : mergeRefusal}
              disabled={!canMerge}
              onClick={() => void run(() => mergeSlideStacks(activeIds))}
            >
              <Layers size={15} /> Merge {activeStacks.length}
            </Button>
          )}
          <Button
            variant="danger"
            title="Remove selected slide stacks"
            onClick={() => setRemoving("stacks")}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      </div>
      )}

      {removing === "slides" && (
        <RemovalReasonDialog
          title="Remove slides from this rack"
          what={`${selectedSlideIds.size} slide${selectedSlideIds.size === 1 ? "" : "s"}`}
          confirmLabel={`Remove ${selectedSlideIds.size} slide${selectedSlideIds.size === 1 ? "" : "s"}`}
          onClose={() => setRemoving(null)}
          onConfirm={(reason) => {
            setRemoving(null);
            void run(() => removeSlides([...selectedSlideIds], reason));
            setSelectedSlideIds(new Set());
            setSelectingSlides(false);
          }}
        />
      )}
      {removing === "stacks" && (
        <RemovalReasonDialog
          title={activeIds.length === 1 ? "Remove this slide stack" : "Remove slide stacks"}
          what={activeIds.length === 1 ? "this slide stack and its slides" : `${activeIds.length} slide stacks and their slides`}
          confirmLabel={activeIds.length === 1 ? "Remove stack" : `Remove ${activeIds.length} stacks`}
          onClose={() => setRemoving(null)}
          onConfirm={(reason) => {
            setRemoving(null);
            void removeSlideStacks(activeIds, reason);
            onClose();
          }}
        />
      )}
    </div>
  );
}
