-- Each physical slide carries two tissue slices: an IgG control and one target
-- assay. The target assay is classified as a routine stain or IHC agent.

ALTER TABLE slides ADD COLUMN slice_count INTEGER NOT NULL DEFAULT 2;
ALTER TABLE slides ADD COLUMN control_agent TEXT NOT NULL DEFAULT 'IgG';
ALTER TABLE slides ADD COLUMN assay_type TEXT NOT NULL DEFAULT '';
ALTER TABLE slides ADD COLUMN assay_name TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS assay_catalog (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    assay_type TEXT NOT NULL CHECK (assay_type IN ('stain', 'ihc')),
    name       TEXT NOT NULL COLLATE NOCASE,
    is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (assay_type, name)
);

INSERT OR IGNORE INTO assay_catalog (assay_type, name) VALUES
    ('stain', 'H&E'),
    ('stain', 'Masson''s Trichrome'),
    ('stain', 'Alcian Blue'),
    ('stain', 'PAS'),
    ('stain', 'Safranin O'),
    ('ihc', 'CD3'),
    ('ihc', 'CD31'),
    ('ihc', 'CD68'),
    ('ihc', 'Ki-67'),
    ('ihc', 'α-SMA');
