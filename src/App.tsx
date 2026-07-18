import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudOff, Download, FileSpreadsheet, FileText, Inbox, Loader2, LogOut, Palette, Plus, RefreshCcwDot, RefreshCw, Redo2, Send, Settings, Undo2, Users } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { Board } from "./components/Board";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { NewSampleDialog } from "./components/NewSampleDialog";
import { SampleDetailsDrawer } from "./components/SampleDetailsDrawer";
import { SectionDetailsDrawer } from "./components/SectionDetailsDrawer";
import { BatchStartDialog } from "./components/BatchStartDialog";
import { ProcessingBatchDetailsDrawer } from "./components/ProcessingBatchDetailsDrawer";
import { ExtraSlideDetailsDrawer } from "./components/ExtraSlideDetailsDrawer";
import { UserManagerDialog } from "./components/UserManagerDialog";
import { SetupScreen } from "./components/SetupScreen";
import { RequestStainDialog } from "./components/RequestStainDialog";
import { RequestsInbox } from "./components/RequestsInbox";
import { Button } from "./components/ui";
import { useActiveUser, useAssayCatalog, useExtraSlides, useOpenSamples, useOpenSections, useProcessingBatches, useProjects, useStainRequests, useStainRequestMutations, useUserMutations, useUsers } from "./hooks/useData";
import { useActions } from "./hooks/useActions";
import { useSync } from "./hooks/useSync";
import { useUndoStore } from "./lib/undo";
import { autoAdvanceProcessingRuns, setViewerReadOnly } from "./lib/db";
import { getSyncConfig, type SyncConfigPublic } from "./lib/syncConfig";
import { exportSamplesCsv, exportWorkbookXlsx } from "./lib/export";

