-- Default unused slides to Extra and track post-assay completion separately
-- from the later imaging event.

UPDATE slides
   SET purpose = 'extra', current_stage = 'extra'
 WHERE purpose = 'unassigned';

ALTER TABLE slides ADD COLUMN stage_refrax_at TEXT;
ALTER TABLE slides ADD COLUMN stage_coverslipped_at TEXT;
ALTER TABLE slides ADD COLUMN stage_ready_for_imaging_at TEXT;

ALTER TABLE section_requests ADD COLUMN stage_refrax_at TEXT;
ALTER TABLE section_requests ADD COLUMN stage_coverslipped_at TEXT;
ALTER TABLE section_requests ADD COLUMN stage_ready_for_imaging_at TEXT;
