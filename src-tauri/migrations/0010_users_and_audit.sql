CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
    initials   TEXT NOT NULL DEFAULT '',
    is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO users (name, initials)
SELECT DISTINCT TRIM(team_lead), UPPER(SUBSTR(TRIM(team_lead), 1, 3))
  FROM projects WHERE TRIM(team_lead) != '';

ALTER TABLE projects ADD COLUMN lead_user_id INTEGER;
UPDATE projects
   SET lead_user_id = (SELECT id FROM users WHERE users.name = projects.team_lead LIMIT 1)
 WHERE TRIM(team_lead) != '';

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('active_user_id', '');

CREATE TABLE IF NOT EXISTS audit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    action      TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   INTEGER,
    summary     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_user ON audit_events(user_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS audit_projects_insert AFTER INSERT ON projects BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'create', 'project', NEW.id, 'Created project ' || NEW.code);
END;
CREATE TRIGGER IF NOT EXISTS audit_projects_update AFTER UPDATE ON projects BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'update', 'project', NEW.id, 'Updated project ' || NEW.code);
END;
CREATE TRIGGER IF NOT EXISTS audit_samples_insert AFTER INSERT ON samples BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'create', 'sample', NEW.id, 'Created sample ' || NEW.sample_code);
END;
CREATE TRIGGER IF NOT EXISTS audit_samples_update AFTER UPDATE ON samples BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'update', 'sample', NEW.id, 'Updated sample ' || NEW.sample_code || ': ' || OLD.current_stage || ' -> ' || NEW.current_stage);
END;
CREATE TRIGGER IF NOT EXISTS audit_samples_delete AFTER DELETE ON samples BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'delete', 'sample', OLD.id, 'Deleted sample ' || OLD.sample_code);
END;
CREATE TRIGGER IF NOT EXISTS audit_sections_update AFTER UPDATE ON section_requests BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'update', 'section', NEW.id, 'Updated section: ' || OLD.current_stage || ' -> ' || NEW.current_stage);
END;
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
CREATE TRIGGER IF NOT EXISTS audit_slides_update AFTER UPDATE ON slides BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'update', 'slide', NEW.id, 'Updated slide ' || NEW.slide_code);
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
CREATE TRIGGER IF NOT EXISTS audit_batches_update AFTER UPDATE ON processing_batches BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'update', 'processing_batch', NEW.id, 'Updated processing batch ' || NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_batches_insert AFTER INSERT ON processing_batches BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'create', 'processing_batch', NEW.id, 'Created processing batch ' || NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_checklist_update AFTER UPDATE ON checklist_items BEGIN
  INSERT INTO audit_events(user_id, action, entity_type, entity_id, summary)
  VALUES (CAST(NULLIF((SELECT value FROM app_settings WHERE key='active_user_id'), '') AS INTEGER),
          'check', 'checklist_item', NEW.id, NEW.label || CASE WHEN NEW.is_complete=1 THEN ' completed' ELSE ' reopened' END);
END;
