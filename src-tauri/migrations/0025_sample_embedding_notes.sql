-- Free-text orientation/instructions captured at sample intake for the
-- embedding bench. Additive so older database images and backups remain valid.
ALTER TABLE samples ADD COLUMN embedding_notes TEXT NOT NULL DEFAULT '';
