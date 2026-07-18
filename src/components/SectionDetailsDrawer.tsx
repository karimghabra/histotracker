import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronRight, Pencil, Scissors, Trash2, X } from "lucide-react";
import type { SectionRequest, Slide, SlidePurpose } from "../lib/types";
import { SECTION_STAGES } from "../lib/stages";
import { Button } from "./ui";
import { useActions } from "../hooks/useActions";
import { useAssayCatalog, useSectionSlides } from "../hooks/useData";
import { syncAssayWorkflowStep } from "../lib/db";
import { ProtocolChecklist } from "./ProtocolChecklist";
import { duplicateLabel } from "../lib/utils";

const STATUS_ONLY_STAGES = new Set(["needs_sectioning", "assignment_required", "stain_requested"]);

function stainSuggestions(section: SectionRequest): string[] {
  const raw = section.parent_stains || section.stains || "";
  return [...new Set(raw.split(/[,;\n]/).map((value) => value.trim()).filter(Boolean))];
}

function SlideAssignmentRow({
  slide,
  catalog,
  onDraftChange,
}: {
  slide: Slide;
  catalog: Array<{ assay_type: "stain" | "ihc"; name: string }>;
  onDraftChange: (slideId: number, draft: AssignmentDraft) => void;
}) {
  const savedSelection =
    slide.purpose === "stain"
      ? `${slide.assay_type}:${slide.assay_name || slide.stain_name}`
      : "extra";
  const [selection, setSelection] = useState(savedSelection);

  useEffect(() => {
    setSelection(savedSelection);
  }, [savedSelection]);

  return (
    <div className="rounded-md border border-line bg-surface p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold text-ink">{slide.slide_code}</span>
        <span className="text-[10px] uppercase tracking-wide text-ink-faint">
          Duplicate {duplicateLabel(slide.depth_duplicate_ordinal ?? slide.slide_ordinal)}
        </span>
      </div>
      <p className="mb-1.5 text-[10px] text-ink-faint">
        Two slices: IgG control + target assay
      </p>
      <div>
        <select
          value={selection}
          onChange={(event) => {
            const next = event.target.value;
            setSelection(next);
            if (next === "extra") {
              onDraftChange(slide.id, { purpose: "extra", assayType: "", assayName: "" });
            } else {
              const [assayType, ...nameParts] = next.split(":");
              onDraftChange(slide.id, {
                purpose: "stain",
                assayType: assayType as "stain" | "ihc",
                assayName: nameParts.join(":"),
              });
            }
          }}
          className="w-full rounded border border-line bg-panel px-2 py-1.5 text-xs text-ink outline-none focus:border-brand"
        >
          <option value="extra">Extra</option>
          <optgroup label="Stains">
            {catalog.filter((entry) => entry.assay_type === "stain").map((entry) => (
              <option key={`stain-${entry.name}`} value={`stain:${entry.name}`}>{entry.name}</option>
            ))}
          </optgroup>
          <optgroup label="IHC">
            {catalog.filter((entry) => entry.assay_type === "ihc").map((entry) => (
              <option key={`ihc-${entry.name}`} value={`ihc:${entry.name}`}>{entry.name}</option>
            ))}
          </optgroup>
        </select>
      </div>
    </div>
  );
}

interface AssignmentDraft {
  purpose: SlidePurpose;
  assayType: "" | "stain" | "ihc";
  assayName: string;
}

