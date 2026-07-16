-- Durable records of stain/IHC requests submitted by viewer instances and
-- ingested by the authoritative workstation from the shared repo's request
-- inbox. The request files in the repo are transient (deleted after ingest);
-- this table is the permanent record and rides back down in each snapshot so
-- requesters can see status move requested -> acknowledged -> done.
CREATE TABLE IF NOT EXISTS stain_requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid            TEXT NOT NULL UNIQUE,           -- request-file id from the repo inbox (idempotent ingest)
    sample_code     TEXT NOT NULL DEFAULT '',       -- target sample (denormalized human code)
    slide_code      TEXT NOT NULL DEFAULT '',       -- target slide, when a specific slide was named
    requested_assay TEXT NOT NULL DEFAULT '',       -- requested stain/IHC name
    requester_name  TEXT NOT NULL DEFAULT '',       -- who asked (self-asserted on the viewer)
    note            TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested', 'acknowledged', 'done', 'rejected')),
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- when the viewer created the request
    ingested_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- when the workstation imported it
    resolved_by     TEXT NOT NULL DEFAULT '',
    resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_stain_requests_status ON stain_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stain_requests_sample ON stain_requests(sample_code);
