import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  acknowledgeRequestsForSlide,
  addProject,
  addUser,
  addSample,
  autoAdvanceProcessingRuns,
  deleteSample,
  listOpenSamples,
  listOpenProcessingBatches,
  listOpenSectionRequests,
  listSlidesForSectionRequest,
  listSampleTimelineEvents,
  listExtraSlides,
  assignExtraSlideToAssay,
  listAssayCatalog,
  listProjects,
  listStainRequests,
  listUsers,
  getActiveUser,
  setActiveUser,
  setStainRequestStatus,
  setUserActive,
  setProjectActive,
  updateSampleDetails,
  updateSampleStage,
} from "../lib/db";
import type { NewSampleInput, StainRequestStatus } from "../lib/types";

const KEYS = {
  projects: ["projects"] as const,
  openSamples: ["open-samples"] as const,
  openSections: ["open-sections"] as const,
  processingBatches: ["processing-batches"] as const,
  users: ["users"] as const,
  activeUser: ["active-user"] as const,
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

export function useAssayCatalog() {
  return useQuery({ queryKey: ["assay-catalog"], queryFn: listAssayCatalog });
}

export function useSectionSlides(sectionId: number | null) {
  return useQuery({
    queryKey: ["section-slides", sectionId],
    queryFn: () => listSlidesForSectionRequest(sectionId as number),
    enabled: sectionId !== null,
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

export function useExtraSlideMutations() {
  const qc = useQueryClient();
  const assign = useMutation({
    mutationFn: async (input: { slideId: number; assayType: "stain" | "ihc"; assayName: string }) => {
      await assignExtraSlideToAssay(input);
      // Fulfilling a requested stain auto-acknowledges the matching request.
      await acknowledgeRequestsForSlide(input.slideId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["extra-slides"] });
      qc.invalidateQueries({ queryKey: ["open-sections"] });
      qc.invalidateQueries({ queryKey: ["section-slides"] });
      qc.invalidateQueries({ queryKey: ["sample-timeline"] });
      qc.invalidateQueries({ queryKey: ["stain-requests"] });
    },
  });
  return { assign };
}

export function useOpenSections() {
  return useQuery({
    queryKey: KEYS.openSections,
    queryFn: listOpenSectionRequests,
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

  return { create, setActive };
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

  const remove = useMutation({
    mutationFn: (sampleId: number) => deleteSample(sampleId),
    onSuccess: invalidate,
  });

  const autoAdvance = useMutation({
    mutationFn: autoAdvanceProcessingRuns,
    onSuccess: (moved) => {
      if (moved > 0) qc.invalidateQueries({ queryKey: KEYS.openSamples });
    },
  });

  return { create, move, updateDetails, remove, autoAdvance };
}
