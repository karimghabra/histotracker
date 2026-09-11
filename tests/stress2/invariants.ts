/**
 * The invariant catalogue for harness v2.
 *
 * v1 had fifteen invariants and **not one of them fired across twenty-one
 * tests**. They were the invariants that were easy to think of — orphaned rows,
 * duplicate keys, dangling foreign keys — and this app does not get those wrong.
 * Meanwhile all four real defects went straight past them, because each was a
 * *stamp asserting work that never happened*, which no referential check can see.
 *
 * So these are derived from the defects that were real, plus the classes those
 * defects belong to. Each returns rows; any row is a violation, and the row
 * itself is the evidence.
 */

export type Invariant = {
  id: string;
  /** What must be true, phrased as the claim a violation would disprove. */
  claim: string;
  query: string;
  /** Why this one exists — usually the defect that taught us to look. */
  because: string;
};

export const INVARIANTS: Invariant[] = [
  // ---------------------------------------------------------------- stamps
  {
    id: "imaged-implies-recorded",
    claim: "no slide carries an images-captured stamp without being in a stack that reached imaging",
    because:
      "D1 (0.12.0): completing imaging stamped every member of a per-sample stack, " +
      "including glass that arrived after the operator left the microscope.",
    query: `SELECT sl.slide_code AS code, sl.stage_pictures_taken_at AS imaged,
                   sl.stage_ready_for_imaging_at AS ready
              FROM slides sl
             WHERE sl.stage_pictures_taken_at IS NOT NULL
               AND sl.stage_ready_for_imaging_at IS NULL`,
  },
  {
    id: "analyzed-implies-imaged",
    claim: "no slide is analyzed without having been imaged",
    because: "The step after D1: the guard existed here but not one stage earlier.",
    query: `SELECT slide_code AS code, stage_analyzed_at AS analyzed
              FROM slides
             WHERE stage_analyzed_at IS NOT NULL AND stage_pictures_taken_at IS NULL`,
  },
  {
    id: "stained-implies-cut",
    claim: "no slide is stained before it was cut",
    because: "A stamp may never assert work that could not physically have happened yet.",
    query: `SELECT slide_code AS code, stage_stained_at AS stained, stage_cut_at AS cut
              FROM slides
             WHERE stage_stained_at IS NOT NULL AND stage_cut_at IS NULL`,
  },
  {
    id: "stage-order-monotone",
    claim: "a slide's stage stamps run forwards in time",
    because:
      "C2 (0.12.0): a rack tick rewrote stain dates, which can push a stamp BEHIND " +
      "the one before it. Monotonicity catches that class without knowing the cause.",
    query: `SELECT slide_code AS code, stage_cut_at AS cut, stage_stained_at AS stained,
                   stage_coverslipped_at AS coverslipped, stage_pictures_taken_at AS imaged,
                   stage_analyzed_at AS analyzed
              FROM slides
             WHERE (stage_stained_at IS NOT NULL AND stage_cut_at IS NOT NULL
                    AND stage_stained_at < stage_cut_at)
                OR (stage_coverslipped_at IS NOT NULL AND stage_stained_at IS NOT NULL
                    AND stage_coverslipped_at < stage_stained_at)
                OR (stage_pictures_taken_at IS NOT NULL AND stage_coverslipped_at IS NOT NULL
                    AND stage_pictures_taken_at < stage_coverslipped_at)
                OR (stage_analyzed_at IS NOT NULL AND stage_pictures_taken_at IS NOT NULL
                    AND stage_analyzed_at < stage_pictures_taken_at)`,
  },

  // ----------------------------------------------------------------- codes
  {
    id: "slide-code-unique",
    claim: "no two slides share a code, ever, including across a relabel",
    because:
      "C4 (0.13.0) moves a slide between blocks and issues it a new code. Two pieces " +
      "of glass with one code is the failure that makes a log worthless.",
    query: `SELECT slide_code AS code, COUNT(*) AS n FROM slides
             WHERE slide_code IS NOT NULL AND slide_code <> ''
             GROUP BY slide_code HAVING COUNT(*) > 1`,
  },
  {
    id: "code-matches-block",
    claim: "a slide's code names the block it is filed under",
    because:
      "C4 issues a new code from the target block's sequence. If the code and the " +
      "parent ever disagree, the log points at the wrong tissue.",
    query: `SELECT sl.slide_code AS code, s.sample_code AS parent
              FROM slides sl
              JOIN section_requests sr ON sr.id = sl.section_request_id
              JOIN samples s ON s.id = sr.sample_id
             WHERE sl.slide_code IS NOT NULL AND sl.slide_code <> ''
               AND sl.slide_code NOT LIKE s.sample_code || '-%'`,
  },
  {
    id: "letters-stay-burned",
    claim: "no live slide holds a letter above its block's high-water mark",
    because:
      "#73: letters must never be reissued. A relabel or an added slide that " +
      "forgets to record the mark hands the same letter out twice later.",
    query: `SELECT s.sample_code AS parent, s.slides_issued AS issued,
                   COUNT(sl.id) AS slides
              FROM samples s
              JOIN section_requests sr ON sr.sample_id = s.id
              JOIN slides sl ON sl.section_request_id = sr.id
             GROUP BY s.id
            HAVING COUNT(sl.id) > COALESCE(s.slides_issued, 0)`,
  },

  // -------------------------------------------------------------- the order
  {
    id: "request-is-immutable",
    claim: "an assay slide remembers what it was asked for",
    because:
      "C1 (0.13.0): `assay_name` was both the order and the result, so correcting a " +
      "slide erased the order. A stain slide with no recorded request means that " +
      "erasure is back.",
    query: `SELECT slide_code AS code, assay_name AS is_now, requested_assay_name AS asked
              FROM slides
             WHERE purpose = 'stain' AND current_stage <> 'removed'
               AND (requested_assay_name IS NULL OR TRIM(requested_assay_name) = '')`,
  },

  // ---------------------------------------------------------------- racks
  {
    id: "no-live-slide-in-retired-rack",
    claim: "no slide with work left to do sits in a rack that has been retired",
    because: "A retired rack is off the board; anything inside it is invisible for good.",
    query: `SELECT sl.slide_code AS code, st.id AS stack, st.closed_at AS closed
              FROM slides sl JOIN slide_stacks st ON st.id = sl.stack_id
             WHERE st.closed_at IS NOT NULL
               AND sl.current_stage NOT IN ('analyzed', 'removed')`,
  },
  {
    id: "no-empty-open-rack",
    claim: "no rack is open and empty",
    because: "An empty rack on the board is a promise of work that does not exist.",
    query: `SELECT st.id AS stack, st.assay_name AS assay FROM slide_stacks st
             WHERE st.closed_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM slides sl WHERE sl.stack_id = st.id)`,
  },
  {
    id: "removed-slide-holds-no-place",
    claim: "a removed slide holds no place in a rack",
    because: "#83: removal must take it off the board without deleting the record.",
    query: `SELECT slide_code AS code, stack_id AS stack FROM slides
             WHERE current_stage = 'removed' AND stack_id IS NOT NULL`,
  },
  {
    id: "one-open-stack-per-sample-stage",
    claim: "a block has at most one open stack per stage",
    because:
      "This is a UNIQUE index in the schema (0018). If a code path ever works " +
      "around it, the board shows a block twice and the merge rules stop meaning " +
      "anything — this is what made D2 unfixable by splitting.",
    query: `SELECT sample_id, current_stage, COUNT(*) AS n FROM slide_stacks
             WHERE kind = 'sample' AND closed_at IS NULL
             GROUP BY sample_id, current_stage HAVING COUNT(*) > 1`,
  },

  // --------------------------------------------------------------- purpose
  {
    id: "stain-slide-names-its-agent",
    claim: "a stain slide names the agent it carries",
    because: "An assay slide with no agent cannot be matched to a result.",
    query: `SELECT slide_code AS code FROM slides
             WHERE purpose = 'stain' AND current_stage <> 'removed'
               AND (assay_name IS NULL OR TRIM(assay_name) = '')`,
  },
  {
    id: "extra-claims-no-agent",
    claim: "an extra slide claims no agent",
    because:
      "Returning a slide to extras must clear what it was, or the Extras inventory " +
      "lists glass that reads as already stained.",
    query: `SELECT slide_code AS code, assay_name AS assay FROM slides
             WHERE purpose = 'extra' AND assay_name IS NOT NULL AND TRIM(assay_name) <> ''`,
  },

  // ------------------------------------------------------------ structure
  {
    id: "slides-have-a-group",
    claim: "every slide belongs to a cut group that exists",
    because: "C4 rewrites section_request_id; a bad write orphans real glass.",
    query: `SELECT sl.id AS slide FROM slides sl
              LEFT JOIN section_requests sr ON sr.id = sl.section_request_id
             WHERE sr.id IS NULL`,
  },
  {
    id: "groups-have-a-block",
    claim: "every cut group belongs to a block that exists",
    because: "C4 creates groups on the target block; a bad write orphans the group.",
    query: `SELECT sr.id AS section FROM section_requests sr
              LEFT JOIN samples s ON s.id = sr.sample_id
             WHERE s.id IS NULL`,
  },
  {
    id: "no-sample-in-two-open-runs",
    claim: "no block is in two live processing runs",
    because: "One block cannot be in two processors at once.",
    query: `SELECT bs.sample_id AS sample, COUNT(*) AS n
              FROM processing_batch_members bs
              JOIN processing_batches b ON b.id = bs.batch_id
             WHERE b.status IN ('planned', 'processing')
             GROUP BY bs.sample_id HAVING COUNT(*) > 1`,
  },

  // -------------------------------------------------------------- the record
  {
    id: "corrections-are-narrated",
    claim: "every relabelled slide left a trace on both blocks",
    because:
      "C4's policy: a correction that leaves no trace reads, later, exactly like the " +
      "mistake never happened.",
    query: `SELECT 'relabel events not paired' AS problem, COUNT(*) AS n
              FROM sample_timeline_events
             WHERE event_type LIKE 'slide_relabelled%'
            HAVING COUNT(*) % 2 <> 0`,
  },
  // ---- 0.14: racks as physical objects, and what that makes impossible ------
  //
  // Capacity, split and merge shipped in 0.14.0 with unit and e2e coverage and
  // NO fuzz coverage at all — the newest code in the app was the least walked.
  // These are the properties those operations must preserve no matter what
  // sequence reaches them.
  {
    id: "rack-within-capacity",
    claim: "no open staining rack holds more slides than a rack holds",
    because:
      "#123: a rack is 24 slides of physical hardware. A rack of forty is a board " +
      "showing something nobody can pick up — the complaint the setting exists for.",
    query: `SELECT ss.id AS rack, ss.assay_name AS agent, COUNT(sl.id) AS held,
                   COALESCE((SELECT CAST(value AS INTEGER) FROM app_settings
                              WHERE key = CASE WHEN ss.assay_type = 'ihc'
                                               THEN 'max_ihc_rack_slides'
                                               ELSE 'max_stain_rack_slides' END), 24) AS cap
              FROM slide_stacks ss
              JOIN slides sl ON sl.stack_id = ss.id AND sl.current_stage <> 'removed'
             WHERE ss.kind = 'stain' AND ss.closed_at IS NULL
             GROUP BY ss.id
            HAVING held > cap`,
  },
  {
    id: "rack-holds-one-agent",
    claim: "every slide in a staining rack carries that rack's agent",
    because:
      "A rack IS an agent plus the glass going through it. Split and merge both " +
      "move slides between racks, and either could put PAS glass in the H&E rack — " +
      "which is a mis-stain at the bench, not a display bug.",
    query: `SELECT sl.slide_code AS code, sl.assay_name AS slide_agent,
                   ss.assay_name AS rack_agent
              FROM slides sl JOIN slide_stacks ss ON ss.id = sl.stack_id
             WHERE ss.kind = 'stain' AND sl.purpose = 'stain'
               AND sl.current_stage <> 'removed'
               AND (sl.assay_name <> ss.assay_name OR sl.assay_type <> ss.assay_type)`,
  },
  {
    id: "racked-slide-was-cut",
    claim: "no slide sits in a staining rack before it was cut",
    because:
      "0.14.2: a retracted cut left its glass in the rack, and the next tick of " +
      "that rack stained a slide the app said was not cut. The stamp invariant " +
      "catches the consequence; this catches the state that causes it.",
    query: `SELECT sl.slide_code AS code, sl.stack_id AS rack
              FROM slides sl JOIN slide_stacks ss ON ss.id = sl.stack_id
             WHERE ss.kind = 'stain' AND sl.purpose = 'stain'
               AND sl.current_stage <> 'removed' AND sl.stage_cut_at IS NULL`,
  },
  {
    id: "removed-slide-keeps-its-record",
    claim: "a removed slide that was stained still says when it was cut",
    because:
      "0.14.2, and the founding rule (#83): a slide cut, stained and then broken " +
      "at the bench must not come back reading 'stained, never cut'. That is the " +
      "record of real work being rewritten.",
    query: `SELECT slide_code AS code, stage_stained_at AS stained
              FROM slides
             WHERE current_stage = 'removed'
               AND stage_stained_at IS NOT NULL AND stage_cut_at IS NULL`,
  },
  // There is no "rack-numbers-are-unique" invariant, and the self-check is why.
  //
  // It was written, and it could not fail. The number is defined as "how many
  // racks for this agent have an id at or below mine", which is injective over
  // distinct ids by construction — two racks can no more share a number than two
  // integers can. A query that cannot return a row is not a check, it is
  // decoration that reads like one, and a green run past it means nothing.
  //
  // The property that actually matters is that a rack's number does not MOVE,
  // and that is temporal: it compares two points in time, which no single
  // SELECT can do. It lives in tests/e2e/racks.spec.ts, where a rack is retired
  // and the survivors are checked to still show what they showed before.
  {
    id: "timeline-points-at-real-blocks",
    claim: "every timeline event names a block that exists",
    because: "The timeline is the posterity record; a dangling event is a lost story.",
    query: `SELECT e.id AS event FROM sample_timeline_events e
              LEFT JOIN samples s ON s.id = e.sample_id
             WHERE s.id IS NULL`,
  },
];
