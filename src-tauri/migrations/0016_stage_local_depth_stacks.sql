-- A board stack is one sample + physical cut depth + workflow stage. Matching
-- groups merge when they arrive in the same stage; fresh staining work must
-- never pull a companion stack backward from imaging.
DROP INDEX IF EXISTS idx_slide_stacks_one_open_per_sample;

ALTER TABLE slide_stacks ADD COLUMN depth_um INTEGER;
ALTER TABLE slide_stacks ADD COLUMN depth_index INTEGER;

-- Recover the intended groups from the slides themselves. This also repairs a
-- 0.3.0 stack that was pulled backward after a fresh companion slide joined it.
CREATE TEMP TABLE stack_groups_raw AS
SELECT ss.id AS old_stack_id,
       COALESCE(sl.cut_depth_um, sr.depth_um) AS depth_um,
       MIN(COALESCE(sl.cut_depth_index, sr.depth_index)) AS depth_index,
       CASE sl.current_stage
         WHEN 'assigned' THEN 'stain_requested'
         WHEN 'cut' THEN 'stain_requested'
         ELSE sl.current_stage
       END AS stage_key,
       CASE sl.current_stage
         WHEN 'analyzed' THEN 10
         WHEN 'pictures_taken' THEN 9
         WHEN 'ready_for_imaging' THEN 8
         WHEN 'dried' THEN 7
         WHEN 'coverslipped' THEN 6
         WHEN 'refrax_complete' THEN 5
         WHEN 'ihc_complete' THEN 4
         WHEN 'deparaffinized' THEN 3
         WHEN 'stained' THEN 2
         ELSE 1
       END AS stage_rank
  FROM slide_stacks ss
  JOIN slides sl ON sl.stack_id = ss.id AND sl.purpose = 'stain'
  JOIN section_requests sr ON sr.id = sl.section_request_id
 GROUP BY ss.id, COALESCE(sl.cut_depth_um, sr.depth_um),
          CASE sl.current_stage
            WHEN 'assigned' THEN 'stain_requested'
            WHEN 'cut' THEN 'stain_requested'
            ELSE sl.current_stage
          END;

-- Keep the original ID for the most advanced group. Its checklist and audit
-- references therefore stay with the work that already reached furthest.
CREATE TEMP TABLE stack_group_targets AS
WITH ranked AS (
  SELECT raw.*,
         ROW_NUMBER() OVER (
           PARTITION BY old_stack_id
           ORDER BY stage_rank DESC, depth_um ASC, depth_index ASC
         ) AS group_rank
    FROM stack_groups_raw raw
)
SELECT ranked.*, CAST(NULL AS INTEGER) AS target_stack_id
  FROM ranked;

UPDATE stack_group_targets
   SET target_stack_id = old_stack_id
 WHERE group_rank = 1;

UPDATE stack_group_targets AS current
   SET target_stack_id = (SELECT COALESCE(MAX(id), 0) FROM slide_stacks) + (
     SELECT COUNT(*)
       FROM stack_group_targets prior
      WHERE prior.group_rank > 1
        AND (prior.old_stack_id < current.old_stack_id
          OR (prior.old_stack_id = current.old_stack_id
              AND prior.group_rank <= current.group_rank))
   )
 WHERE current.group_rank > 1;

UPDATE slide_stacks
   SET depth_um = (
         SELECT depth_um FROM stack_group_targets
          WHERE old_stack_id = slide_stacks.id AND group_rank = 1
       ),
       depth_index = (
         SELECT depth_index FROM stack_group_targets
          WHERE old_stack_id = slide_stacks.id AND group_rank = 1
       ),
       current_stage = (
         SELECT stage_key FROM stack_group_targets
          WHERE old_stack_id = slide_stacks.id AND group_rank = 1
       ),
       closed_at = CASE
         WHEN (SELECT stage_key FROM stack_group_targets
                WHERE old_stack_id = slide_stacks.id AND group_rank = 1) = 'analyzed'
           THEN COALESCE(closed_at, stage_analyzed_at, CURRENT_TIMESTAMP)
         ELSE NULL
       END
 WHERE EXISTS (
   SELECT 1 FROM stack_group_targets
    WHERE old_stack_id = slide_stacks.id AND group_rank = 1
 );

