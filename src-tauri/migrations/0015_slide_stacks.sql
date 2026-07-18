-- A slide stack owns the downstream assay and imaging lifecycle for one sample.
-- Section requests remain the cut groups that produced the physical slides.
CREATE TABLE IF NOT EXISTS slide_stacks (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    sample_id                   INTEGER NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_slide_stacks_one_open_per_sample
    ON slide_stacks(sample_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_slide_stacks_stage
    ON slide_stacks(current_stage, created_at);

ALTER TABLE slides ADD COLUMN stack_id INTEGER REFERENCES slide_stacks(id) ON DELETE SET NULL;
ALTER TABLE slides ADD COLUMN cut_depth_um INTEGER;
ALTER TABLE slides ADD COLUMN cut_depth_index INTEGER;
CREATE INDEX IF NOT EXISTS idx_slides_stack ON slides(stack_id);

-- Extend the audit stream with stable reporting context for stack operations.
ALTER TABLE audit_events ADD COLUMN sample_id INTEGER;
ALTER TABLE audit_events ADD COLUMN stack_id INTEGER;
ALTER TABLE audit_events ADD COLUMN details TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_audit_events_sample_created
    ON audit_events(sample_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS audit_slide_stacks_insert AFTER INSERT ON slide_stacks BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary, sample_id, stack_id, details)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'create', 'slide_stack', NEW.id, 'Created slide stack ' || NEW.id,
          NEW.sample_id, NEW.id, 'stage=' || NEW.current_stage);
END;
CREATE TRIGGER IF NOT EXISTS audit_slide_stacks_update AFTER UPDATE ON slide_stacks BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary, sample_id, stack_id, details)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'update', 'slide_stack', NEW.id,
          'Updated slide stack ' || NEW.id || ': ' || OLD.current_stage || ' -> ' || NEW.current_stage,
          NEW.sample_id, NEW.id, 'stage=' || NEW.current_stage);
END;
CREATE TRIGGER IF NOT EXISTS audit_slide_stacks_delete AFTER DELETE ON slide_stacks BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary, sample_id, stack_id, details)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'delete', 'slide_stack', OLD.id, 'Deleted slide stack ' || OLD.id,
          OLD.sample_id, OLD.id, 'stage=' || OLD.current_stage);
END;

-- Recreate slide triggers so every physical-slide event carries stable sample
-- and stack context for the Log and Manifest queries.
DROP TRIGGER IF EXISTS audit_slides_insert;
DROP TRIGGER IF EXISTS audit_slides_update;
DROP TRIGGER IF EXISTS audit_slides_delete;
CREATE TRIGGER audit_slides_insert AFTER INSERT ON slides BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary, sample_id, stack_id, details)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'create', 'slide', NEW.id, 'Created slide ' || NEW.slide_code,
          (SELECT sample_id FROM section_requests WHERE id = NEW.section_request_id),
          NEW.stack_id, 'stage=' || NEW.current_stage);
END;
CREATE TRIGGER audit_slides_update AFTER UPDATE ON slides BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary, sample_id, stack_id, details)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'update', 'slide', NEW.id, 'Updated slide ' || NEW.slide_code,
          (SELECT sample_id FROM section_requests WHERE id = NEW.section_request_id),
          NEW.stack_id, 'stage=' || NEW.current_stage);
END;
CREATE TRIGGER audit_slides_delete AFTER DELETE ON slides BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary, sample_id, stack_id, details)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'delete', 'slide', OLD.id, 'Deleted slide ' || OLD.slide_code,
          (SELECT sample_id FROM section_requests WHERE id = OLD.section_request_id),
          OLD.stack_id, 'stage=' || OLD.current_stage);
END;
