ALTER TABLE samples ADD COLUMN is_priority INTEGER NOT NULL DEFAULT 0
    CHECK (is_priority IN (0, 1));
ALTER TABLE samples ADD COLUMN prioritized_at TEXT;

CREATE INDEX IF NOT EXISTS idx_samples_priority
    ON samples(is_priority DESC, prioritized_at DESC);
