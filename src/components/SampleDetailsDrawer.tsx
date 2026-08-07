import { useState } from "react";
import { Archive, CheckCircle2, Pencil, Scissors, Trash2, X } from "lucide-react";
import type { Sample, Slide } from "../lib/types";
import {
  BLOCK_TIMELINE_STAGES,
  SECTION_STAGE_LABELS,
  STAGE_LABELS,
  STAGE_ORDER,
} from "../lib/stages";
import { Button } from "./ui";
import { PreprocessingChecklist } from "./PreprocessingChecklist";
import { SectioningPlanDialog } from "./SectioningPlanDialog";
import { RemovalReasonDialog } from "./RemovalReasonDialog";
import { useActions } from "../hooks/useActions";
import { parsePreselectedStains, pendingStainNames } from "../lib/db";
import { useAssayCatalog, useSampleSlides, useSampleTimelineEvents } from "../hooks/useData";
import { cn, displayCode } from "../lib/utils";
import { useReadOnly } from "../lib/readOnly";

export function SampleDetailsDrawer({
  sample,
  selectedSamples = [sample],
  onRequestProcessing,
  width = 320,
  onClose,
}: {
  sample: Sample;
  selectedSamples?: Sample[];
  onRequestProcessing: (sampleIds: number[]) => void;
  width?: number;
  onClose: () => void;
}) {
  const {
    moveSamples,
    removeSamples,
    saveSectioningPlan,
    sendPlansToCutting,
    setExhausted,
    setExhaustedSamples,
    editTimestamp,
    requestStain,
    editSampleDescription,
  } = useActions();
  // Viewers mirror the workstation read-only; the write controls below are
  // hidden rather than left to fail silently (#72).
  const readOnly = useReadOnly();
  const { data: timelineEvents = [] } = useSampleTimelineEvents(sample.id);
  const { data: catalog = [] } = useAssayCatalog();
  const { data: sampleSlides = [] } = useSampleSlides(sample.id);
  const [showSectioning, setShowSectioning] = useState(false);
  const [showRemoval, setShowRemoval] = useState(false);
  const [editingColumn, setEditingColumn] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [requestAgent, setRequestAgent] = useState("");
  const [requestFlash, setRequestFlash] = useState<string | null>(null);
  const [requestFailed, setRequestFailed] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");

  const showPreprocessing =
    (STAGE_ORDER[sample.current_stage] ?? 99) <= STAGE_ORDER["processing_started"];
  const isPreprocessing = (STAGE_ORDER[sample.current_stage] ?? 99) < STAGE_ORDER.processing_started;
  const processingSelection = selectedSamples.filter(
    (selected) => (STAGE_ORDER[selected.current_stage] ?? 99) < STAGE_ORDER.processing_started,
  );
  const processingSamples = processingSelection.length > 0 ? processingSelection : [sample];
  const processingReady = processingSamples.every(
    (selected) =>
      (selected.needs_decalcification !== 1 || Boolean(selected.decalc_completed_at)) &&
      Boolean(selected.fixative_placed_at) &&
      Boolean(selected.fixative_removed_at) &&
      Boolean(selected.ethanol_placed_at),
  );
  const preprocessingSamples = selectedSamples.filter(
    (selected) => (STAGE_ORDER[selected.current_stage] ?? 99) < STAGE_ORDER.processing_started,
  );
  // Agents asked for that no cut has produced yet (#100) — intake choices and
  // properly-submitted requests both land here.
  const pendingAgents = parsePreselectedStains(sample.pending_stains);
  const isEmbedded = sample.current_stage === "embedded";
  const selectedGroup = selectedSamples.length > 0 ? selectedSamples : [sample];
  // What Delete acts on: the multi-selection if there is one, else this block
  // (#96 — was archiveTargets, same set).
  const removeTargets = selectedGroup.map((selected) => selected.id);
  const removeWhat =
    removeTargets.length > 1
      ? `${removeTargets.length} selected samples`
      : displayCode(sample.sample_code);
  const deleteLabel = `Delete ${removeWhat}`;
  const selectedEmbedded = selectedGroup.filter((selected) => selected.current_stage === "embedded");
  const needsEmbedding = sample.current_stage === "needs_embedding";

  function beginEdit(column: string, current: string | null) {
    setEditingColumn(column);
    setDraft(current ? current.replace(" ", "T") : "");
  }

  async function commitEdit(column: string) {
    const value = draft ? draft.replace("T", " ").slice(0, 16) : null;
    await editTimestamp(sample.id, column, value);
    setEditingColumn(null);
  }

  return (
    <div className="flex h-full shrink-0 flex-col border-l border-line bg-panel" style={{ width }}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="text-base font-semibold text-ink">{displayCode(sample.sample_code)}</h2>
          <p className="text-xs text-ink-faint">
            {sample.project_name} · {sample.processing_type} · {sample.fixative_agent}
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
        {/* The preprocessing checklist is the first thing a viewer reaches for,
            and it used to be entirely ungated — clicking "Placed in fixative"
            simply did nothing (#72). */}
        {showPreprocessing && readOnly && (
          <p className="mb-3 rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] text-ink-faint">
            Read-only viewer — the preprocessing checklist is completed on the workstation.
          </p>
        )}
        {showPreprocessing && !readOnly && (
          <>
            {preprocessingSamples.length > 1 && (
              <p className="mb-2 rounded-md bg-brand/10 px-2 py-1.5 text-xs font-medium text-brand">
                Applying checklist actions to {preprocessingSamples.length} selected samples
              </p>
            )}
            <PreprocessingChecklist
              samples={preprocessingSamples.length > 0 ? preprocessingSamples : [sample]}
              onCheck={(stageKey, sampleIds) => moveSamples(sampleIds, stageKey)}
            />
          </>
        )}

        {/* No project switcher (#99). Moving a block between projects re-numbered
            it and rewrote every slide label — a lot of machinery hanging off a
            dropdown sitting one mis-click away from the checklist, for something
            that should be got right at intake. The block's project is still
            shown, as a read, in the drawer header. */}

        {/* Descriptions are typed in a hurry at intake and often need correcting
            later (#79). The first cut of this shipped as a 12px faint pencil beside
            the heading and users could not find it at all — the description just
            looked like static text. Now the value itself is the control: a bordered,
            hoverable row with a visible "Edit" label, so it reads as a field. */}
        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Description
            </h3>
          </div>
          {editingDescription ? (
            <div>
              <textarea
                aria-label="Sample description"
                autoFocus
                rows={2}
                value={descriptionDraft}
                onChange={(event) => setDescriptionDraft(event.target.value)}
                className="w-full rounded-md border border-line bg-panel px-2 py-1 text-xs text-ink outline-none focus:border-brand"
              />
              <div className="mt-1 flex gap-1">
                <Button
                  className="px-2 py-0.5 text-[11px]"
                  onClick={() => {
                    // One column, not a whole NewSampleInput — see
                    // editSampleDescription in useActions.
                    void editSampleDescription(sample.id, descriptionDraft);
                    setEditingDescription(false);
                  }}
                >
                  Save
                </Button>
                <Button
                  variant="subtle"
                  className="px-2 py-0.5 text-[11px]"
                  onClick={() => setEditingDescription(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : readOnly ? (
            <p className="text-xs text-ink-soft">
              {sample.sample_description || <span className="text-ink-faint">No description</span>}
            </p>
          ) : (
            <button
              type="button"
              aria-label="Edit description"
              title="Click to edit this sample's description"
              onClick={() => {
                setDescriptionDraft(sample.sample_description ?? "");
                setEditingDescription(true);
              }}
              className="group flex w-full items-start justify-between gap-2 rounded-md border border-line bg-white px-2 py-1.5 text-left transition hover:border-brand/60 hover:bg-brand/5"
            >
              <span className="min-w-0 flex-1 text-xs text-ink-soft">
                {sample.sample_description || (
                  <span className="text-ink-faint">Add a description…</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-ink-faint group-hover:text-brand">
                <Pencil size={11} /> Edit
              </span>
            </button>
          )}
        </div>
        {sample.needs_decalcification === 1 && !sample.decalc_completed_at && isPreprocessing && (
          <p className="mb-3 inline-block rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
            Requires decalcification
          </p>
        )}
        {/* Stains / IHC — a LIVE list, one line per entry (#100, #101).
            It used to be `sample.stains`: the comma-joined string typed at
            intake, frozen for ever. Adding a stain here, or a viewer properly
            requesting one, changed nothing on screen, so the panel disagreed
            with the board. It now lists what actually exists — every slide
            carrying an agent, with the state that slide is in — plus every agent
            asked for that has not been cut yet. */}
        <StainList sampleSlides={sampleSlides} pending={pendingAgents} legacy={sample.stains} />
        {sample.cut_notes && <Section title="Cut Notes">{sample.cut_notes}</Section>}
        {sample.slide_notes && <Section title="Slide Notes">{sample.slide_notes}</Section>}
        {sample.overall_notes && <Section title="General Notes">{sample.overall_notes}</Section>}

        {/* Cutting and stain requests are workstation actions. A viewer sees the
            cutting plan and existing tags, but cannot drive the bench (#72). */}
        {readOnly ? (
          <div className="mb-4">
            {/* Which stains this block is WAITING ON is a read, and one a viewer
                needs in order to decide whether to request anything. The first
                pass buried it inside the workstation-only block below, so
                viewers lost it (#72). */}
            {sample.pending_stains && (
              <p className="mb-1 text-[11px] text-brand">
                Awaiting stains: {pendingStainNames(sample.pending_stains)}
              </p>
            )}
            <p className="rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] text-ink-faint">
              Read-only viewer — cutting and stain requests are made on the workstation.
              Use <span className="font-medium text-ink-soft">Request stain</span> in the header to ask for one.
            </p>
          </div>
        ) : (
        <>
        <div className="mb-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Cutting
          </h3>
          {/* "Send for Cutting" only where you can actually send (#98): in the
              Embedded Inventory. Everywhere earlier the same dialog is a plan
              you are drafting for later, and calling it a send made technicians
              click it expecting a cut. */}
          <Button variant="subtle" className="w-full justify-center" onClick={() => setShowSectioning(true)}>
            <Scissors size={13} /> {isEmbedded ? "Send for Cutting" : "Cutting Plan"}
          </Button>
          {sample.pending_stains && (
            <p className="mt-1 text-[11px] text-brand">
              Stains preselected ({pendingStainNames(sample.pending_stains)}) — the cut is prefilled and ready.
            </p>
          )}
        </div>

        <div className="mb-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Add a Stain
          </h3>
          <div className="flex items-center gap-2">
            <select
              value={requestAgent}
              onChange={(e) => setRequestAgent(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-line bg-white px-2 py-1.5 text-sm outline-none focus:border-brand"
            >
              <option value="">Choose an agent…</option>
              {catalog.map((a) => (
                <option key={`${a.assay_type}::${a.name}`} value={`${a.assay_type}::${a.name}`}>
                  {a.name} ({a.assay_type})
                </option>
              ))}
            </select>
            <Button
              variant="subtle"
              className="px-2 py-1"
              disabled={!requestAgent}
              onClick={async () => {
                const [assayType, assayName] = requestAgent.split("::");
                // The request can be legitimately refused — e.g. an exhausted
                // block with no extras left to fulfil it (#70). Surface the
                // reason instead of failing silently.
                try {
                  const result = await requestStain(sample.id, assayType as "stain" | "ihc", assayName);
                  setRequestAgent("");
                  setRequestFailed(false);
                  setRequestFlash(
                    result.target === "extra"
                      ? `${assayName} pulled from an extra slide → now in Staining`
                      : `${assayName} flagged on the block — a new cut is needed`,
                  );
                } catch (error) {
                  setRequestFailed(true);
                  setRequestFlash(error instanceof Error ? error.message : String(error));
                }
              }}
            >
              Add
            </Button>
          </div>
          {requestFlash && (
            <p
              role={requestFailed ? "alert" : undefined}
              className={cn("mt-1 text-[11px]", requestFailed ? "text-red-600" : "text-brand")}
            >
              {requestFlash}
            </p>
          )}
        </div>
        </>
        )}

        <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Timeline
          {!readOnly && (
            <span className="ml-2 font-normal normal-case text-ink-faint/70">click a time to edit</span>
          )}
        </h3>
        <ol className="space-y-1">
          {BLOCK_TIMELINE_STAGES.map((stage) => {
            const at = (sample as unknown as Record<string, string | null>)[stage.column];
            const editing = editingColumn === stage.column;
            return (
              <li key={stage.key} className="flex items-center gap-2 text-xs">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${at ? "bg-brand" : "bg-line"}`}
                />
                <span className="flex-1 text-ink-soft">{stage.label}</span>
                {editing ? (
                  <span className="flex items-center gap-1">
                    <input
                      type="datetime-local"
                      value={draft}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      className="rounded border border-line px-1 py-0.5 text-[11px] outline-none focus:border-brand"
                    />
                    <button
                      onClick={() => commitEdit(stage.column)}
                      className="rounded bg-brand px-1.5 py-0.5 text-[11px] text-white"
                    >
                      Set
                    </button>
                    <button
                      onClick={() => {
                        setDraft("");
                        void editTimestamp(sample.id, stage.column, null).then(() =>
                          setEditingColumn(null),
                        );
                      }}
                      className="rounded px-1 py-0.5 text-[11px] text-red-600 hover:bg-red-50"
                    >
                      Clear
                    </button>
                  </span>
                ) : readOnly ? (
                  // A viewer reads the timeline; it cannot restamp it (#72).
                  <span className="px-1 text-ink-faint">{at ?? "—"}</span>
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
          {timelineEvents.map((event) => (
            <li key={`event-${event.id}`} className="mt-2 border-t border-line/70 pt-2 text-xs">
              <div className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" />
                <div className="min-w-0 flex-1">
                  <p className="text-ink-soft">{event.summary}</p>
                  <p className="mt-0.5 text-[10px] text-ink-faint">
                    {event.created_at}{event.user_name ? ` · ${event.user_name}` : " · unsigned"}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* Every control in this footer writes, so the whole bar is a workstation
          affordance (#72). */}
      {!readOnly && (
      <div className="border-t border-line px-4 py-3">
        {isPreprocessing && !processingReady && (
          <p className="mb-2 text-xs text-amber-700">
            Complete the preprocessing checklist for every selected sample before moving to the processor.
          </p>
        )}
        <div className="flex items-center gap-2">
        {isEmbedded ? (
          <Button
            variant="subtle"
            className="flex-1"
            title="Block is out of sample to cut — remove from Embedded Inventory"
            onClick={() => {
              const count = selectedEmbedded.length || 1;
              if (confirm(`Mark ${count === 1 ? sample.sample_code : `${count} selected samples`} exhausted? ${count === 1 ? "It leaves" : "They leave"} Embedded Inventory.`)) {
                if (selectedEmbedded.length > 1) setExhaustedSamples(selectedEmbedded.map((selected) => selected.id), true);
                else setExhausted(sample.id, true);
                onClose();
              }
            }}
          >
            <Archive size={15} /> Mark {selectedEmbedded.length > 1 ? `${selectedEmbedded.length} Exhausted` : "Exhausted"}
          </Button>
        ) : needsEmbedding ? (
          <Button
            variant="primary"
            className="flex-1"
            onClick={() =>
              void moveSamples(
                selectedSamples.filter((selected) => selected.current_stage === "needs_embedding")
                  .map((selected) => selected.id).length > 0
                  ? selectedSamples.filter((selected) => selected.current_stage === "needs_embedding")
                      .map((selected) => selected.id)
                  : [sample.id],
                "embedded",
              ).catch((error) => window.alert(String(error)))
            }
          >
            <CheckCircle2 size={15} /> Mark {selectedSamples.filter((selected) => selected.current_stage === "needs_embedding").length > 1 ? `${selectedSamples.filter((selected) => selected.current_stage === "needs_embedding").length} Embedded` : "Embedded"}
          </Button>
        ) : isPreprocessing ? (
          <Button
            variant="primary"
            className="flex-1"
            disabled={!processingReady}
            title={!processingReady ? "Complete preprocessing for every selected sample first." : "Start a run now, or plan one for a future start."}
            onClick={() => onRequestProcessing(processingSamples.map((selected) => selected.id))}
          >
            <CheckCircle2 size={15} /> Start / Plan Run{processingSamples.length > 1 ? ` (${processingSamples.length})` : ""}
          </Button>
        ) : null}
        {/* Delete, not Archive (#96). These are two different intentions and the
            board only needs one of them. Archiving is a reversible hide for a
            block you still expect to want back — it belongs in the Logs, where
            you can see what you are hiding and unhide it, and that is where it
            now lives. What the board needs is the button people reach for when a
            block should not be there at all.
            It is still not a delete in the destructive sense (#83): the block,
            its cut groups and every slide keep their rows and stay in the Logs,
            flagged, with the reason typed into the dialog. */}
        <Button
          variant="danger"
          title={deleteLabel}
          aria-label={deleteLabel}
          onClick={() => setShowRemoval(true)}
        >
          <Trash2 size={15} />
        </Button>
        </div>
      </div>
      )}

      {showRemoval && (
        <RemovalReasonDialog
          title="Remove this block"
          what={removeWhat}
          confirmLabel={removeTargets.length > 1 ? `Remove ${removeTargets.length} blocks` : "Remove block"}
          onConfirm={(reason) => {
            void removeSamples(removeTargets, reason);
            setShowRemoval(false);
            onClose();
          }}
          onClose={() => setShowRemoval(false)}
        />
      )}

      {showSectioning && (
        <SectioningPlanDialog
          sample={sample}
          catalog={catalog}
          batchSamples={selectedEmbedded}
          onSendPlans={async (entries) => {
            await sendPlansToCutting(entries);
          }}
          onSave={(sampleId, plan) => saveSectioningPlan(sampleId, plan)}
          onClose={() => setShowSectioning(false)}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        {title}
      </h3>
      <p className="whitespace-pre-wrap text-sm text-ink">{children}</p>
    </div>
  );
}

/**
 * What state a slide is actually in, for the Stains / IHC list (#101).
 *
 * `section_stage` wins over the slide's own stage when the group is still queued
 * for sectioning: the slide is planned, not cut (#95), and reporting "assigned"
 * or a staining stage there would claim work nobody has done.
 */
function slideStatus(slide: Slide): string {
  if (slide.section_stage === "needs_sectioning") return "Awaiting cut";
  if (slide.current_stage === "assigned") return "Cut — awaiting staining";
  return (
    SECTION_STAGE_LABELS[slide.current_stage] ??
    STAGE_LABELS[slide.current_stage] ??
    slide.current_stage
  );
}

/** Requested / in progress / done — the three buckets the panel is asked for. */
function statusTone(label: string): string {
  if (label === "Awaiting cut" || label === "Requested") return "text-amber-600";
  if (label === "Analyzed" || label === "Pictures Taken") return "text-ink-faint";
  return "text-brand";
}

function StainList({
  sampleSlides,
  pending,
  legacy,
}: {
  sampleSlides: Slide[];
  pending: Array<{ assay_type: string; assay_name: string }>;
  /** The frozen intake string, shown only when there is nothing live to show. */
  legacy: string;
}) {
  const withAgent = sampleSlides.filter((slide) => (slide.assay_name || slide.stain_name).trim());
  // Slide.assay_type is a narrow union, a pending request's is a plain string,
  // and the two lists merge into one — widen once, here.
  type Row = { key: string; code: string; agent: string; type: string; status: string };
  const rows: Row[] = withAgent.map((slide) => ({
    key: `slide-${slide.id}`,
    code: displayCode(slide.slide_code),
    agent: slide.assay_name || slide.stain_name,
    type: slide.assay_type,
    status: slideStatus(slide),
  }));
  // Asked for, no slide yet. `pending_stains` is exactly the outstanding
  // multiset — agents chosen at intake or requested since, minus those a cut has
  // already produced — so this is the "properly requested" half of #100.
  for (const [index, agent] of pending.entries()) {
    rows.push({
      key: `pending-${index}-${agent.assay_name}`,
      code: "",
      agent: agent.assay_name,
      type: agent.assay_type,
      status: "Requested",
    });
  }

  if (rows.length === 0) {
    // Nothing cut and nothing outstanding. A block created before this list
    // existed may still carry its intake string; show that rather than nothing.
    if (!legacy) return null;
    return <Section title="Stains / IHC">{legacy}</Section>;
  }

  return (
    <div className="mb-3">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Stains / IHC
      </h3>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.key} className="flex items-baseline gap-1.5 text-xs">
            {row.code && (
              <span className="shrink-0 font-medium tabular-nums text-ink-soft">{row.code}</span>
            )}
            <span className="min-w-0 flex-1 truncate text-ink">
              {row.agent}
              {row.type && (
                <span className="ml-1 text-[10px] uppercase text-ink-faint">{row.type}</span>
              )}
            </span>
            <span className={cn("shrink-0 text-[10px]", statusTone(row.status))}>{row.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
