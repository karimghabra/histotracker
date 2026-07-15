-- Section requests: individual cut groups produced from an embedded block.
-- Each flows independently through Needs Sectioning -> Staining/IHC -> Analysis,
-- while its parent block stays permanently in Embedded Inventory.
CREATE TABLE IF NOT EXISTS section_requests (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    sample_id                 INTEGER NOT NULL,
    depth_um                  INTEGER NOT NULL DEFAULT 0,
    duplicates                INTEGER NOT NULL DEFAULT 1,
    stains                    TEXT NOT NULL DEFAULT '',
    notes                     TEXT NOT NULL DEFAULT '',
    current_stage             TEXT NOT NULL DEFAULT 'needs_sectioning',
    stage_needs_sectioning_at TEXT,
    stage_sectioned_at        TEXT,
    stage_stain_requested_at  TEXT,
    stage_stained_at          TEXT,
    stage_deparaffinized_at   TEXT,
    stage_ihc_at              TEXT,
    stage_pictures_taken_at   TEXT,
    stage_analyzed_at         TEXT,
    created_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_section_requests_sample ON section_requests(sample_id);

-- A block leaves Embedded Inventory only when explicitly marked exhausted.
ALTER TABLE samples ADD COLUMN block_exhausted INTEGER NOT NULL DEFAULT 0;
