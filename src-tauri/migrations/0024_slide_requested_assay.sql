-- 0024 — what a slide was ASKED for, kept apart from what it turned out to be.
--
-- `slides.assay_name` was doing two jobs at once: the agent a slide was cut for,
-- and the agent it actually carries. That is fine right up to the first mistake.
-- A slide requested as PAS that goes into the H&E dish has to be corrected, and
-- correcting it overwrote the request — so the log could no longer say that a
-- PAS was ordered and never made, and the block stopped looking like it still
-- needed one.
--
-- These two columns hold the ORDER. They are written once, when the slide is
-- planned or cut, and never touched by a later correction; `assay_name` goes on
-- meaning "what this glass is". Where they differ, something was put right, and
-- both halves of that are now recoverable.
--
-- Additive, per docs/shared_data_sync.md §1: older builds ignore the columns and
-- keep working, and an older image opened by this build gets them from
-- ensureRuntimeSchema().
ALTER TABLE slides ADD COLUMN requested_assay_type TEXT NOT NULL DEFAULT '';
ALTER TABLE slides ADD COLUMN requested_assay_name TEXT NOT NULL DEFAULT '';

-- Backfill from what the slide currently says. For every slide that exists
-- today this IS the request — nothing has been able to diverge yet, because
-- until now there was nowhere for a divergence to live.
UPDATE slides
   SET requested_assay_type = COALESCE(assay_type, ''),
       requested_assay_name = COALESCE(assay_name, '')
 WHERE purpose = 'stain';

CREATE INDEX IF NOT EXISTS idx_slides_requested_assay
    ON slides(requested_assay_type, requested_assay_name);
