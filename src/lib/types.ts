export interface Project {
  id: number;
  code: string;
  name: string;
  team_lead: string;
  is_active: number; // 0 | 1
  created_at: string;
  sample_count?: number;
  lead_user_id?: number | null;
}

export interface LabUser {
  id: number;
  name: string;
  initials: string;
  is_active: number;
  created_at: string;
}

export type ProcessingType = "Short" | "Long";

export interface Sample {
  id: number;
  project_id: number;
  project_sample_number: number | null;
  sample_code: string;
  sample_description: string;
  date_added: string;
  processing_type: ProcessingType;
  fixative_agent: string;
  needs_decalcification: number; // 0 | 1
  cut_notes: string;
  slide_notes: string;
  stains: string;
  overall_notes: string;
  sectioning_plan: string;
  current_stage: string;

  stage_received_at: string | null;
  decalc_completed_at: string | null;
  fixative_placed_at: string | null;
  fixative_removed_at: string | null;
  ethanol_placed_at: string | null;
  processing_started_at: string | null;
  stage_processed_at: string | null;
  stage_picked_up_at: string | null;
  stage_needs_embedding_at: string | null;
  stage_embedded_at: string | null;
  stage_needs_sectioning_at: string | null;
  stage_sectioned_at: string | null;
  stage_stain_requested_at: string | null;
  stage_stained_at: string | null;
  stage_deparaffinized_at: string | null;
  stage_ihc_at: string | null;
  stage_pictures_taken_at: string | null;
  stage_analyzed_at: string | null;
  max_cut_depth_um: number | null;
  block_exhausted: number; // 0 | 1
  is_priority: number; // 0 | 1
  prioritized_at: string | null;

  created_at: string;

  // Joined from projects for the board view.
  project_code?: string;
  project_name?: string;
  team_lead?: string;
  sectioned_depths?: string;
}

export interface SampleTimelineEvent {
  id: number;
  sample_id: number;
  user_id: number | null;
  event_type: string;
  summary: string;
  details: string;
  created_at: string;
  user_name?: string | null;
}

export interface SectionRequest {
  id: number;
  sample_id: number;
  depth_um: number;
  depth_index: number | null;
  duplicates: number;
  stains: string;
  notes: string;
  current_stage: string;
  stage_needs_sectioning_at: string | null;
  stage_sectioned_at: string | null;
  stage_assignment_required_at: string | null;
  stage_stain_requested_at: string | null;
  stage_stained_at: string | null;
  stage_deparaffinized_at: string | null;
  stage_ihc_at: string | null;
  stage_refrax_at: string | null;
  stage_coverslipped_at: string | null;
  stage_dried_at: string | null;
  stage_ready_for_imaging_at: string | null;
  stage_pictures_taken_at: string | null;
  stage_analyzed_at: string | null;
  created_at: string;

  // Joined from the parent block / project.
  project_id?: number;
  project_code?: string;
  project_name?: string;
  parent_code?: string;
  parent_description?: string;
  parent_stains?: string;
  is_priority?: number;
  prioritized_at?: string | null;
  slide_count?: number;
  assay_slide_count?: number;
  assigned_slide_count?: number;
  extra_slide_count?: number;
  slide_summary?: string;
  assay_slide_summary?: string;
}

export type SlidePurpose = "unassigned" | "stain" | "extra" | "control" | "exception";

export interface Slide {
  id: number;
  section_request_id: number;
  stack_id: number | null;
  sample_id?: number;
  slide_ordinal: number;
  depth_duplicate_ordinal: number | null;
  slide_code: string;
  purpose: SlidePurpose;
  stain_name: string;
  slice_count: number;
  control_agent: string;
  assay_type: "" | "stain" | "ihc";
  assay_name: string;
  assignment_saved: number;
  current_stage: string;
  stage_cut_at: string | null;
  stage_stain_requested_at: string | null;
  stage_staining_started_at: string | null;
  stage_stained_at: string | null;
  stage_refrax_at: string | null;
  stage_coverslipped_at: string | null;
  stage_dried_at: string | null;
  stage_ready_for_imaging_at: string | null;
  stage_pictures_taken_at: string | null;
  stage_analyzed_at: string | null;
  location: string;
  notes: string;
  created_at: string;
  parent_code?: string;
  depth_um?: number;
  project_code?: string;
  project_name?: string;
  sample_description?: string;
  depth_index?: number;
  cut_depth_um: number | null;
  cut_depth_index: number | null;
  is_priority?: number;
}

export interface SlideStack {
  id: number;
  sample_id: number;
  depth_um: number;
  depth_index: number;
  current_stage: string;
  stage_stain_requested_at: string | null;
  stage_stained_at: string | null;
  stage_deparaffinized_at: string | null;
  stage_ihc_at: string | null;
  stage_refrax_at: string | null;
  stage_coverslipped_at: string | null;
  stage_dried_at: string | null;
  stage_ready_for_imaging_at: string | null;
  stage_pictures_taken_at: string | null;
  stage_analyzed_at: string | null;
  closed_at: string | null;
  created_at: string;
  project_id?: number;
  parent_code?: string;
  parent_description?: string;
  project_code?: string;
  project_name?: string;
  is_priority?: number;
  slide_count?: number;
  assay_slide_count?: number;
  has_stain?: number;
  has_ihc?: number;
  slide_summary?: string;
}

export interface ProcessingBatch {
  id: number;
  processing_type: ProcessingType;
  operator_name: string;
  status: string;
  started_at: string;
  ready_at: string | null;
  collected_at: string | null;
  completed_at: string | null;
  notes: string;
  created_at: string;
  member_ids: number[];
  member_codes: string[];
  member_count: number;
  current_stage: string;
  checklist_completed: number;
  checklist_total: number;
}

export interface ChecklistItem {
  id: number;
  checklist_run_id: number;
  item_key: string;
  label: string;
  sort_order: number;
  is_required: number;
  is_complete: number;
  completed_by: string;
  completed_at: string | null;
  notes: string;
}

export interface AssayCatalogEntry {
  id: number;
  assay_type: "stain" | "ihc";
  name: string;
  is_active: number;
  created_at: string;
}

export type StainRequestStatus = "requested" | "acknowledged" | "done" | "rejected";

export interface StainRequest {
  id: number;
  uuid: string;
  sample_code: string;
  slide_code: string;
  requested_assay: string;
  requester_name: string;
  note: string;
  status: StainRequestStatus;
  created_at: string;
  ingested_at: string;
  resolved_by: string;
  resolved_at: string | null;
}

export interface NewSampleInput {
  project_id: number;
  sample_description: string;
  processing_type: ProcessingType;
  fixative_agent: string;
  needs_decalcification: boolean;
  cut_notes: string;
  slide_notes: string;
  stains: string;
  overall_notes: string;
}
