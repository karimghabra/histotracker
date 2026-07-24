import { useState } from "react";
import { Archive, CheckCircle2, Pencil, Scissors, Trash2, X } from "lucide-react";
import type { Sample } from "../lib/types";
import { BLOCK_TIMELINE_STAGES, STAGE_ORDER } from "../lib/stages";
import { Button } from "./ui";
import { PreprocessingChecklist } from "./PreprocessingChecklist";
import { SectioningPlanDialog } from "./SectioningPlanDialog";
import { useActions } from "../hooks/useActions";
import { useAssayCatalog, useSampleTimelineEvents } from "../hooks/useData";

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
    removeSample,
    removeSamples,
    saveSectioningPlan,
    sendSectionsToCuttingForSamples,
    setExhausted,
    setExhaustedSamples,
    editTimestamp,
    requestStain,
  } = useActions();
  const { data: timelineEvents = [] } = useSampleTimelineEvents(sample.id);
  const { data: catalog = [] } = useAssayCatalog();
  const [showSectioning, setShowSectioning] = useState(false);
  const [editingColumn, setEditingColumn] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [requestAgent, setRequestAgent] = useState("");
  const [requestFlash, setRequestFlash] = useState<string | null>(null);

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
  const isEmbedded = sample.current_stage === "embedded";
  const selectedGroup = selectedSamples.length > 0 ? selectedSamples : [sample];
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
          <h2 className="text-base font-semibold text-ink">{sample.sample_code}</h2>
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
        {showPreprocessing && (
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

        {sample.sample_description && (
          <Section title="Description">{sample.sample_description}</Section>
        )}
        {sample.needs_decalcification === 1 && !sample.decalc_completed_at && isPreprocessing && (
          <p className="mb-3 inline-block rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
            Requires decalcification
          </p>
        )}
        {sample.stains && <Section title="Stains / IHC">{sample.stains}</Section>}
        {sample.cut_notes && <Section title="Cut Notes">{sample.cut_notes}</Section>}
        {sample.slide_notes && <Section title="Slide Notes">{sample.slide_notes}</Section>}
        {sample.overall_notes && <Section title="General Notes">{sample.overall_notes}</Section>}

        <div className="mb-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Cutting
          </h3>
          <Button variant="subtle" className="w-full justify-center" onClick={() => setShowSectioning(true)}>
            <Scissors size={13} /> Send for Cutting
          </Button>
          {sample.pending_stains && (
            <p className="mt-1 text-[11px] text-brand">
              Stains preselected ({sample.pending_stains}) — the cut is prefilled and ready.
            </p>
          )}
        </div>

        <div className="mb-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Request a Stain
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
                const result = await requestStain(sample.id, assayType as "stain" | "ihc", assayName);
                setRequestAgent("");
                setRequestFlash(
                  result.target === "extra"
                    ? `${assayName} pulled from an extra slide → now in Staining`
                    : `${assayName} flagged on the block — a new cut is needed`,
                );
              }}
            >
              Request
            </Button>
          </div>
          {requestFlash && <p className="mt-1 text-[11px] text-brand">{requestFlash}</p>}
        </div>

        <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Timeline
          <span className="ml-2 font-normal normal-case text-ink-faint/70">click a time to edit</span>
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
            title={!processingReady ? "Complete preprocessing for every selected sample first." : "Review and start a processing batch."}
            onClick={() => onRequestProcessing(processingSamples.map((selected) => selected.id))}
          >
            <CheckCircle2 size={15} /> Move {processingSamples.length > 1 ? `${processingSamples.length} to Processor` : "to Processor"}
          </Button>
        ) : null}
        <Button
          variant="danger"
          onClick={() => {
            const deleteTargets = selectedGroup.map((selected) => selected.id);
            if (confirm(`Delete ${deleteTargets.length === 1 ? sample.sample_code : `${deleteTargets.length} selected samples`}? You can undo this.`)) {
              if (deleteTargets.length > 1) removeSamples(deleteTargets);
              else removeSample(sample.id);
              onClose();
            }
          }}
        >
          <Trash2 size={15} />
        </Button>
        </div>
      </div>

      {showSectioning && (
        <SectioningPlanDialog
          sample={sample}
          catalog={catalog}
          batchCount={selectedEmbedded.length > 1 ? selectedEmbedded.length : 1}
          onSave={(plan) => saveSectioningPlan(sample.id, plan)}
          onSend={async (groups) => {
            const targets =
              selectedEmbedded.length > 1 ? selectedEmbedded.map((s) => s.id) : [sample.id];
            await sendSectionsToCuttingForSamples(targets, groups);
          }}
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
