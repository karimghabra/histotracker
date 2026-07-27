-- Depth tagging (#69): slides can be grouped by a depth label ("surface",
-- "100um deep", …) with a free note, applied to several slides at once from the
-- Logs view. Additive columns with defaults — every older image/backup keeps
-- loading, so this is compatible with previous versions (docs/shared_data_sync.md
-- §1a). ensureRuntimeSchema also converges these on any swapped-in image.
ALTER TABLE slides ADD COLUMN depth_label TEXT NOT NULL DEFAULT '';
ALTER TABLE slides ADD COLUMN depth_note  TEXT NOT NULL DEFAULT '';
