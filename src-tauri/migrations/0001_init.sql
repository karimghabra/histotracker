-- Histometer schema, ported from the Python/SQLite prototype.

CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    team_lead   TEXT NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS samples (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id                INTEGER NOT NULL,
    project_sample_number     INTEGER,
    sample_code               TEXT NOT NULL,
    sample_description        TEXT NOT NULL DEFAULT '',
    date_added                TEXT NOT NULL,
    processing_type           TEXT NOT NULL CHECK (processing_type IN ('Short', 'Long')),
    fixative_agent            TEXT NOT NULL DEFAULT 'PFA',
    needs_decalcification     INTEGER NOT NULL DEFAULT 0 CHECK (needs_decalcification IN (0, 1)),
    cut_notes                 TEXT NOT NULL DEFAULT '',
    slide_notes               TEXT NOT NULL DEFAULT '',
    stains                    TEXT NOT NULL DEFAULT '',
    overall_notes             TEXT NOT NULL DEFAULT '',
    sectioning_plan           TEXT NOT NULL DEFAULT '',
    current_stage             TEXT NOT NULL DEFAULT 'received',
    stage_received_at         TEXT,
    decalc_completed_at       TEXT,
    fixative_placed_at        TEXT,
    fixative_removed_at       TEXT,
    ethanol_placed_at         TEXT,
    processing_started_at     TEXT,
    stage_processed_at        TEXT,
    stage_needs_embedding_at  TEXT,
    stage_embedded_at         TEXT,
    stage_needs_sectioning_at TEXT,
    stage_sectioned_at        TEXT,
    stage_stain_requested_at  TEXT,
    stage_stained_at          TEXT,
    stage_deparaffinized_at   TEXT,
    stage_ihc_at              TEXT,
    stage_pictures_taken_at   TEXT,
    stage_analyzed_at         TEXT,
    created_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_samples_project_code
    ON samples(project_id, sample_code);
