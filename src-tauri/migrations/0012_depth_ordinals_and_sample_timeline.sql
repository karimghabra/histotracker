ALTER TABLE section_requests ADD COLUMN depth_index INTEGER;

WITH first_depths AS (
  SELECT id, sample_id, depth_um,
         MIN(id) OVER (PARTITION BY sample_id, depth_um) AS first_id
    FROM section_requests
), ranked AS (
  SELECT id,
         DENSE_RANK() OVER (PARTITION BY sample_id ORDER BY first_id) AS depth_index
    FROM first_depths
)
UPDATE section_requests
   SET depth_index = (SELECT ranked.depth_index FROM ranked WHERE ranked.id = section_requests.id);

-- Replace internal request IDs in existing public slide codes with D01, D02, etc.
-- Duplicate letters continue across repeated cuts at the same depth.
WITH ranked_slides AS (
  SELECT sl.id,
         ROW_NUMBER() OVER (
           PARTITION BY sr.sample_id, sr.depth_index ORDER BY sl.id
         ) AS depth_ordinal
    FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
)
UPDATE slides
   SET slide_code =
       (SELECT s.sample_code
          FROM section_requests sr JOIN samples s ON s.id = sr.sample_id
         WHERE sr.id = slides.section_request_id)
       || '-D' || printf('%02d',
          (SELECT sr.depth_index FROM section_requests sr WHERE sr.id = slides.section_request_id))
       || '-' ||
       CASE
         WHEN (SELECT depth_ordinal FROM ranked_slides WHERE ranked_slides.id = slides.id) <= 26 THEN
           substr('abcdefghijklmnopqrstuvwxyz',
                  (SELECT depth_ordinal FROM ranked_slides WHERE ranked_slides.id = slides.id), 1)
         ELSE
           substr('abcdefghijklmnopqrstuvwxyz', CAST(((SELECT depth_ordinal FROM ranked_slides WHERE ranked_slides.id = slides.id) - 1) / 26 AS INTEGER), 1)
           || substr('abcdefghijklmnopqrstuvwxyz', (((SELECT depth_ordinal FROM ranked_slides WHERE ranked_slides.id = slides.id) - 1) % 26) + 1, 1)
       END;

CREATE TABLE IF NOT EXISTS sample_timeline_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sample_id  INTEGER NOT NULL,
    user_id    INTEGER,
    event_type TEXT NOT NULL,
    summary    TEXT NOT NULL,
    details    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sample_timeline_sample
    ON sample_timeline_events(sample_id, created_at DESC, id DESC);
