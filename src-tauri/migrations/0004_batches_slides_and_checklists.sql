-- Phase-zero operational foundations: persistent processing batches,
-- individual physical slides, and versioned checklist instances.

CREATE TABLE IF NOT EXISTS processing_batches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    processing_type TEXT NOT NULL CHECK (processing_type IN ('Short', 'Long')),
    operator_name   TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'processing',
    started_at      TEXT NOT NULL,
    ready_at        TEXT,
    collected_at    TEXT,
    completed_at    TEXT,
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processing_batch_members (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id         INTEGER NOT NULL,
    sample_id        INTEGER NOT NULL,
    exception_reason TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (batch_id, sample_id),
    FOREIGN KEY (batch_id) REFERENCES processing_batches(id) ON DELETE CASCADE,
    FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_processing_batch_members_sample
    ON processing_batch_members(sample_id);

ALTER TABLE section_requests ADD COLUMN stage_assignment_required_at TEXT;

CREATE TABLE IF NOT EXISTS slides (
    id                         INTEGER PRIMARY KEY AUTOINCREMENT,
    section_request_id         INTEGER NOT NULL,
    slide_ordinal              INTEGER NOT NULL,
    slide_code                 TEXT NOT NULL,
    purpose                    TEXT NOT NULL DEFAULT 'unassigned'
                               CHECK (purpose IN ('unassigned', 'stain', 'extra', 'control', 'exception')),
    stain_name                 TEXT NOT NULL DEFAULT '',
    current_stage              TEXT NOT NULL DEFAULT 'planned',
    stage_cut_at               TEXT,
    stage_stain_requested_at   TEXT,
    stage_staining_started_at  TEXT,
    stage_stained_at           TEXT,
    stage_pictures_taken_at    TEXT,
    stage_analyzed_at          TEXT,
    location                   TEXT NOT NULL DEFAULT '',
    notes                      TEXT NOT NULL DEFAULT '',
    created_at                 TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (section_request_id, slide_ordinal),
    UNIQUE (slide_code),
    FOREIGN KEY (section_request_id) REFERENCES section_requests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_slides_section_request ON slides(section_request_id);
CREATE INDEX IF NOT EXISTS idx_slides_purpose ON slides(purpose);

CREATE TABLE IF NOT EXISTS checklist_runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type       TEXT NOT NULL,
    scope_id         INTEGER NOT NULL,
    stage_key        TEXT NOT NULL,
    protocol_name    TEXT NOT NULL,
    protocol_version INTEGER NOT NULL DEFAULT 1,
    completed_at     TEXT,
    created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (scope_type, scope_id, stage_key)
);

CREATE TABLE IF NOT EXISTS checklist_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    checklist_run_id INTEGER NOT NULL,
    item_key        TEXT NOT NULL,
    label           TEXT NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_required     INTEGER NOT NULL DEFAULT 1 CHECK (is_required IN (0, 1)),
    is_complete     INTEGER NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1)),
    completed_by    TEXT NOT NULL DEFAULT '',
    completed_at    TEXT,
    notes           TEXT NOT NULL DEFAULT '',
    UNIQUE (checklist_run_id, item_key),
    FOREIGN KEY (checklist_run_id) REFERENCES checklist_runs(id) ON DELETE CASCADE
);

