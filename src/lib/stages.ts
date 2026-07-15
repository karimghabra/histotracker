// Workflow stage configuration, ported from the Python prototype.

export interface StageDef {
  key: string;
  label: string;
  column: string; // timestamp column on the samples table
}

export const STAGES: StageDef[] = [
  { key: "received", label: "Logged", column: "stage_received_at" },
  { key: "in_fixative", label: "Placed in Fixative", column: "fixative_placed_at" },
  { key: "fixative_removed", label: "Removed from Fixative", column: "fixative_removed_at" },
  { key: "decalcified", label: "Decalcification Complete", column: "decalc_completed_at" },
  { key: "in_ethanol", label: "Placed in Ethanol", column: "ethanol_placed_at" },
  { key: "processing_started", label: "Processing Started", column: "processing_started_at" },
  { key: "processed", label: "Processed", column: "stage_processed_at" },
  { key: "picked_up", label: "Picked Up from Processor", column: "stage_picked_up_at" },
  { key: "needs_embedding", label: "Needs Embedding", column: "stage_needs_embedding_at" },
  { key: "embedded", label: "Embedded", column: "stage_embedded_at" },
  { key: "needs_sectioning", label: "Needs Sectioning", column: "stage_needs_sectioning_at" },
  { key: "sectioned", label: "Sectioned / Slides Ready", column: "stage_sectioned_at" },
  { key: "stain_requested", label: "Needs Stains / IHC", column: "stage_stain_requested_at" },
  { key: "stained", label: "Stained", column: "stage_stained_at" },
  { key: "deparaffinized", label: "Deparaffinized", column: "stage_deparaffinized_at" },
  { key: "ihc_complete", label: "IHC Complete", column: "stage_ihc_at" },
  { key: "pictures_taken", label: "Pictures Taken", column: "stage_pictures_taken_at" },
  { key: "analyzed", label: "Analyzed", column: "stage_analyzed_at" },
];

export const STAGE_LABELS: Record<string, string> = Object.fromEntries(
  STAGES.map((s) => [s.key, s.label]),
);
export const STAGE_COLUMNS: Record<string, string> = Object.fromEntries(
  STAGES.map((s) => [s.key, s.column]),
);
export const STAGE_ORDER: Record<string, number> = Object.fromEntries(
  STAGES.map((s, i) => [s.key, i]),
);

// Timeline shows real block lab events only — not status-only queues
// ("Needs Embedding") or auto-derived stages ("Processed"), and not the
// downstream slide stages (those belong to section/slide cards).
const BLOCK_TIMELINE_KEYS = [
  "received",
  "in_fixative",
  "fixative_removed",
  "decalcified",
  "in_ethanol",
  "processing_started",
  "picked_up",
  "embedded",
];
export const BLOCK_TIMELINE_STAGES: StageDef[] = STAGES.filter((s) =>
  BLOCK_TIMELINE_KEYS.includes(s.key),
);

export const FIXATIVE_OPTIONS = ["PFA", "Z-Fix", "Other"];
export const PROCESSING_OPTIONS: Array<"Short" | "Long"> = ["Short", "Long"];

export interface QueueDef {
  key: string;
  title: string;
  stages: string[];
  entryStage: string; // stage assigned when a card is dropped into this queue
  lane: number;
}

export const BOARD_QUEUES: QueueDef[] = [
  { key: "preprocessing", title: "Pre-processing", stages: ["received", "in_fixative", "fixative_removed", "decalcified", "in_ethanol"], entryStage: "in_fixative", lane: 0 },
  { key: "processing", title: "Processing", stages: ["processing_started"], entryStage: "processing_started", lane: 0 },
  { key: "processor_pickup", title: "Processor Pickup", stages: ["processed"], entryStage: "processed", lane: 0 },
  { key: "needs_embedding", title: "Needs Embedding", stages: ["needs_embedding"], entryStage: "needs_embedding", lane: 0 },
  { key: "embedded_inventory", title: "Embedded Inventory", stages: ["embedded"], entryStage: "embedded", lane: 1 },
  { key: "needs_sectioning", title: "Needs Sectioning", stages: ["needs_sectioning"], entryStage: "needs_sectioning", lane: 1 },
  { key: "slide_assignment", title: "Assign Slides", stages: ["assignment_required"], entryStage: "assignment_required", lane: 1 },
  { key: "staining", title: "Staining / IHC", stages: ["sectioned", "stain_requested", "stained", "deparaffinized", "ihc_complete"], entryStage: "stain_requested", lane: 1 },
  { key: "analysis_pending", title: "Ready for Imaging", stages: ["ready_for_imaging", "pictures_taken"], entryStage: "ready_for_imaging", lane: 1 },
];