INSERT INTO slide_stacks
  (id, sample_id, depth_um, depth_index, current_stage,
   stage_stain_requested_at, stage_stained_at, stage_deparaffinized_at,
   stage_ihc_at, stage_refrax_at, stage_coverslipped_at, stage_dried_at,
   stage_ready_for_imaging_at, stage_pictures_taken_at, stage_analyzed_at,
   closed_at, created_at)
SELECT g.target_stack_id, ss.sample_id, g.depth_um, g.depth_index, g.stage_key,
       ss.stage_stain_requested_at, ss.stage_stained_at,
       ss.stage_deparaffinized_at, ss.stage_ihc_at, ss.stage_refrax_at,
       ss.stage_coverslipped_at, ss.stage_dried_at,
       ss.stage_ready_for_imaging_at, ss.stage_pictures_taken_at,
       ss.stage_analyzed_at,
       CASE WHEN g.stage_key = 'analyzed'
         THEN COALESCE(ss.closed_at, ss.stage_analyzed_at, CURRENT_TIMESTAMP)
         ELSE NULL
       END,
       ss.created_at
  FROM stack_group_targets g
  JOIN slide_stacks ss ON ss.id = g.old_stack_id
 WHERE g.group_rank > 1;

UPDATE slides
   SET stack_id = (
     SELECT g.target_stack_id
       FROM stack_group_targets g
       JOIN section_requests sr ON sr.id = slides.section_request_id
      WHERE g.old_stack_id = slides.stack_id
        AND g.depth_um = COALESCE(slides.cut_depth_um, sr.depth_um)
        AND g.stage_key = CASE slides.current_stage
          WHEN 'assigned' THEN 'stain_requested'
          WHEN 'cut' THEN 'stain_requested'
          ELSE slides.current_stage
        END
   )
 WHERE stack_id IS NOT NULL AND purpose = 'stain';

-- A copied early-stage group must not inherit future-stage timestamps from the
-- advanced companion that previously shared its 0.3.0 stack.
UPDATE slide_stacks
   SET stage_stained_at = CASE WHEN g.stage_rank >= 2 THEN stage_stained_at END,
       stage_deparaffinized_at = CASE WHEN g.stage_rank >= 3 THEN stage_deparaffinized_at END,
       stage_ihc_at = CASE WHEN g.stage_rank >= 4 THEN stage_ihc_at END,
       stage_refrax_at = CASE WHEN g.stage_rank >= 5 THEN stage_refrax_at END,
       stage_coverslipped_at = CASE WHEN g.stage_rank >= 6 THEN stage_coverslipped_at END,
       stage_dried_at = CASE WHEN g.stage_rank >= 7 THEN stage_dried_at END,
       stage_ready_for_imaging_at = CASE WHEN g.stage_rank >= 8 THEN stage_ready_for_imaging_at END,
       stage_pictures_taken_at = CASE WHEN g.stage_rank >= 9 THEN stage_pictures_taken_at END,
       stage_analyzed_at = CASE WHEN g.stage_rank >= 10 THEN stage_analyzed_at END
  FROM stack_group_targets g
 WHERE slide_stacks.id = g.target_stack_id;

-- Empty 0.3.0 stack rows have no physical group and should not survive as
-- nullable-depth cards.
DELETE FROM slide_stacks
 WHERE id NOT IN (SELECT target_stack_id FROM stack_group_targets);

DROP TABLE stack_group_targets;
DROP TABLE stack_groups_raw;

CREATE UNIQUE INDEX idx_slide_stacks_sample_depth_stage
    ON slide_stacks(sample_id, depth_um, current_stage)
    WHERE closed_at IS NULL;
CREATE INDEX idx_slide_stacks_sample_depth
    ON slide_stacks(sample_id, depth_um, current_stage, created_at);
