import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addProject,
  addUser,
  addSample,
  autoAdvanceProcessingRuns,
  listAllSamples,
  listAllSlides,
  listSlideRemovals,
  listAuditEvents,
  listOpenSamples,
  listOpenProcessingBatches,
  listOpenSectionRequests,
  listOpenSlideStacks,
  listSlidesForSectionRequest,
  listSlidesForSections,
  listSlidesForStack,
  listStainSlidesForSections,
  listSampleTimelineEvents,
  listExtraSlides,
  listAssayCatalog,
  listProjects,
  listStainRequests,
  listUsers,
  getActiveUser,
  getAppSettings,
  saveAppSettings,
  setActiveUser,
  setStainRequestStatus,
  setUserActive,
  setProjectActive,
  updateProject,
  deleteProject,
  addAssay,
  updateAssay,
  setAssayActive,
  deleteAssay,
  updateSampleDetails,
  updateSampleStage,
} from "../lib/db";
import type { NewSampleInput, StainRequestStatus } from "../lib/types";
import { DEFAULT_SETTINGS, type AppSettings } from "../lib/settings";

const KEYS = {
  projects: ["projects"] as const,
  openSamples: ["open-samples"] as const,
  openSections: ["open-sections"] as const,
  processingBatches: ["processing-batches"] as const,
  users: ["users"] as const,
  activeUser: ["active-user"] as const,
  settings: ["app-settings"] as const,
};

export function useUsers(activeOnly = false) {
  return useQuery({
    queryKey: [...KEYS.users, activeOnly],
    queryFn: () => listUsers(activeOnly),
  });
}

export function useActiveUser() {
  return useQuery({ queryKey: KEYS.activeUser, queryFn: getActiveUser });
}

/**
 * Workstation defaults (#92). `initialData` rather than an undefined-handling
 * dance at every call site: every consumer needs a usable number on the very
 * first render (the idle timer, the plan dialog), and the defaults ARE the
 * answer until the row is read.
 *
 * `initialDataUpdatedAt: 0` is load-bearing. Without it, react-query stamps the
 * seed as fetched *now*, and the client-wide `staleTime: 5000` then suppresses
 * the mount fetch entirely — so for the first five seconds after launch the app
 * used the built-in defaults rather than the lab's configured ones, silently.
 * Dating the seed to the epoch marks it stale on arrival, so the real row is
 * always read.
 */
export function useAppSettings() {
  return useQuery({
    queryKey: KEYS.settings,
    queryFn: getAppSettings,
    initialData: DEFAULT_SETTINGS,
    initialDataUpdatedAt: 0,
  });
}

export function useSettingsMutations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: AppSettings) => saveAppSettings(settings),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.settings }),
  });
}

export function useUserMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: KEYS.users });
    qc.invalidateQueries({ queryKey: KEYS.activeUser });
  };
  const create = useMutation({ mutationFn: addUser, onSuccess: invalidate });
  const setEnabled = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) => setUserActive(id, isActive),
    onSuccess: invalidate,
  });
  const select = useMutation({ mutationFn: setActiveUser, onSuccess: invalidate });
  return { create, setEnabled, select };
}

export function useProcessingBatches() {
  return useQuery({
    queryKey: KEYS.processingBatches,
    queryFn: listOpenProcessingBatches,
  });
}

export function useAssayCatalog(includeInactive = false) {
  return useQuery({
    queryKey: ["assay-catalog", includeInactive],
    queryFn: () => listAssayCatalog(includeInactive),
  });
}

export function useAssayCatalogMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["assay-catalog"] });
  const create = useMutation({ mutationFn: addAssay, onSuccess: invalidate });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => updateAssay(id, name),
    onSuccess: invalidate,
  });
  const setEnabled = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) => setAssayActive(id, isActive),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: deleteAssay, onSuccess: invalidate });
  return { create, rename, setEnabled, remove };
}

export function useSectionSlides(sectionId: number | null) {
  return useQuery({
    queryKey: ["section-slides", sectionId],
    queryFn: () => listSlidesForSectionRequest(sectionId as number),
    enabled: sectionId !== null,
  });
}

// All slides across a set of grouped cut groups (keyed under "section-slides" so
// the existing invalidation covers it).
export function useSectionsSlides(sectionIds: number[]) {
  const key = [...sectionIds].sort((a, b) => a - b);
  return useQuery({
    queryKey: ["section-slides", "multi", key],
    queryFn: () => listSlidesForSections(sectionIds),
    enabled: sectionIds.length > 0,
  });
}

