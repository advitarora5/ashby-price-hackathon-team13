-- Claripath application database. Small answers live here; big arrays live in
-- Parquet/.npy files referenced by artifact_manifests. All ids are stable strings.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS slides (
    slide_id      TEXT PRIMARY KEY,
    dataset       TEXT NOT NULL,              -- camelyon16 | crowdgleason | nct | demo
    organ         TEXT NOT NULL,              -- lymph_node | prostate | colon
    width         INTEGER,
    height        INTEGER,
    mpp           REAL,
    tile_w0       INTEGER,                    -- tile side in level-0 px (see geometry.py)
    grid_rows     INTEGER,
    grid_cols     INTEGER,
    image_path    TEXT,                       -- local WSI path (may be absent on the laptop)
    dzi_path      TEXT,                       -- pre-rendered DZI (optional)
    split         TEXT,                       -- train | val | test | demo
    fold          INTEGER,
    slide_label   TEXT,                       -- ground truth: evaluation only, never sent to the review UI
    status        TEXT NOT NULL DEFAULT 'ok', -- ok | unreadable | no_tissue | no_mpp
    status_detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_slides_dataset ON slides(dataset, split);

CREATE TABLE IF NOT EXISTS cases (
    case_id            TEXT PRIMARY KEY,
    slide_id           TEXT NOT NULL REFERENCES slides(slide_id),
    disagreement_score REAL,                 -- NULL when < 2 models available
    disagreement_source TEXT,                -- e.g. disagreement_v1(quiltnet,plip)
    tier               TEXT,                 -- fast | slow | unavailable
    tier_rule          TEXT,                 -- validation_cutoff | rank_top15 | unavailable
    artifact_share     REAL,
    ai_max_risk        REAL,
    uncertainty_score  REAL,                 -- 90th pct of tile tumour-probe entropy (baseline signal)
    routing_signal     TEXT,                 -- which score set the tier: disagreement | entropy                 -- max smoothed tumour prob over non-artifact tissue (routing only)
    tissue_artifact_share REAL,              -- blur/ink/fold tiles / tissue tiles (blank glass excluded)
    tier_reasons       TEXT,                 -- comma list of what sent a case to the slow path: disagreement | entropy | artifacts
    review_status      TEXT NOT NULL DEFAULT 'unread'  -- unread | in_review | signed_out
);

CREATE TABLE IF NOT EXISTS readers (
    reader_id        TEXT PRIMARY KEY,
    dataset          TEXT NOT NULL,          -- pathogaze | crowdgleason | live
    experience_level TEXT
);

CREATE TABLE IF NOT EXISTS reads (
    read_id          TEXT PRIMARY KEY,
    slide_id         TEXT REFERENCES slides(slide_id),
    patch_id         TEXT,
    case_id          TEXT REFERENCES cases(case_id),
    reader_id        TEXT REFERENCES readers(reader_id),
    source           TEXT NOT NULL,          -- live | pathogaze | crowdgleason | replay
    review_mode      TEXT,                   -- aided | blind
    coverage_mode    TEXT,                   -- gaze | viewport
    initial_decision TEXT,
    final_decision   TEXT,
    seconds          REAL,
    started_at       TEXT,
    signed_out_at    TEXT,
    replay_of        TEXT,                   -- read_id of the recorded read being replayed
    last_light       TEXT,                   -- most recent sign-out light
    signout_attempts INTEGER NOT NULL DEFAULT 0,
    second_decision  TEXT,                   -- additional human readers (never the AI)
    third_decision   TEXT,
    notes            TEXT,                   -- the reader's full free-text notes for the case
    notes_saved_at   TEXT                    -- first save; on blind reads this (plus an assessment) unlocks the AI
);
CREATE INDEX IF NOT EXISTS ix_reads_slide ON reads(slide_id, source);

-- The reader's verdict on each AI feature bar (whole case), with an optional note.
CREATE TABLE IF NOT EXISTS feature_reviews (
    read_id    TEXT NOT NULL REFERENCES reads(read_id),
    feature_id TEXT NOT NULL,
    verdict    TEXT NOT NULL,                -- agree | disagree | unsure
    note       TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (read_id, feature_id)
);

-- Every saved version of the reader's notes (feature_id '' = the main case notes) and of
-- each feature verdict + note. Append-only: edits add a row, nothing is overwritten.
CREATE TABLE IF NOT EXISTS note_versions (
    read_id    TEXT NOT NULL REFERENCES reads(read_id),
    feature_id TEXT NOT NULL DEFAULT '',
    version    INTEGER NOT NULL,
    verdict    TEXT,
    text       TEXT,
    saved_at   TEXT NOT NULL,
    PRIMARY KEY (read_id, feature_id, version)
);

CREATE TABLE IF NOT EXISTS patches (
    patch_id  TEXT PRIMARY KEY,
    slide_id  TEXT NOT NULL,
    dataset   TEXT NOT NULL,
    split     TEXT NOT NULL,
    image_path TEXT
);

CREATE TABLE IF NOT EXISTS labels (
    patch_id   TEXT NOT NULL,
    annotator  TEXT NOT NULL,                -- resident1..7 | expert | MV | DS | GLAD | MACE
    label      INTEGER NOT NULL,
    is_expert  INTEGER NOT NULL DEFAULT 0,
    is_aggregate INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (patch_id, annotator)
);

CREATE TABLE IF NOT EXISTS regions (
    region_id    TEXT PRIMARY KEY,
    slide_id     TEXT NOT NULL REFERENCES slides(slide_id),
    kind         TEXT NOT NULL,              -- evidence | disputed | unseen
    x INTEGER, y INTEGER, w INTEGER, h INTEGER,   -- level-0 px
    n_tiles      INTEGER,
    risk         REAL,
    disagreement REAL,
    rank         INTEGER,
    peak_tile_id TEXT,
    read_id      TEXT REFERENCES reads(read_id),   -- only for kind = unseen
    source       TEXT                        -- model / recipe that produced it
);
CREATE INDEX IF NOT EXISTS ix_regions_slide ON regions(slide_id, kind, rank);

CREATE TABLE IF NOT EXISTS alerts (
    alert_id   TEXT PRIMARY KEY,
    read_id    TEXT NOT NULL REFERENCES reads(read_id),
    region_id  TEXT NOT NULL REFERENCES regions(region_id),
    shown_rank INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'shown',  -- shown | revisited | dismissed
    light      TEXT,
    created_at TEXT NOT NULL,
    revisited_at TEXT,
    hit_tumor  INTEGER                       -- evaluation only; never served to the review UI
);
CREATE INDEX IF NOT EXISTS ix_alerts_read ON alerts(read_id);

CREATE TABLE IF NOT EXISTS view_events (
    read_id   TEXT NOT NULL REFERENCES reads(read_id),
    seq       INTEGER NOT NULL,              -- client sequence number (dedupe + ordering)
    t_ms      REAL NOT NULL,
    kind      TEXT NOT NULL,                 -- viewport | fixation
    x REAL, y REAL, w REAL, h REAL,          -- viewport rect or fixation point (w,h NULL) in level-0 px
    zoom      REAL,                          -- screen px per level-0 px
    duration_ms REAL,
    eye_mm    REAL,
    PRIMARY KEY (read_id, seq)
);

CREATE TABLE IF NOT EXISTS policy_runs (
    run_id         TEXT PRIMARY KEY,
    policy         TEXT NOT NULL,
    params         TEXT,                     -- JSON
    dataset        TEXT NOT NULL,
    n_cases        INTEGER,
    reads_per_100  REAL,
    agreement      REAL,                     -- 4-class accuracy vs expert
    kappa          REAL,                     -- quadratic weighted kappa vs expert
    cancer_acc     REAL,
    highgrade_acc  REAL,
    ci_low         REAL,
    ci_high        REAL,
    reads_ci_low   REAL,
    reads_ci_high  REAL,
    noninferior    INTEGER,                  -- vs reference policy, NULL if not tested
    provenance     TEXT,                     -- real_human_labels | requires_ai_predictions ...
    created        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_case_results (
    run_id          TEXT NOT NULL REFERENCES policy_runs(run_id),
    patch_id        TEXT NOT NULL,
    expected_reads  REAL NOT NULL,
    p_correct       REAL NOT NULL,
    PRIMARY KEY (run_id, patch_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
    event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT NOT NULL,
    session_id    TEXT,
    read_id       TEXT,
    case_id       TEXT,
    action        TEXT NOT NULL,             -- case_opened | evidence_shown | blind_assessment | ...
    ai_visible    INTEGER,                   -- was AI evidence on screen when this happened
    review_order  TEXT,                      -- blind | aided
    decision_before TEXT,
    decision_after  TEXT,
    override      INTEGER,
    detail        TEXT                       -- JSON
);
CREATE INDEX IF NOT EXISTS ix_audit_read ON audit_events(read_id, event_id);

CREATE TABLE IF NOT EXISTS artifact_manifests (
    slide_id      TEXT NOT NULL,
    artifact_type TEXT NOT NULL,             -- tiles | scores | emb_quiltnet | dzi | thumb | ...
    file_path     TEXT NOT NULL,
    n_rows        INTEGER,
    row_digest    TEXT,                      -- ids.sequence_digest of tile_id order
    model_version TEXT,
    preprocessing_version TEXT,
    provenance    TEXT,                      -- real | dev_uncalibrated | ...
    created       TEXT NOT NULL,
    PRIMARY KEY (slide_id, artifact_type)
);

CREATE TABLE IF NOT EXISTS replay_state (
    replay_read_id TEXT PRIMARY KEY REFERENCES reads(read_id),
    source_read_id TEXT NOT NULL,
    cursor         INTEGER NOT NULL DEFAULT 0,
    n_events       INTEGER NOT NULL,
    done           INTEGER NOT NULL DEFAULT 0
);
