-- Deparaffinization is now a tracked first step of the stain/IHC protocol, so a
-- slide records when it happened. (samples, section_requests and slide_stacks
-- already carry stage_deparaffinized_at; only the slides table was missing it.)
-- Additive column — sync-safe (see docs/shared_data_sync.md §1).
ALTER TABLE slides ADD COLUMN stage_deparaffinized_at TEXT;
