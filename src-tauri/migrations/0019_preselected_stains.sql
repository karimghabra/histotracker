-- 0.3.3 — Stains chosen at sample creation (issues #1, #4). Stored as a JSON
-- array of {assay_type, assay_name}; drives the "needs staining" flag and the
-- auto-generated sectioning plan when the block is embedded. Additive.
ALTER TABLE samples ADD COLUMN preselected_stains TEXT NOT NULL DEFAULT '';