export default function App() {
  const qc = useQueryClient();
  const { data: projects = [] } = useProjects(true);
  const { data: samples = [] } = useOpenSamples();
  const { data: sections = [] } = useOpenSections();
  const { data: batches = [] } = useProcessingBatches();
  const { data: extraSlides = [] } = useExtraSlides();
  const { data: users = [] } = useUsers();
  const { data: activeUser = null } = useActiveUser();
  const { data: assayCatalog = [] } = useAssayCatalog();
  const { select: selectUser } = useUserMutations();
  const { moveSamples, moveSections, startProcessingBatch, moveProcessingBatch, editBatchStart, togglePriority, undo, redo } = useActions();
  const undoDepth = useUndoStore((s) => s.undoStack.length);
  const redoDepth = useUndoStore((s) => s.redoStack.length);

  // ---- Shared-data sync -----------------------------------------------------
  const { data: syncConfig } = useQuery({ queryKey: ["sync-config"], queryFn: getSyncConfig });
  const isViewer = syncConfig?.role === "viewer";
  const sync = useSync(syncConfig ?? null);
  const { data: stainRequests = [] } = useStainRequests();
  const { setStatus: setRequestStatus } = useStainRequestMutations();
  const openRequestCount = useMemo(
    () => stainRequests.filter((r) => r.status === "requested").length,
    [stainRequests],
  );

  // Data-layer backstop: block writes on viewer installs.
  useEffect(() => {
    if (syncConfig) setViewerReadOnly(syncConfig.role === "viewer");
  }, [syncConfig]);

  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedSampleId, setSelectedSampleId] = useState<number | null>(null);
  const [selectedSampleIds, setSelectedSampleIds] = useState<number[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(null);
  const [selectedSectionIds, setSelectedSectionIds] = useState<number[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [selectedExtraSampleId, setSelectedExtraSampleId] = useState<number | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewSample, setShowNewSample] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [showRequests, setShowRequests] = useState(false);
  const [showRequestStain, setShowRequestStain] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [pendingBatchSampleIds, setPendingBatchSampleIds] = useState<number[] | null>(null);
  const [theme, setTheme] = useState(
    () => window.localStorage.getItem("histometer-theme") ?? "system",
  );
  const [drawerWidth, setDrawerWidth] = useState(
    () => Number(window.localStorage.getItem("histometer-drawer-width") ?? "416"),
  );
  const [status, setStatus] = useState<string | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  function flash(message: string) {
    setStatus(message);
    window.setTimeout(() => setStatus((s) => (s === message ? null : s)), 4000);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("histometer-theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem("histometer-drawer-width", String(drawerWidth));
  }, [drawerWidth]);

  useEffect(() => {
    if (activeUser) window.localStorage.setItem("histometer-active-operator", activeUser.name);
  }, [activeUser]);

  // Default the sidebar selection to the first active project.
  useEffect(() => {
    if (selectedProjectId === null && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  // Timed processing auto-advance on mount and every minute.
  useEffect(() => {
    const tick = async () => {
      const moved = await autoAdvanceProcessingRuns();
      if (moved > 0) {
        qc.invalidateQueries({ queryKey: ["open-samples"] });
        qc.invalidateQueries({ queryKey: ["processing-batches"] });
      }
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [qc]);

  // Global undo/redo shortcuts (ignored while typing in a field).
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        const label = await undo();
        flash(label ? `Undone: ${label}` : "Nothing to undo");
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        const label = await redo();
        flash(label ? `Redone: ${label}` : "Nothing to redo");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Close the export menu on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const selectedSample = useMemo(
    () => samples.find((s) => s.id === selectedSampleId) ?? null,
    [samples, selectedSampleId],
  );
  const selectedSection = useMemo(
    () => sections.find((s) => s.id === selectedSectionId) ?? null,
    [sections, selectedSectionId],
  );
  const selectedBatch = useMemo(
    () => batches.find((batch) => batch.id === selectedBatchId) ?? null,
    [batches, selectedBatchId],
  );
  const selectedExtraSlides = useMemo(
    () => extraSlides.filter((slide) => slide.sample_id === selectedExtraSampleId),
    [extraSlides, selectedExtraSampleId],
  );
  const pendingBatchSamples = useMemo(
    () =>
      pendingBatchSampleIds
        ? samples.filter((sample) => pendingBatchSampleIds.includes(sample.id))
        : [],
    [pendingBatchSampleIds, samples],
  );
  const requestSampleCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const sample of samples) codes.add(sample.sample_code);
    for (const section of sections) if (section.parent_code) codes.add(section.parent_code);
    return [...codes].sort();
  }, [samples, sections]);
  const requestAssayNames = useMemo(() => assayCatalog.map((entry) => entry.name), [assayCatalog]);

  // Surface background sync failures without stealing focus.
  useEffect(() => {
    if (sync.error) flash(`Sync error: ${sync.error}`);
  }, [sync.error]);

  const selectSample = (id: number) => {
    setSelectedSectionId(null);
    setSelectedBatchId(null);
    setSelectedExtraSampleId(null);
    setSelectedSampleId(id);
  };
  const selectSection = (id: number) => {
    setSelectedSampleId(null);
    setSelectedBatchId(null);
    setSelectedExtraSampleId(null);
    setSelectedSectionId(id);
  };

  const selectExtraSlideSample = (sampleId: number) => {
    setSelectedSampleId(null);
    setSelectedSectionId(null);
    setSelectedBatchId(null);
    setSelectedExtraSampleId(sampleId);
  };

  function moveBatchWithConfirmation(batchId: number, stageKey: string) {
    const batch = batches.find((candidate) => candidate.id === batchId);
    if (
      stageKey === "processed" &&
      batch?.current_stage === "processing_started" &&
      !window.confirm(
        "This batch is still processing. Are you sure you want to stop waiting and move it to Processor Pickup early?",
      )
    ) {
      return;
    }
    void moveProcessingBatch(batchId, stageKey).catch((error) => flash(String(error)));
  }

  async function runExport(kind: "csv" | "xlsx") {
    setShowExportMenu(false);
    try {
      const path =
        kind === "csv" ? await exportSamplesCsv() : await exportWorkbookXlsx();
      flash(path ? `Exported to ${path}` : "Export cancelled");
    } catch (e) {
      flash(`Export failed: ${e}`);
    }
  }

  function startDrawerResize() {
    const onMove = (event: globalThis.MouseEvent) => {
      const next = window.innerWidth - event.clientX;
      setDrawerWidth(Math.min(720, Math.max(320, next)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const activeDrawer = selectedSample ? (
    <SampleDetailsDrawer
      sample={selectedSample}
      selectedSamples={samples.filter((sample) => selectedSampleIds.includes(sample.id))}
      onRequestProcessing={setPendingBatchSampleIds}
      width={drawerWidth}
      onClose={() => setSelectedSampleId(null)}
    />
  ) : selectedSection ? (
    <SectionDetailsDrawer
      section={selectedSection}
      selectedSections={sections.filter((section) => selectedSectionIds.includes(section.id))}
      width={drawerWidth}
      onClose={() => setSelectedSectionId(null)}
    />
  ) : selectedBatch ? (
    <ProcessingBatchDetailsDrawer
      batch={selectedBatch}
      samples={samples.filter((sample) => selectedBatch.member_ids.includes(sample.id))}
      onMove={moveBatchWithConfirmation}
      onEditStart={(batchId, startedAt) =>
        void editBatchStart(batchId, startedAt).catch((error) => flash(String(error)))
      }
      width={drawerWidth}
      onClose={() => setSelectedBatchId(null)}
    />
  ) : selectedExtraSlides.length > 0 ? (
    <ExtraSlideDetailsDrawer
      slides={selectedExtraSlides}
      width={drawerWidth}
      onClose={() => setSelectedExtraSampleId(null)}
    />
  ) : null;

  const applyConfig = (config: SyncConfigPublic) => {
    qc.setQueryData(["sync-config"], config);
    setShowSetup(false);
  };

  // Gate the app on sync configuration: unconfigured installs run onboarding.
  if (syncConfig === undefined) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-surface text-ink-faint">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }
  if (!syncConfig.configured) {
    return <SetupScreen initial={syncConfig} onConfigured={applyConfig} />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={setSelectedProjectId}
        onAddProject={() => setShowNewProject(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col bg-surface">
        <header className="flex items-center justify-between border-b border-line bg-panel px-6 py-3">
          <div>
            <h1 className="text-lg font-semibold text-ink">Open Histology Workflow</h1>
            <p className="text-xs text-ink-faint">
              {status ?? (
                <>
                  {samples.length} open {samples.length === 1 ? "sample" : "samples"} across{" "}
                  {projects.length} active {projects.length === 1 ? "project" : "projects"}
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SyncStatusPill
              role={syncConfig.role}
              syncing={sync.syncing}
              error={sync.error}
              lastSyncedAt={sync.lastSyncedAt}
              onSyncNow={() => void sync.syncNow()}
              onOpenSettings={() => setShowSetup(true)}
            />
            {isViewer ? (
              <>
                <Button variant="subtle" className="px-2" title="Requests you've submitted" onClick={() => setShowRequests(true)}>
                  <Inbox size={15} /> My requests
                </Button>
                <Button variant="primary" onClick={() => setShowRequestStain(true)}>
                  <Send size={16} /> Request stain
                </Button>
              </>
            ) : (
              <>
                <label
                  className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs ${activeUser ? "border-line bg-panel text-ink-soft" : "border-amber-300 bg-amber-50 text-amber-800"}`}
                  title={activeUser ? "Changes are attributed to this user" : "Changes will be recorded as unsigned"}
                >
                  <Users size={14} />
                  <select
                    aria-label="Signed-in user"
                    value={activeUser?.id ?? ""}
                    onChange={(event) => selectUser.mutate(event.target.value ? Number(event.target.value) : null)}
                    className="max-w-36 bg-transparent text-xs text-inherit outline-none"
                  >
                    <option value="">Not signed in</option>
                    {users.filter((user) => user.is_active).map((user) => (
                      <option key={user.id} value={user.id}>{user.name}</option>
                    ))}
                  </select>
                </label>
                {activeUser && (
                  <Button variant="ghost" className="px-2" title="Sign out" onClick={() => selectUser.mutate(null)}>
                    <LogOut size={15} />
                  </Button>
                )}
                <Button variant="subtle" className="px-2" title="Manage lab users" onClick={() => setShowUsers(true)}>
                  <Users size={15} /> Users
                </Button>
                <Button variant="subtle" className="relative px-2" title="Incoming stain requests" onClick={() => setShowRequests(true)}>
                  <Inbox size={15} /> Requests
                  {openRequestCount > 0 && (
                    <span className="ml-1 rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      {openRequestCount}
                    </span>
                  )}
                </Button>
              </>
            )}
            <label className="flex items-center gap-1 rounded-lg border border-line bg-panel px-2 py-1 text-xs text-ink-soft">
              <Palette size={14} />
              <select
                aria-label="Visual theme"
                value={theme}
                onChange={(event) => setTheme(event.target.value)}
                className="theme-select bg-transparent text-xs text-ink outline-none"
              >
                <option value="system">◐ System</option>
                <option value="light">☀ Clinical Light</option>
                <option value="dark">☾ Night Shift</option>
                <option value="contrast">☾ High Contrast</option>
                <option value="ocean">☀ Ocean Glass</option>
                <option value="forest">☀ Forest Bench</option>
                <option value="lavender">☀ Lavender Haze</option>
                <option value="rose">☀ Rose Quartz</option>
                <option value="sunset">☀ Sunset Agar</option>
                <option value="mint">☀ Mint Cleanroom</option>
                <option value="solarized">☀ Solarized Slide</option>
                <option value="arctic">☀ Arctic Bloom</option>
                <option value="sakura">☀ Sakura Lab</option>
                <option value="citrus">☀ Citrus Pop</option>
                <option value="parchment">☀ Parchment</option>
                <option value="candy">☀ Candy Microscope</option>
                <option value="blueprint">☾ Blueprint</option>
                <option value="mocha">☾ Mocha Microscope</option>
                <option value="cobalt">☾ Cobalt Night</option>
                <option value="aubergine">☾ Aubergine</option>
                <option value="deepsea">☾ Deep Sea</option>
                <option value="evergreen">☾ Evergreen Night</option>
                <option value="neon">☾ Neon Culture</option>
                <option value="graphite">☾ Graphite</option>
                <option value="terminal">☾ Retro Terminal</option>
              </select>
            </label>
            {!isViewer && (
              <div className="flex items-center gap-1">
                <Button
                  variant="subtle"
                  className="px-2"
                  title="Undo (Ctrl+Z)"
                  disabled={undoDepth === 0}
                  onClick={() => undo().then((l) => flash(l ? `Undone: ${l}` : ""))}
                >
                  <Undo2 size={15} />
                </Button>
                <Button
                  variant="subtle"
                  className="px-2"
                  title="Redo (Ctrl+Y)"
                  disabled={redoDepth === 0}
                  onClick={() => redo().then((l) => flash(l ? `Redone: ${l}` : ""))}
                >
                  <Redo2 size={15} />
                </Button>
              </div>
            )}

            <div className="relative" ref={exportRef}>
              <Button variant="subtle" onClick={() => setShowExportMenu((v) => !v)}>
                <Download size={15} /> Export
              </Button>
              {showExportMenu && (
                <div className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-xl border border-line bg-panel shadow-xl">
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-ink hover:bg-surface"
                    onClick={() => runExport("xlsx")}
                  >
                    <FileSpreadsheet size={15} className="text-emerald-600" /> Excel workbook (.xlsx)
                  </button>
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-ink hover:bg-surface"
                    onClick={() => runExport("csv")}
                  >
                    <FileText size={15} className="text-sky-600" /> Samples CSV (.csv)
                  </button>
                </div>
              )}
            </div>

            {!isViewer && (
              <Button
                variant="primary"
                disabled={!selectedProject}
                onClick={() => setShowNewSample(true)}
              >
                <Plus size={16} /> New Sample
              </Button>
            )}
            <Button
              variant="subtle"
              className="px-2"
              title="Refresh"
              onClick={() => {
                qc.invalidateQueries({ queryKey: ["projects"] });
                qc.invalidateQueries({ queryKey: ["open-samples"] });
                qc.invalidateQueries({ queryKey: ["open-sections"] });
                qc.invalidateQueries({ queryKey: ["processing-batches"] });
              }}
            >
              <RefreshCw size={15} />
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-hidden p-3">
            <Board
              samples={samples}
              sections={sections}
              batches={batches}
              extraSlides={extraSlides}
              selectedSampleId={selectedSampleId}
              selectedSectionId={selectedSectionId}
              onSelectSample={selectSample}
              onSampleSelectionChange={setSelectedSampleIds}
              onSelectSection={selectSection}
              onSectionSelectionChange={setSelectedSectionIds}
              onSelectExtraSlideSample={selectExtraSlideSample}
              onMoveSamples={(sampleIds, stageKey) => {
                void moveSamples(sampleIds, stageKey).catch((error) => flash(String(error)));
              }}
              onMoveSections={(sectionIds, stageKey) => {
                void moveSections(sectionIds, stageKey).catch((error) => flash(String(error)));
              }}
              onRequestProcessingBatch={setPendingBatchSampleIds}
              onMoveProcessingBatch={(batchId, stageKey) => {
                moveBatchWithConfirmation(batchId, stageKey);
              }}
              onSelectProcessingBatch={(batchId) => {
                setSelectedSampleId(null);
                setSelectedSectionId(null);
                setSelectedExtraSampleId(null);
                setSelectedBatchId(batchId);
              }}
              onToggleSamplePriority={(sampleId) => {
                void togglePriority(sampleId).catch((error) => flash(String(error)));
              }}
              readOnly={isViewer}
            />
          </div>
          {activeDrawer && (
            <>
              <div
                className="group flex w-3 shrink-0 cursor-col-resize items-center justify-center bg-panel/30"
                role="separator"
                aria-orientation="vertical"
                title="Drag to resize details panel"
                onMouseDown={startDrawerResize}
              >
                <div className="h-16 w-1 rounded-full bg-line transition group-hover:bg-brand/60" />
              </div>
              {activeDrawer}
            </>
          )}
        </div>
      </main>

      {showNewProject && <NewProjectDialog users={users.filter((user) => user.is_active)} onClose={() => setShowNewProject(false)} />}
      {showUsers && <UserManagerDialog users={users} activeUser={activeUser} onClose={() => setShowUsers(false)} />}
      {showNewSample && selectedProject && (
        <NewSampleDialog project={selectedProject} onClose={() => setShowNewSample(false)} />
      )}
      {pendingBatchSampleIds && pendingBatchSamples.length > 0 && (
        <BatchStartDialog
          samples={pendingBatchSamples}
          activeOperator={activeUser?.name ?? ""}
          onStart={async (input) => {
            await startProcessingBatch(input);
            flash(`Started ${input.processingType.toLowerCase()} batch · ${input.sampleIds.length} samples`);
          }}
          onClose={() => setPendingBatchSampleIds(null)}
        />
      )}
      {showRequests && (
        <RequestsInbox
          title={isViewer ? "Requests" : "Stain requests"}
          requests={stainRequests}
          mineFilterName={isViewer ? syncConfig.operator_name : undefined}
          onSetStatus={
            isViewer
              ? undefined
              : (id, status) =>
                  setRequestStatus.mutate({
                    id,
                    status,
                    resolvedBy: syncConfig.operator_name,
                  })
          }
          onClose={() => setShowRequests(false)}
        />
      )}
      {showRequestStain && (
        <RequestStainDialog
          operatorName={syncConfig.operator_name}
          sampleCodes={requestSampleCodes}
          assayNames={requestAssayNames}
          onSubmitted={(message) => flash(message)}
          onClose={() => setShowRequestStain(false)}
        />
      )}
      {showSetup && (
        <SetupScreen
          initial={syncConfig}
          onConfigured={applyConfig}
          onCancel={() => setShowSetup(false)}
        />
      )}
    </div>
  );
}

// Compact sync indicator + manual "Sync now" + settings entry.
function SyncStatusPill({
  role,
  syncing,
  error,
  lastSyncedAt,
  onSyncNow,
  onOpenSettings,
}: {
  role: string;
  syncing: boolean;
  error: string | null;
  lastSyncedAt: Date | null;
  onSyncNow: () => void;
  onOpenSettings: () => void;
}) {
  const label = syncing
    ? "Syncing…"
    : error
      ? "Sync error"
      : lastSyncedAt
        ? `Synced ${lastSyncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : "Not synced yet";
  const tone = error
    ? "border-red-300 bg-red-50 text-red-700"
    : "border-line bg-panel text-ink-soft";
  return (
    <div className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs ${tone}`}>
      <span className="font-medium capitalize">{role}</span>
      <span className="text-ink-faint">·</span>
      <span title={error ?? undefined}>{label}</span>
      <button
        onClick={onSyncNow}
        disabled={syncing}
        title="Sync now"
        className="ml-0.5 rounded p-0.5 text-ink-faint hover:bg-black/5 hover:text-ink disabled:opacity-50"
      >
        {syncing ? <Loader2 size={13} className="animate-spin" /> : error ? <CloudOff size={13} /> : <RefreshCcwDot size={13} />}
      </button>
      <button
        onClick={onOpenSettings}
        title="Sync settings"
        className="rounded p-0.5 text-ink-faint hover:bg-black/5 hover:text-ink"
      >
        <Settings size={13} />
      </button>
    </div>
  );
}
