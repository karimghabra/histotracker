-- Additive only (docs/shared_data_sync.md §1): two new nullable/defaulted
-- columns on samples. Older builds ignore them; older images converge via
-- ensureRuntimeSchema() in src/lib/db.ts.

-- #73 — slide letters must never be REUSED. Letters were issued from
-- COUNT(slides for this sample) + 1, so deleting slide C made the next cut
-- reissue "C". This is the high-water mark of letters ever issued for the
-- sample; it only ever moves forward, so C stays burned and the next slide is E.
-- Default 0 means "not tracked yet": existing databases fall back to the old
-- COUNT until their first cut on the new build, which reproduces today's
-- behaviour exactly and then takes over.
ALTER TABLE samples ADD COLUMN slides_issued INTEGER NOT NULL DEFAULT 0;

-- #74 — archiving hides a sample from the working views without deleting it or
-- disturbing any numbering. NULL = live, a timestamp = archived (and restorable).
ALTER TABLE samples ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_samples_archived ON samples(archived_at);