export const BOARD_LANES: Array<{ title: string; queues: string[] }> = [
  { title: "Processing & Embedding", queues: ["preprocessing", "processing", "processor_pickup", "needs_embedding"] },
  { title: "Embedded Inventory & Analysis", queues: ["embedded_inventory", "needs_sectioning", "slide_assignment", "staining", "analysis_pending"] },
];

export const QUEUE_BY_KEY: Record<string, QueueDef> = Object.fromEntries(
  BOARD_QUEUES.map((q) => [q.key, q]),
);
export const STAGE_TO_QUEUE: Record<string, string> = Object.fromEntries(
  BOARD_QUEUES.flatMap((q) => q.stages.map((s) => [s, q.key])),
);

export const LANE_COLORS = ["var(--color-lane-a)", "var(--color-lane-b)"];

// ---- Section-request workflow (children of embedded blocks) ------------------

export const SECTION_STAGES: StageDef[] = [
  { key: "needs_sectioning", label: "Needs Sectioning", column: "stage_needs_sectioning_at" },
  { key: "sectioned", label: "Sectioned / Slides Ready", column: "stage_sectioned_at" },
  { key: "assignment_required", label: "Slide Assignment Required", column: "stage_assignment_required_at" },
  { key: "stain_requested", label: "Needs Stains / IHC", column: "stage_stain_requested_at" },
  { key: "stained", label: "Stained", column: "stage_stained_at" },
  { key: "deparaffinized", label: "Deparaffinized", column: "stage_deparaffinized_at" },
  { key: "ihc_complete", label: "IHC Complete", column: "stage_ihc_at" },
  { key: "refrax_complete", label: "Refrax Complete", column: "stage_refrax_at" },
  { key: "coverslipped", label: "Coverslipped", column: "stage_coverslipped_at" },
  { key: "dried", label: "Dried", column: "stage_dried_at" },
  { key: "ready_for_imaging", label: "Ready for Imaging", column: "stage_ready_for_imaging_at" },
  { key: "pictures_taken", label: "Pictures Taken", column: "stage_pictures_taken_at" },
  { key: "analyzed", label: "Analyzed", column: "stage_analyzed_at" },
];

export const SECTION_STAGE_LABELS: Record<string, string> = Object.fromEntries(
  SECTION_STAGES.map((s) => [s.key, s.label]),
);
export const SECTION_STAGE_COLUMNS: Record<string, string> = Object.fromEntries(
  SECTION_STAGES.map((s) => [s.key, s.column]),
);
export const SECTION_STAGE_ORDER: Record<string, number> = Object.fromEntries(
  SECTION_STAGES.map((s, i) => [s.key, i]),
);

// Which board queues hold blocks vs. section-request children.
export const BLOCK_QUEUE_KEYS = new Set([
  "preprocessing",
  "processing",
  "processor_pickup",
  "needs_embedding",
  "embedded_inventory",
]);
export const SECTION_QUEUE_KEYS = new Set([
  "needs_sectioning",
  "slide_assignment",
  "staining",
  "analysis_pending",
]);

// Section stage -> board queue key.
export const SECTION_STAGE_TO_QUEUE: Record<string, string> = {
  needs_sectioning: "needs_sectioning",
  sectioned: "slide_assignment",
  assignment_required: "slide_assignment",
  stain_requested: "staining",
  stained: "staining",
  deparaffinized: "staining",
  ihc_complete: "staining",
  refrax_complete: "staining",
  coverslipped: "staining",
  dried: "staining",
  ready_for_imaging: "analysis_pending",
  pictures_taken: "analysis_pending",
};

// Stage assigned when a section card is dropped into a queue.
export const SECTION_QUEUE_ENTRY: Record<string, string> = {
  needs_sectioning: "needs_sectioning",
  slide_assignment: "assignment_required",
  staining: "stain_requested",
  analysis_pending: "ready_for_imaging",
};

export function processingDurationHours(processingType: string): number {
  return processingType.toLowerCase() === "long" ? 52 : 18;
}
