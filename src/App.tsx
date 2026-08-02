import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudOff, DatabaseBackup, Download, FileSpreadsheet, FileText, Inbox, Loader2, LogOut, Palette, Plus, RefreshCcwDot, RefreshCw, Redo2, Send, Settings, Undo2, Users } from "lucide-react";
import { Sidebar, type AppView } from "./components/Sidebar";
import { LogsView } from "./components/LogsView";
import { Board } from "./components/Board";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { NewSampleDialog } from "./components/NewSampleDialog";
import { SampleDetailsDrawer } from "./components/SampleDetailsDrawer";
import { SectionDetailsDrawer } from "./components/SectionDetailsDrawer";
import { StackDetailsDrawer } from "./components/StackDetailsDrawer";
import { BatchStartDialog } from "./components/BatchStartDialog";
import { ProcessingBatchDetailsDrawer } from "./components/ProcessingBatchDetailsDrawer";
import { ExtraSlideDetailsDrawer } from "./components/ExtraSlideDetailsDrawer";
import { ManageDialog } from "./components/ManageDialog";
import { BackupsDialog } from "./components/BackupsDialog";
import { SetupScreen } from "./components/SetupScreen";
import { RequestStainDialog } from "./components/RequestStainDialog";
import { ManifestView } from "./components/ManifestView";
import { ReadOnlyProvider } from "./lib/readOnly";
import { useIdleLogout } from "./hooks/useIdleLogout";
import { mergePendingRequests, prunePendingRequests } from "./lib/pendingRequests";
import { compareSampleCodes } from "./lib/utils";
import { RequestsInbox } from "./components/RequestsInbox";
import { Button, Field, Modal } from "./components/ui";
import { useActiveUser, useAllSamples, useAssayCatalog, useExtraSlides, useOpenSamples, useOpenSections, useOpenSlideStacks, useProcessingBatches, useProjects, useStainRequests, useStainRequestMutations, useUserMutations, useUsers } from "./hooks/useData";
import { useActions } from "./hooks/useActions";
import { useSync } from "./hooks/useSync";
import { useBackupScheduler } from "./hooks/useBackupScheduler";
import { useUndoStore } from "./lib/undo";
import { hydrateUndoHistory } from "./lib/undoPersist";
import { autoAdvanceProcessingRuns, setViewerReadOnly } from "./lib/db";
import { getSyncConfig, type SyncConfigPublic } from "./lib/syncConfig";
import { exportSamplesCsv, exportWorkbookXlsx } from "./lib/export";

