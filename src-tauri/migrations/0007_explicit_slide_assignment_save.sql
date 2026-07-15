-- Extra is the initial draft, but assignment must be explicitly confirmed.
ALTER TABLE slides ADD COLUMN assignment_saved INTEGER NOT NULL DEFAULT 0
    CHECK (assignment_saved IN (0, 1));
