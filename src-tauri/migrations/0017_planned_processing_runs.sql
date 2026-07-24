-- Planned processing runs (issues #4, #24). A batch can be scheduled for a
-- future start: it holds status 'planned' with the intended start time in
-- planned_start_at, and its member samples stay in pre-processing until the
-- technician confirms the actual start. Confirming transitions the batch to
-- 'processing', stamps the real start, and begins the countdown.
--
-- Additive only (a nullable column), so the synced SQLite payload stays
-- forward-compatible per docs/shared_data_sync.md §1 — but every workstation and
-- viewer must run the matching 0.3.2 build.
ALTER TABLE processing_batches ADD COLUMN planned_start_at TEXT;

CREATE INDEX IF NOT EXISTS idx_processing_batches_status
    ON processing_batches(status);
