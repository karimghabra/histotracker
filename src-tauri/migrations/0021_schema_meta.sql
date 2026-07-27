-- A tiny key/value table for one-time DATA translations that can't be expressed
-- as a schema change. Unlike app_settings (which the session-preserving restore
-- re-applies from the live install), schema_meta travels WITH the database image
-- — so a marker set here correctly reverts/rides along with the data it describes.
-- Additive + idempotent — sync-safe (see docs/shared_data_sync.md §1a).
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);
