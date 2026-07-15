-- Kept separate so development databases that already applied migration 10
-- receive the expanded create/delete audit coverage too.
CREATE TRIGGER IF NOT EXISTS audit_sections_insert AFTER INSERT ON section_requests BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'create', 'section', NEW.id, 'Created section at ' || NEW.depth_um || ' um');
END;
CREATE TRIGGER IF NOT EXISTS audit_sections_delete AFTER DELETE ON section_requests BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'delete', 'section', OLD.id, 'Deleted section at ' || OLD.depth_um || ' um');
END;
CREATE TRIGGER IF NOT EXISTS audit_slides_insert AFTER INSERT ON slides BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'create', 'slide', NEW.id, 'Created slide ' || NEW.slide_code);
END;
CREATE TRIGGER IF NOT EXISTS audit_slides_delete AFTER DELETE ON slides BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'delete', 'slide', OLD.id, 'Deleted slide ' || OLD.slide_code);
END;
CREATE TRIGGER IF NOT EXISTS audit_batches_insert AFTER INSERT ON processing_batches BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'create', 'processing_batch', NEW.id, 'Created processing batch ' || NEW.id);
END;
