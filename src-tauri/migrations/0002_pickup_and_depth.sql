-- Track the "picked up from processor" event and the deepest cut depth
-- ever requested for an embedded block (so blocks can be re-cut deeper later).
ALTER TABLE samples ADD COLUMN stage_picked_up_at TEXT;
ALTER TABLE samples ADD COLUMN max_cut_depth_um INTEGER;