export function useImagingSlides(sectionIds: number[]) {
  const key = [...sectionIds].sort((a, b) => a - b);
  return useQuery({
    queryKey: ["imaging-slides", key],
    queryFn: () => listStainSlidesForSections(sectionIds),
    enabled: sectionIds.length > 0,
  });
}

export function useSampleTimelineEvents(sampleId: number | null) {
  return useQuery({
    queryKey: ["sample-timeline", sampleId],
    queryFn: () => listSampleTimelineEvents(sampleId as number),
    enabled: sampleId !== null,
  });
}

export function useExtraSlides() {
  return useQuery({ queryKey: ["extra-slides"], queryFn: listExtraSlides });
}

export function useOpenSections() {
  return useQuery({
    queryKey: KEYS.openSections,
    queryFn: listOpenSectionRequests,
  });
}

export function useOpenSlideStacks() {
  return useQuery({ queryKey: ["open-slide-stacks"], queryFn: listOpenSlideStacks });
}

export function useStackSlides(stackId: number | null) {
  return useQuery({
    queryKey: ["stack-slides", stackId],
    queryFn: () => listSlidesForStack(stackId as number),
    enabled: stackId !== null,
  });
}

export function useStainRequests(opts?: { status?: StainRequestStatus; requesterName?: string }) {
  return useQuery({
    queryKey: ["stain-requests", opts?.status ?? null, opts?.requesterName ?? null],
    queryFn: () => listStainRequests(opts),
  });
}

export function useStainRequestMutations() {
  const qc = useQueryClient();
  const setStatus = useMutation({
    mutationFn: ({ id, status, resolvedBy }: { id: number; status: StainRequestStatus; resolvedBy: string }) =>
      setStainRequestStatus(id, status, resolvedBy),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stain-requests"] }),
  });
  return { setStatus };
}

export function useProjects(activeOnly = false) {
  return useQuery({
    queryKey: [...KEYS.projects, activeOnly],
    queryFn: () => listProjects(activeOnly),
  });
}

export function useOpenSamples() {
  return useQuery({
    queryKey: KEYS.openSamples,
    queryFn: listOpenSamples,
  });
}

// Full records for the Logs view — every sample and every slide, regardless of
// stage or project active state.
export function useAllSamples() {
  return useQuery({ queryKey: ["all-samples"], queryFn: listAllSamples });
}
export function useAllSlides() {
  return useQuery({ queryKey: ["all-slides"], queryFn: listAllSlides });
}
/** Reasons for every removed slide, for the Logs "Removed" flag (#83). */
export function useSlideRemovals() {
  return useQuery({ queryKey: ["slide-removals"], queryFn: listSlideRemovals });
}

/** The change manifest (#77). Refetched on mutations like everything else. */
export function useAuditEvents() {
  return useQuery({ queryKey: ["audit-events"], queryFn: () => listAuditEvents() });
}

export function useProjectMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: KEYS.projects });
    qc.invalidateQueries({ queryKey: KEYS.openSamples });
  };

  const create = useMutation({
    mutationFn: addProject,
    onSuccess: invalidate,
  });
  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      setProjectActive(id, isActive),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: number;
      input: { code: string; name: string; team_lead: string; lead_user_id: number };
    }) => updateProject(id, input),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: deleteProject, onSuccess: invalidate });

  return { create, setActive, update, remove };
}

export function useSampleMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: KEYS.openSamples });
    qc.invalidateQueries({ queryKey: KEYS.projects });
  };

  const create = useMutation({
    mutationFn: ({ input, projectCode }: { input: NewSampleInput; projectCode: string }) =>
      addSample(input, projectCode),
    onSuccess: invalidate,
  });

  const move = useMutation({
    mutationFn: ({ sampleId, stageKey }: { sampleId: number; stageKey: string }) =>
      updateSampleStage(sampleId, stageKey),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.openSamples }),
  });

  const updateDetails = useMutation({
    mutationFn: ({
      sampleId,
      input,
    }: {
      sampleId: number;
      input: Omit<NewSampleInput, "project_id">;
    }) => updateSampleDetails(sampleId, input),
    onSuccess: invalidate,
  });

  // No `remove` mutation: samples are archived, never deleted (#83).

  const autoAdvance = useMutation({
    mutationFn: autoAdvanceProcessingRuns,
    onSuccess: (moved) => {
      if (moved > 0) qc.invalidateQueries({ queryKey: KEYS.openSamples });
    },
  });

  return { create, move, updateDetails, autoAdvance };
}
