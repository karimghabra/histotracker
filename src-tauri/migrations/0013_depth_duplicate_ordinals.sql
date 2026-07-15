ALTER TABLE slides ADD COLUMN depth_duplicate_ordinal INTEGER;

WITH ranked AS (
  SELECT sl.id,
         ROW_NUMBER() OVER (
           PARTITION BY sr.sample_id, sr.depth_index ORDER BY sl.id
         ) AS depth_ordinal
    FROM slides sl JOIN section_requests sr ON sr.id = sl.section_request_id
)
UPDATE slides
   SET depth_duplicate_ordinal =
       (SELECT depth_ordinal FROM ranked WHERE ranked.id = slides.id);

WITH labels AS (
  SELECT sl.id, s.sample_code, sr.depth_index, sl.depth_duplicate_ordinal
    FROM slides sl
    JOIN section_requests sr ON sr.id = sl.section_request_id
    JOIN samples s ON s.id = sr.sample_id
)
UPDATE slides
   SET slide_code =
       (SELECT sample_code FROM labels WHERE labels.id = slides.id)
       || '-D' || printf('%02d', (SELECT depth_index FROM labels WHERE labels.id = slides.id))
       || '-' || CASE
         WHEN depth_duplicate_ordinal <= 26 THEN
           substr('abcdefghijklmnopqrstuvwxyz', depth_duplicate_ordinal, 1)
         ELSE
           substr('abcdefghijklmnopqrstuvwxyz', CAST((depth_duplicate_ordinal - 1) / 26 AS INTEGER), 1)
           || substr('abcdefghijklmnopqrstuvwxyz', ((depth_duplicate_ordinal - 1) % 26) + 1, 1)
       END;