export default function App() {
  const qc = useQueryClient();
  const { data: projects = [] } = useProjects(true);
  const { data: samples = [] } = useOpenSamples();
  const { data: allSamples = [] } = useAllSamples();
  const { data: sections = [] } = useOpenSections();
  const { data: stacks = [] } = useOpenSlideStacks();
  const { data: batches = [] } = useProcessingBatches();
  const { data: extraSlides = [] } = useExtraSlides();
  const { data: users = [] } = useUsers();
  const { data: activeUser = null } = useActiveUser();
  const { data: assayCatalog = [] } = useAssayCatalog();
  const { select: selectUser } = useUserMutations();
  const { moveSamples, moveSections, moveSlideStacks, startProcessingBatch, planProcessingBatch, confirmProcessingBatchStart, editPlannedBatchMembers, moveProcessingBatch, editBatchStart, togglePriority, undo, redo } = useActions();
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

  // Automatic local database backups — only the authoritative workstation backs
  // up (a viewer's DB is a read-only mirror). Announces scheduled/launch backups.
  useBackupScheduler(Boolean(syncConfig?.configured) && !isViewer, () =>
    flash("Database backed up"),
  );

  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedSampleId, setSelectedSampleId] = useState<number | null>(null);
  const [selectedSampleIds, setSelectedSampleIds] = useState<number[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(null);
  const [selectedSectionIds, setSelectedSectionIds] = useState<number[]>([]);
  const [selectedStackId, setSelectedStackId] = useState<number | null>(null);
  const [selectedStackIds, setSelectedStackIds] = useState<number[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [selectedExtraSampleId, setSelectedExtraSampleId] = useState<number | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewSample, setShowNewSample] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [showBackups, setShowBackups] = useState(false);
  const [showRequests, setShowRequests] = useState(false);
  const [showRequestStain, setShowRequestStain] = useState(false);
  const [requestStainCode, setRequestStainCode] = useState<string | undefined>(undefined);
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
  const [view, setView] = useState<AppView>(
    () => ((window.localStorage.getItem("histometer-view") as AppView) ?? "board"),
  );
  useEffect(() => {
    window.localStorage.setItem("histometer-view", view);
  }, [view]);
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

  // Keep the protocol-checklist operator name in step with who is signed in —
  // INCLUDING on sign-out. It used to be written but never cleared, so after an
  // idle logout the protocol steps kept recording the departed operator's name
  // (#76).
  useEffect(() => {
    if (activeUser) window.localStorage.setItem("histometer-active-operator", activeUser.name);
    else window.localStorage.removeItem("histometer-active-operator");
  }, [activeUser]);

  // #76 — the signed-in user lives in the DATABASE (app_settings.active_user_id),
  // so it survives quitting the app and rebooting the machine. On a shared bench
  // PC that meant Monday's user was still signed in on Tuesday and Tuesday's
  // work was attributed to them, with no prompt. Clear it once per launch: the
  // first thing you do each session is say who you are.
  const launchSignOutDone = useRef(false);
  useEffect(() => {
    if (launchSignOutDone.current || isViewer) return;
    if (!syncConfig?.configured) return;
    launchSignOutDone.current = true;
    if (activeUser) {
      setIdleSignedOut(activeUser.name);
      selectUser.mutate(null);
    }
  }, [syncConfig?.configured, isViewer, activeUser, selectUser]);

  // #76 — drop the session after a spell of no interaction, so the next person
  // at a shared bench machine isn't silently attributed the previous one's work.
  // Remember who it was, purely to address the sign-back-in prompt by name.
  const [idleSignedOut, setIdleSignedOut] = useState<string | null>(null);
  useIdleLogout(Boolean(activeUser) && !isViewer, () => {
    setIdleSignedOut(activeUser?.name ?? "");
    selectUser.mutate(null);
  });

  // Restore the last-used project, falling back to the first active one (#84).
  // Without persistence, every restart silently reset the sidebar to whichever
  // project happened to sort first — and the next New Sample went there.
  useEffect(() => {
    if (selectedProjectId !== null || projects.length === 0) return;
    const remembered = Number(window.localStorage.getItem("histometer-selected-project") ?? "");
    const stillExists = projects.some((project) => project.id === remembered);
    setSelectedProjectId(stillExists ? remembered : projects[0].id);
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (selectedProjectId !== null) {
      window.localStorage.setItem("histometer-selected-project", String(selectedProjectId));
    }
  }, [selectedProjectId]);

  // Restore the persisted undo/redo history (if it matches the live DB) so a
  // reload doesn't strand the user with a greyed-out Undo (#2).
  useEffect(() => {
    void hydrateUndoHistory();
  }, []);

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

  // Escape closes an open detail drawer, matching how dialogs already dismiss.
  // Skip when a modal is open (it handles its own Escape) or while typing.
  const modalOpen =
    showNewProject || showNewSample || showUsers || showBackups || showRequests || showRequestStain ||
    showSetup || pendingBatchSampleIds !== null;
  const drawerOpen =
    selectedSampleId !== null || selectedSectionId !== null || selectedStackId !== null ||
    selectedBatchId !== null || selectedExtraSampleId !== null;
  useEffect(() => {
    if (modalOpen || !drawerOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      setSelectedSampleId(null);
      setSelectedSectionId(null);
      setSelectedStackId(null);
      setSelectedBatchId(null);
      setSelectedExtraSampleId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen, drawerOpen]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const selectedSample = useMemo(
    () => samples.find((s) => s.id === selectedSampleId) ?? null,
    [samples, selectedSampleId],
  );
  const selectedSection = useMemo(
    () => sections.find((s) => s.id === selectedSectionId) ?? null,
    [sections, selectedSectionId],
  );
  const selectedStack = useMemo(
    () => stacks.find((stack) => stack.id === selectedStackId) ?? null,
    [selectedStackId, stacks],
  );
  const selectedStacks = useMemo(
    () => stacks.filter((stack) => selectedStackIds.includes(stack.id) || stack.id === selectedStackId),
    [selectedStackId, selectedStackIds, stacks],
  );
  const selectedBatch = useMemo(
    () => batches.find((batch) => batch.id === selectedBatchId) ?? null,
    [batches, selectedBatchId],
  );
  // Samples that could be added to the selected planned run (issue #32): same
  // protocol, preprocessing complete, and not already committed to a batch.
  const plannedBatchCandidates = useMemo(() => {
    if (!selectedBatch || selectedBatch.status !== "planned") return [];
    const committed = new Set(
      batches.filter((batch) => batch.id !== selectedBatch.id).flatMap((batch) => batch.member_ids),
    );
    return samples.filter(
      (s) =>
        s.processing_type === selectedBatch.processing_type &&
        !committed.has(s.id) &&
        !selectedBatch.member_ids.includes(s.id) &&
        (s.needs_decalcification !== 1 || Boolean(s.decalc_completed_at)) &&
        Boolean(s.fixative_placed_at) &&
        Boolean(s.fixative_removed_at) &&
        Boolean(s.ethanol_placed_at),
    );
  }, [selectedBatch, batches, samples]);
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
    // Numeric-aware: a plain .sort() gives EE-1, EE-10, EE-2 once codes are no
    // longer zero-padded to a fixed width (#87).
    return [...codes].sort(compareSampleCodes);
  }, [samples, sections]);
  // Exhausted blocks can't be cut again, so the request dialog refuses them (#70).
  // Sourced from ALL samples, not the open board list — listOpenSamples filters
  // exhausted blocks out, yet their code still reaches the dropdown via sections
  // that are still in flight, which is exactly the case being guarded.
  // Archived blocks are refused for the same reason (#74): the sample has been
  // deliberately taken out of circulation, so a request against it could never
  // be actioned. Both states are "not available for work", so they share the
  // dialog's guard rather than growing a second, forgettable one.
  const exhaustedSampleCodes = useMemo(
    () =>
      allSamples
        .filter((sample) => sample.block_exhausted === 1 || Boolean(sample.archived_at))
        .map((sample) => sample.sample_code),
    [allSamples],
  );

  // Once a submitted request comes back in a snapshot, drop the local echo so
  // it isn't shown twice (#71).
  useEffect(() => {
    if (isViewer) prunePendingRequests(stainRequests);
  }, [isViewer, stainRequests]);

  // Surface background sync failures without stealing focus.
  useEffect(() => {
    if (sync.error) flash(`Sync error: ${sync.error}`);
  }, [sync.error]);

  // Nothing should ever fail silently again (#72).
  //
  // Most mutations are fired as `void doThing()`, so a rejection had nowhere to
  // go: the viewer clicked a control, the data layer refused the write, and the
  // UI showed nothing at all. Rather than hunt every call site for a .catch,
  // catch the rejections themselves and flash them. This is a backstop, not a
  // licence to skip error handling — but it converts the whole class of
  // "clicked it and nothing happened" into a visible message.
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason ?? "");
      if (!message) return;
      event.preventDefault(); // handled — keep it out of the console as "unhandled"
      flash(message);
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, []);

  const selectSample = (id: number) => {
    setSelectedSectionId(null);
    setSelectedStackId(null);
    setSelectedBatchId(null);
    setSelectedExtraSampleId(null);
    setSelectedSampleId(id);
  };
  const selectSection = (id: number) => {
    setSelectedSampleId(null);
    setSelectedStackId(null);
    setSelectedBatchId(null);
    setSelectedExtraSampleId(null);
    setSelectedSectionId(id);
  };
  const selectStack = (id: number) => {
    setSelectedSampleId(null);
    setSelectedSectionId(null);
    setSelectedBatchId(null);
    setSelectedExtraSampleId(null);
    setSelectedStackId(id);
  };

  const selectExtraSlideSample = (sampleId: number) => {
    setSelectedSampleId(null);
    setSelectedSectionId(null);
    setSelectedStackId(null);
    setSelectedBatchId(null);
    setSelectedExtraSampleId(sampleId);
  };

  function moveBatchWithConfirmation(batchId: number, stageKey: string) {
    const batch = batches.find((candidate) => candidate.id === batchId);
    if (
      stageKey === "processed" &&
      batch?.current_stage === "processing_started" &&
      !window.confirm(
        "This batch is still processing. Are you sure you want to stop waiting and mark it ready for pickup early?",
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

  // `key` on every drawer, so switching the selected item REMOUNTS it and no
  // draft can survive the switch (#79).
  //
  // Without this, React reuses the instance: editing EE-1's description, then
  // clicking EE-2's tile, left EE-1's text sitting in what now looked like
  // EE-2's own description field — and one click on Save wrote it onto EE-2,
  // because the handler pairs the NEW sample.id with the STALE draft. The same
  // hazard applies to the timestamp draft and the stain-request agent, and to
  // any draft state added to these drawers later; keying by id retires the whole
  // class rather than resetting the three fields that exist today.
  const activeDrawer = selectedSample ? (
    <SampleDetailsDrawer
      key={selectedSample.id}
      sample={selectedSample}
      selectedSamples={samples.filter((sample) => selectedSampleIds.includes(sample.id))}
      onRequestProcessing={setPendingBatchSampleIds}
      width={drawerWidth}
      onClose={() => setSelectedSampleId(null)}
    />
  ) : selectedStack ? (
    <StackDetailsDrawer
      key={selectedStack.id}
      stack={selectedStack}
      selectedStacks={selectedStacks}
      width={drawerWidth}
      onClose={() => setSelectedStackId(null)}
    />
  ) : selectedSection ? (
    <SectionDetailsDrawer
      key={selectedSection.id}
      section={selectedSection}
      selectedSections={sections.filter((section) => selectedSectionIds.includes(section.id))}
      width={drawerWidth}
      onClose={() => setSelectedSectionId(null)}
    />
  ) : selectedBatch ? (
    <ProcessingBatchDetailsDrawer
      key={selectedBatch.id}
      batch={selectedBatch}
      samples={samples.filter((sample) => selectedBatch.member_ids.includes(sample.id))}
      candidates={plannedBatchCandidates}
      onEditMembers={(batchId, sampleIds) =>
        void editPlannedBatchMembers(batchId, sampleIds).catch((error) => flash(String(error)))
      }
      onMove={moveBatchWithConfirmation}
      onEditStart={(batchId, startedAt) =>
        void editBatchStart(batchId, startedAt).catch((error) => flash(String(error)))
      }
      onConfirmStart={(batchId, actualStartedAt) => {
        void confirmProcessingBatchStart(batchId, actualStartedAt)
          .then(() => flash("Processing run started"))
          .catch((error) => flash(String(error)));
      }}
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
    // Viewer instances are read-only mirrors; the mutating surfaces below read
    // this and hide themselves rather than firing writes the data layer will
    // reject (#72).
    <ReadOnlyProvider value={isViewer}>
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={setSelectedProjectId}
        onAddProject={() => setShowNewProject(true)}
        view={view}
        onSelectView={setView}
      />

      <main className="flex min-w-0 flex-1 flex-col bg-surface">
        <header className="flex items-center justify-between gap-3 border-b border-line bg-panel px-6 py-3">
          <div className="shrink-0">
            <h1 className="whitespace-nowrap text-lg font-semibold text-ink">Open Histology Workflow</h1>
            <p className="whitespace-nowrap text-xs text-ink-faint">
              {status ?? (
                <>
                  {samples.length} open {samples.length === 1 ? "sample" : "samples"} across{" "}
                  {projects.length} active {projects.length === 1 ? "project" : "projects"}
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <SyncStatusPill
              role={syncConfig.role}
              syncing={sync.syncing}
              error={sync.error}
              lastSyncedAt={sync.lastSyncedAt}
              lastMessage={sync.lastMessage}
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
                <Button variant="subtle" className="px-2" title="Manage users, projects & stains" onClick={() => setShowUsers(true)}>
                  <Users size={15} /> Manage
                </Button>
                <Button variant="subtle" className="px-2" title="Database backups & revert" onClick={() => setShowBackups(true)}>
                  <DatabaseBackup size={15} /> Backups
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
                <option value="matcha">☀ Matcha Tea</option>
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
                disabled={!selectedProject || !activeUser}
                title={
                  !activeUser
                    ? "Sign in before adding samples"
                    : !selectedProject
                      ? "Select a project first"
                      : undefined
                }
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
                qc.invalidateQueries({ queryKey: ["open-slide-stacks"] });
                qc.invalidateQueries({ queryKey: ["processing-batches"] });
              }}
            >
              <RefreshCw size={15} />
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {view === "manifest" ? (
            <div className="min-w-0 flex-1 overflow-hidden">
              <ManifestView />
            </div>
          ) : view === "logs" ? (
            <div className="min-w-0 flex-1 overflow-hidden p-3">
              <LogsView
                onRequestStain={(code) => {
                  setRequestStainCode(code);
                  setShowRequestStain(true);
                }}
              />
            </div>
          ) : (
          <>
          <div className="min-w-0 flex-1 overflow-hidden p-3">
            <Board
              samples={samples}
              sections={sections}
              stacks={stacks}
              batches={batches}
              extraSlides={extraSlides}
              selectedSampleId={selectedSampleId}
              selectedSectionId={selectedSectionId}
              selectedStackId={selectedStackId}
              onSelectSample={selectSample}
              onSampleSelectionChange={setSelectedSampleIds}
              onSelectSection={selectSection}
              onSectionSelectionChange={setSelectedSectionIds}
              onSelectStack={selectStack}
              onStackSelectionChange={setSelectedStackIds}
              onSelectExtraSlideSample={selectExtraSlideSample}
              onCloseDrawers={() => {
                setSelectedSampleId(null);
                setSelectedSectionId(null);
                setSelectedStackId(null);
                setSelectedBatchId(null);
                setSelectedExtraSampleId(null);
              }}
              onMoveSamples={(sampleIds, stageKey) => {
                void moveSamples(sampleIds, stageKey).catch((error) => flash(String(error)));
              }}
              onMoveSections={(sectionIds, stageKey) => {
                void moveSections(sectionIds, stageKey).catch((error) => flash(String(error)));
              }}
              onMoveStacks={(stackIds, stageKey) => {
                void moveSlideStacks(stackIds, stageKey).catch((error) => flash(String(error)));
              }}
              onRequestProcessingBatch={setPendingBatchSampleIds}
              onMoveProcessingBatch={(batchId, stageKey) => {
                moveBatchWithConfirmation(batchId, stageKey);
              }}
              onSelectProcessingBatch={(batchId) => {
                setSelectedSampleId(null);
                setSelectedSectionId(null);
                setSelectedStackId(null);
                setSelectedExtraSampleId(null);
                setSelectedBatchId(batchId);
              }}
              onConfirmProcessingBatchStart={(batchId) => {
                void confirmProcessingBatchStart(batchId)
                  .then(() => flash("Processing run started"))
                  .catch((error) => flash(String(error)));
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
          </>
          )}
        </div>
      </main>

      {showNewProject && (
        <NewProjectDialog
          users={users.filter((user) => user.is_active)}
          onCreated={(projectId) => setSelectedProjectId(projectId)}
          onClose={() => setShowNewProject(false)}
        />
      )}
      {showUsers && <ManageDialog users={users} activeUser={activeUser} onClose={() => setShowUsers(false)} />}
      {showBackups && (
        <BackupsDialog
          onClose={() => setShowBackups(false)}
          onReverted={() => {
            void qc.invalidateQueries();
            flash("Reverted to backup");
          }}
        />
      )}
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
          onPlan={async (input) => {
            await planProcessingBatch(input);
            flash(`Planned ${input.processingType.toLowerCase()} batch · ${input.sampleIds.length} samples`);
          }}
          onClose={() => setPendingBatchSampleIds(null)}
        />
      )}
      {showRequests && (
        <RequestsInbox
          title={isViewer ? "Requests" : "Stain requests"}
          // A viewer's own submissions only reach the database after the
          // workstation drains them and the viewer pulls the next snapshot, so
          // show the locally-remembered ones until then (#71).
          requests={isViewer ? mergePendingRequests(stainRequests) : stainRequests}
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
          exhaustedSampleCodes={exhaustedSampleCodes}
          catalog={assayCatalog}
          defaultSampleCode={requestStainCode}
          onSubmitted={(message) => flash(message)}
          onClose={() => {
            setShowRequestStain(false);
            setRequestStainCode(undefined);
          }}
        />
      )}
      {showSetup && (
        <SetupScreen
          initial={syncConfig}
          onConfigured={applyConfig}
          onCancel={() => setShowSetup(false)}
        />
      )}
      {/* #76 — say plainly that the session lapsed, and offer the way back in.
          Dismissable: work can continue unsigned, it is just recorded that way. */}
      {idleSignedOut !== null && (
        <Modal title="Signed out for inactivity" onClose={() => setIdleSignedOut(null)} width="max-w-sm">
          <p className="mb-3 text-xs text-ink-soft">
            {idleSignedOut
              ? `${idleSignedOut} was signed out after 30 minutes without activity.`
              : "The session was signed out after 30 minutes without activity."}{" "}
            Sign back in so your changes are attributed to you — until then they are recorded as unsigned.
          </p>
          <Field label="Sign in as">
            <select
              aria-label="Sign back in"
              defaultValue=""
              onChange={(event) => {
                if (!event.target.value) return;
                selectUser.mutate(Number(event.target.value));
                setIdleSignedOut(null);
              }}
              className="w-full rounded-lg border border-line bg-white px-2 py-2 text-sm text-ink outline-none focus:border-brand"
            >
              <option value="">Choose a user…</option>
              {users.filter((user) => user.is_active).map((user) => (
                <option key={user.id} value={user.id}>{user.name}</option>
              ))}
            </select>
          </Field>
          <div className="mt-3 flex justify-end">
            <Button variant="ghost" onClick={() => setIdleSignedOut(null)}>
              Continue unsigned
            </Button>
          </div>
        </Modal>
      )}
    </div>
    </ReadOnlyProvider>
  );
}

// Compact sync indicator + manual "Sync now" + settings entry.
function SyncStatusPill({
  role,
  syncing,
  error,
  lastSyncedAt,
  lastMessage,
  onSyncNow,
  onOpenSettings,
}: {
  role: string;
  syncing: boolean;
  error: string | null;
  lastSyncedAt: Date | null;
  /** Outcome of the last sync, e.g. "Pulled latest snapshot — changes by Alex". */
  lastMessage: string | null;
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
      {/* #77 — who published what. useSync has always built this string; until
          now nothing rendered it, so the "changes by …" attribution the changelog
          promised never actually reached a screen. Shown inline when there is
          room, and always in the tooltip. */}
      <span title={error ?? lastMessage ?? undefined}>{label}</span>
      {!syncing && !error && lastMessage && (
        <span
          className="ml-1 hidden max-w-[22rem] truncate text-ink-faint lg:inline"
          title={lastMessage}
        >
          {lastMessage}
        </span>
      )}
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