export function SectionDetailsDrawer({
  section,
  selectedSections = [],
  width = 416,
  onClose,
}: {
  section: SectionRequest;
  selectedSections?: SectionRequest[];
  width?: number;
  onClose: () => void;
}) {
  const {
    markSectionAnalyzed,
    removeSection,
    editSectionTimestamp,
    moveSection,
    assignSlide,
    setSlidePicturesTaken,
    completeSectionImaging,
  } = useActions();
  const { data: slides = [] } = useSectionSlides(section.id);
  const { data: assayCatalog = [] } = useAssayCatalog();
  const [editingColumn, setEditingColumn] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, AssignmentDraft>>({});
  const [savingAll, setSavingAll] = useState(false);
  const suggestions = useMemo(() => stainSuggestions(section), [section]);
  const showAssignments = ["sectioned", "assignment_required"].includes(section.current_stage);
  const allAssigned = slides.length > 0 && slides.every((slide) => slide.assignment_saved === 1);
  const hasAssaySlides = slides.some((slide) => slide.purpose === "stain");
  const hasExtras = slides.some((slide) => slide.purpose === "extra");
  // Button label reflects what the move actually does for this stack (issue #13):
  // start stain/IHC work, push extras to inventory, or both.
  const startActionLabel = hasAssaySlides
    ? hasExtras
      ? "Start Assays / Move to Extras"
      : "Start Assay Workflow"
    : "Move to Extras";
  const assaySlides = slides.filter((slide) => slide.purpose === "stain");
  const imagedSlides = assaySlides.filter((slide) => Boolean(slide.stage_pictures_taken_at));
  const showImagingChecklist = ["ready_for_imaging", "pictures_taken"].includes(section.current_stage);
  const activeSelection = selectedSections.length > 0 ? selectedSections : [section];
  const stainingBatchIds = activeSelection
    .filter((candidate) => candidate.current_stage === "stain_requested")
    .map((candidate) => candidate.id);
  const imagingBatchIds = activeSelection
    .filter((candidate) => ["ready_for_imaging", "pictures_taken"].includes(candidate.current_stage))
    .map((candidate) => candidate.id);
  const analysisBatchIds = activeSelection
    .filter((candidate) => candidate.current_stage === "pictures_taken")
    .map((candidate) => candidate.id);
  const dirtyCount = Object.keys(drafts).length;
  const assayTypes = [...new Set(slides.filter((slide) => slide.purpose === "stain").map((slide) => slide.assay_type))]
    .filter((value): value is "stain" | "ihc" => value === "stain" || value === "ihc");
  const selectedAssayTypes = [...new Set([
    ...assayTypes,
    ...activeSelection.flatMap((candidate) => {
      const summary = candidate.assay_slide_summary ?? "";
      return [
        ...(summary.includes("Stain:") ? ["stain" as const] : []),
        ...(summary.includes("IHC:") ? ["ihc" as const] : []),
      ];
    }),
  ])];

  function beginEdit(column: string, current: string | null) {
    setEditingColumn(column);
    setDraft(current ? current.replace(" ", "T") : "");
  }

  async function commitEdit(column: string) {
    const value = draft ? draft.replace("T", " ").slice(0, 16) : null;
    await editSectionTimestamp(section.id, column, value);
    setEditingColumn(null);
  }

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
        <div>
          <h2 className="text-base font-semibold text-ink">
            {section.parent_code} · {section.depth_um} um ×{section.duplicates}
          </h2>
          <p className="text-xs text-ink-faint">
            Section from {section.parent_description || section.parent_code}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-ink-faint hover:bg-black/5 hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 thin-scroll">
        {suggestions.length > 0 && (
          <div className="mb-3">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Planned stains
            </h3>
            <div className="flex flex-wrap gap-1">
              {suggestions.map((stain) => (
                <span key={stain} className="rounded-full bg-brand/10 px-2 py-0.5 text-xs text-brand">
                  {stain}
                </span>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-ink-faint">
              Suggestions only. Assign each produced slide explicitly.
            </p>
          </div>
        )}

        {showAssignments && (
          <section className="mb-5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Slide purpose
              </h3>
              <span className={`text-[11px] ${allAssigned ? "text-emerald-600" : "text-amber-600"}`}>
                {slides.filter((slide) => slide.assignment_saved === 1).length}/{slides.length} saved
              </span>
            </div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[11px] text-ink-faint">
                {allAssigned && dirtyCount === 0
                  ? "All assignments saved"
                  : dirtyCount > 0
                    ? `${dirtyCount} changed assignment${dirtyCount === 1 ? "" : "s"}`
                    : "Save to confirm the default Extra assignments"}
              </p>
              <Button
                variant="primary"
                className="px-2 py-1"
                disabled={savingAll || (allAssigned && dirtyCount === 0)}
                title={allAssigned && dirtyCount === 0 ? "All slide assignments are already saved." : "Confirm every slide assignment, including Extras."}
                onClick={() => void run(async () => {
                  setSavingAll(true);
                  try {
                    for (const slide of slides) {
                      const assignment = drafts[slide.id] ?? {
                        purpose: slide.purpose === "stain" ? "stain" : "extra",
                        assayType: slide.purpose === "stain" ? slide.assay_type : "",
                        assayName: slide.purpose === "stain" ? slide.assay_name || slide.stain_name : "",
                      };
                      await assignSlide(slide.id, assignment.purpose, assignment.assayType, assignment.assayName);
                    }
                    setDrafts({});
                  } finally {
                    setSavingAll(false);
                  }
                })}
              >
                Save All
              </Button>
            </div>
            <div className="space-y-1.5">
              {slides.map((slide) => (
                <SlideAssignmentRow
                  key={slide.id}
                  slide={slide}
                  catalog={assayCatalog}
                  onDraftChange={(slideId, draft) =>
                    setDrafts((current) => ({ ...current, [slideId]: draft }))
                  }
                />
              ))}
            </div>
          </section>
        )}

        {!showAssignments && assaySlides.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Assay slides
            </h3>
            <div className="space-y-1.5">
              {assaySlides.map((slide) => (
                <div key={slide.id} className="rounded-md border border-line bg-surface px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-ink">{slide.slide_code}</span>
                    <span className="shrink-0 text-[10px] uppercase text-ink-faint">{slide.assay_type}</span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-ink-soft">
                    {slide.assay_name || slide.stain_name}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {showImagingChecklist && hasAssaySlides && (
          <section className="mb-5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Imaging checklist
              </h3>
              <span className={`text-[11px] ${imagedSlides.length === assaySlides.length ? "text-emerald-600" : "text-amber-600"}`}>
                {imagedSlides.length}/{assaySlides.length} imaged
              </span>
            </div>
            <p className="mb-2 text-[11px] text-ink-faint">
              Mark each stain or IHC slide once its images have been captured.
            </p>
            <div className="space-y-1.5">
              {assaySlides.map((slide) => {
                const complete = Boolean(slide.stage_pictures_taken_at);
                return (
                  <label
                    key={slide.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 transition ${complete ? "border-brand/30 bg-brand/5" : "border-line bg-surface hover:border-brand/40"}`}
                  >
                    <input
                      type="checkbox"
                      checked={complete}
                      onChange={() => void run(() => setSlidePicturesTaken(slide.id, !complete))}
                      className="h-3.5 w-3.5 shrink-0 accent-[var(--color-brand)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-ink">{slide.assay_name || slide.stain_name}</span>
                      <span className="block truncate text-[10px] text-ink-faint">{slide.slide_code} · {slide.assay_type.toUpperCase()}</span>
                    </span>
                    {complete && <CheckCircle2 size={14} className="shrink-0 text-emerald-600" />}
                  </label>
                );
              })}
            </div>
          </section>
        )}

        {section.current_stage === "stain_requested" && selectedAssayTypes.includes("stain") && (
          <ProtocolChecklist
            scopeType="section_request"
            scopeId={section.id}
            stageKey="stain_workflow_v3"
            protocolName="Stain workflow"
            labels={[
              "Stained",
              "Coverslipped",
              "Dried",
            ]}
            batchScopeIds={stainingBatchIds.filter((id) => id !== section.id)}
            onStepChange={(sortOrder, complete, scopeIds) =>
              Promise.all(scopeIds.map((id) => syncAssayWorkflowStep(id, "stain", sortOrder, complete))).then(() => undefined)
            }
          />
        )}
        {section.current_stage === "stain_requested" && selectedAssayTypes.includes("ihc") && (
          <ProtocolChecklist
            scopeType="section_request"
            scopeId={section.id}
            stageKey="ihc_workflow_v3"
            protocolName="IHC workflow"
            labels={[
              "IHC stained",
              "Coverslipped",
              "Dried",
            ]}
            batchScopeIds={stainingBatchIds.filter((id) => id !== section.id)}
            onStepChange={(sortOrder, complete, scopeIds) =>
              Promise.all(scopeIds.map((id) => syncAssayWorkflowStep(id, "ihc", sortOrder, complete))).then(() => undefined)
            }
          />
        )}

        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Laboratory timeline
          <span className="ml-2 font-normal normal-case text-ink-faint/70">physical events only</span>
        </h3>
        <ol className="space-y-1">
          {SECTION_STAGES.filter((stage) => !STATUS_ONLY_STAGES.has(stage.key)).map((stage) => {
            const at = (section as unknown as Record<string, string | null>)[stage.column];
            const editing = editingColumn === stage.column;
            return (
              <li key={stage.key} className="flex items-center gap-2 text-xs">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${at ? "bg-brand" : "bg-line"}`} />
                <span className="flex-1 text-ink-soft">{stage.label}</span>
                {editing ? (
                  <span className="flex items-center gap-1">
                    <input
                      type="datetime-local"
                      value={draft}
                      autoFocus
                      onChange={(event) => setDraft(event.target.value)}
                      className="rounded border border-line bg-panel px-1 py-0.5 text-[11px] text-ink outline-none focus:border-brand"
                    />
                    <button onClick={() => commitEdit(stage.column)} className="rounded bg-brand px-1.5 py-0.5 text-[11px] text-white">
                      Set
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => beginEdit(stage.column, at)}
                    className="group inline-flex items-center gap-1 rounded px-1 text-ink-faint hover:bg-black/5 hover:text-ink"
                  >
                    {at ?? "—"}
                    <Pencil size={10} className="opacity-0 group-hover:opacity-60" />
                  </button>
                )}
              </li>
            );
          })}
        </ol>
        {error && <p className="mt-3 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">{error}</p>}
      </div>

      <div className="border-t border-line px-4 py-3">
        {(section.current_stage === "assignment_required" || section.current_stage === "sectioned") &&
          (dirtyCount > 0 || !allAssigned) && (
            <p className="mb-2 text-xs text-amber-700">
              {dirtyCount > 0
                ? "Save all slide assignments before starting assay work."
                : "Click Save All to confirm every slide, including slides left as Extra."}
            </p>
          )}
        {section.current_stage === "stain_requested" && (
          <p className="mb-2 text-xs text-amber-700">
            Complete every applicable stain/IHC workflow step{stainingBatchIds.length > 1 ? ` for ${stainingBatchIds.length} selected sections` : ""}. Refrax and coverslipping move the slides to Ready for Imaging automatically.
          </p>
        )}
        <div className="flex items-center gap-2">
        {section.current_stage === "needs_sectioning" ? (
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => run(() => moveSection(section.id, "assignment_required"))}
          >
            <Scissors size={15} /> Mark Sectioned
          </Button>
        ) : section.current_stage === "assignment_required" || section.current_stage === "sectioned" ? (
          <Button
            variant="primary"
            className="flex-1"
            disabled={!allAssigned || dirtyCount > 0}
            title={dirtyCount > 0 || !allAssigned ? "Click Save All to confirm every slide assignment first." : "Start stain/IHC workflow and move any extras to inventory."}
            onClick={() => run(() => moveSection(section.id, "stain_requested"))}
          >
            {startActionLabel} <ChevronRight size={15} />
          </Button>
        ) : section.current_stage === "stain_requested" ? (
          <Button
            variant="primary"
            className="flex-1"
            disabled
            title="Complete all stain/IHC checklist steps to continue automatically."
          >
            <CheckCircle2 size={15} /> Workflow In Progress
          </Button>
        ) : section.current_stage === "ready_for_imaging" && hasAssaySlides ? (
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => run(() => completeSectionImaging(imagingBatchIds))}
          >
            <CheckCircle2 size={15} /> {imagingBatchIds.length > 1 ? `Complete Imaging (${imagingBatchIds.length})` : "Complete Imaging"}
          </Button>
        ) : section.current_stage === "ready_for_imaging" ? (
          <Button variant="subtle" className="flex-1" disabled title="All slides were confirmed as Extra; no imaging workflow is required.">
            <CheckCircle2 size={15} /> Extra Slides Confirmed
          </Button>
        ) : section.current_stage === "stained" ? (
          <Button variant="primary" className="flex-1" onClick={() => run(() => moveSection(section.id, "ready_for_imaging"))}>
            <CheckCircle2 size={15} /> Ready for Imaging
          </Button>
        ) : (
          <Button variant="primary" className="flex-1" onClick={() => run(() => Promise.all(analysisBatchIds.map((id) => markSectionAnalyzed(id))))}>
            <CheckCircle2 size={15} /> {analysisBatchIds.length > 1 ? `Mark Analyzed (${analysisBatchIds.length})` : "Mark Analyzed"}
          </Button>
        )}
        <Button
          variant="danger"
          onClick={() => {
            if (confirm("Delete this section? You can undo this.")) {
              removeSection(section.id);
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
