-- 0.3.3 — Remove section depth entirely (issue #5) and reshape slide_stacks for
-- the cross-sample, agent-scoped staining model.
--
-- DESTRUCTIVE: depth is discarded and slide_stacks is rebuilt. The synced
-- SQLite payload is the wire format (docs/shared_data_sync.md §1), so every
-- workstation and viewer must run the matching 0.3.3 build together.
--
-- New stack model:
--   kind='stain'  → a cross-sample rack. assay_type/assay_name identify the
--                   reagent agent; sample_id is NULL. Racks group slides of the
--                   same agent while they move through the reagents together and
--                   never merge, so staggered racks stay independent.
--   kind='sample' → a per-sample downstream stack (imaging/analysis onward),
--                   sample_id set, assay_* NULL.

-- --------------------------------------------------------------------------
-- 1. Recreate the section audit triggers WITHOUT depth_um (they embed it in the
--    summary text and would otherwise block dropping the column).
-- --------------------------------------------------------------------------
DROP TRIGGER IF EXISTS audit_sections_insert;
DROP TRIGGER IF EXISTS audit_sections_delete;
CREATE TRIGGER audit_sections_insert AFTER INSERT ON section_requests BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary, sample_id)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'create', 'section', NEW.id, 'Created cut group ' || NEW.id, NEW.sample_id);
END;
CREATE TRIGGER audit_sections_delete AFTER DELETE ON section_requests BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary, sample_id)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'delete', 'section', OLD.id, 'Deleted cut group ' || OLD.id, OLD.sample_id);
END;

-- --------------------------------------------------------------------------
-- 2. Rebuild slide_stacks. Detach slides first so the old table (and its
--    depth columns, indexes, and triggers) can be dropped cleanly, then
--    reconstruct membership from each slide's current stage.
-- --------------------------------------------------------------------------
UPDATE slides SET stack_id = NULL;

DROP TABLE slide_stacks;

CREATE TABLE slide_stacks (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind                        TEXT NOT NULL DEFAULT 'sample'
                                CHECK (kind IN ('stain', 'sample')),
    assay_type                  TEXT,
    assay_name                  TEXT,
    sample_id                   INTEGER,
    current_stage               TEXT NOT NULL DEFAULT 'stain_requested',
    stage_stain_requested_at    TEXT,
    stage_stained_at            TEXT,
    stage_deparaffinized_at     TEXT,
    stage_ihc_at                TEXT,
    stage_refrax_at             TEXT,
    stage_coverslipped_at       TEXT,
    stage_dried_at              TEXT,
    stage_ready_for_imaging_at  TEXT,
    stage_pictures_taken_at     TEXT,
    stage_analyzed_at           TEXT,
    closed_at                   TEXT,
    created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE CASCADE
);

-- One open per-sample stack per stage; stain racks are deliberately un-indexed
-- so same-agent racks may coexist at the same substage.
CREATE UNIQUE INDEX idx_slide_stacks_sample_stage
    ON slide_stacks(sample_id, current_stage)
    WHERE kind = 'sample' AND closed_at IS NULL;
CREATE INDEX idx_slide_stacks_stain_agent
    ON slide_stacks(assay_type, assay_name, current_stage)
    WHERE kind = 'stain' AND closed_at IS NULL;

-- Audit triggers (dropped with the old table) — recreated for the new shape.
CREATE TRIGGER audit_slide_stacks_insert AFTER INSERT ON slide_stacks BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary, sample_id, stack_id, details)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'create', 'slide_stack', NEW.id, 'Created slide stack ' || NEW.id,
          NEW.sample_id, NEW.id, 'kind=' || NEW.kind || ' stage=' || NEW.current_stage);
END;
CREATE TRIGGER audit_slide_stacks_update AFTER UPDATE ON slide_stacks BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary, sample_id, stack_id, details)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'update', 'slide_stack', NEW.id,
          'Updated slide stack ' || NEW.id || ': ' || OLD.current_stage || ' -> ' || NEW.current_stage,
          NEW.sample_id, NEW.id, 'kind=' || NEW.kind || ' stage=' || NEW.current_stage);
END;
CREATE TRIGGER audit_slide_stacks_delete AFTER DELETE ON slide_stacks BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary, sample_id, stack_id, details)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'delete', 'slide_stack', OLD.id, 'Deleted slide stack ' || OLD.id,
          OLD.sample_id, OLD.id, 'kind=' || OLD.kind || ' stage=' || OLD.current_stage);
END;

-- Reconstruct stain racks: cross-sample, grouped by agent + substage.
INSERT INTO slide_stacks (kind, assay_type, assay_name, sample_id, current_stage, stage_stain_requested_at)
SELECT 'stain', sl.assay_type, sl.assay_name, NULL, sl.current_stage,
       MIN(sl.stage_stain_requested_at)
  FROM slides sl
 WHERE sl.purpose = 'stain'
   AND sl.current_stage IN ('stain_requested', 'stained', 'deparaffinized',
                            'ihc_complete', 'refrax_complete', 'coverslipped', 'dried')
 GROUP BY sl.assay_type, sl.assay_name, sl.current_stage;

UPDATE slides
   SET stack_id = (
     SELECT ss.id FROM slide_stacks ss
      WHERE ss.kind = 'stain'
        AND ss.assay_type = slides.assay_type
        AND ss.assay_name = slides.assay_name
        AND ss.current_stage = slides.current_stage
   )
 WHERE purpose = 'stain'
   AND current_stage IN ('stain_requested', 'stained', 'deparaffinized',
                        'ihc_complete', 'refrax_complete', 'coverslipped', 'dried');

-- Reconstruct per-sample downstream stacks (imaging onward).
INSERT INTO slide_stacks (kind, sample_id, current_stage)
SELECT 'sample', sr.sample_id, sl.current_stage
  FROM slides sl
  JOIN section_requests sr ON sr.id = sl.section_request_id
 WHERE sl.purpose = 'stain'
   AND sl.current_stage IN ('ready_for_imaging', 'pictures_taken', 'analyzed')
 GROUP BY sr.sample_id, sl.current_stage;

UPDATE slides
   SET stack_id = (
     SELECT ss.id FROM slide_stacks ss
      JOIN section_requests sr ON sr.id = slides.section_request_id
      WHERE ss.kind = 'sample'
        AND ss.sample_id = sr.sample_id
        AND ss.current_stage = slides.current_stage
   )
 WHERE purpose = 'stain'
   AND current_stage IN ('ready_for_imaging', 'pictures_taken', 'analyzed');

-- --------------------------------------------------------------------------
-- 3. Drop every remaining depth column (issue #5).
-- --------------------------------------------------------------------------
ALTER TABLE slides DROP COLUMN depth_duplicate_ordinal;
ALTER TABLE slides DROP COLUMN cut_depth_um;
ALTER TABLE slides DROP COLUMN cut_depth_index;
ALTER TABLE section_requests DROP COLUMN depth_um;
ALTER TABLE section_requests DROP COLUMN depth_index;
ALTER TABLE samples DROP COLUMN max_cut_depth_um;
