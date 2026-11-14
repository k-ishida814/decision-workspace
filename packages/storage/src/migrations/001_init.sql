-- ADR-0003: one database per project; the daemon is the only writer.
-- Later schema changes go in new numbered files; PRAGMA user_version counts the applied ones.

CREATE TABLE decisions (
  seq           INTEGER PRIMARY KEY,
  id            TEXT    NOT NULL UNIQUE,            -- "D-<seq>"
  origin        TEXT    NOT NULL DEFAULT 'manual',  -- ask | plan | manual
  plan_id       TEXT,
  batch_id      TEXT,                               -- AskUserQuestion tool_use_id
  batch_index   INTEGER,
  session_id    TEXT,
  title         TEXT    NOT NULL,
  question      TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  allow_other   INTEGER NOT NULL,
  options_json  TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  held          INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL,                   -- optimistic lock (DQ-07)
  revision      INTEGER NOT NULL DEFAULT 0,         -- answers recorded (DQ-05)
  answer_json   TEXT,
  rationale     TEXT,
  closed_reason TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX decisions_status ON decisions (status);
CREATE INDEX decisions_batch  ON decisions (batch_id);
CREATE INDEX decisions_plan   ON decisions (plan_id);

-- Every answer ever given. Never updated or deleted.
CREATE TABLE revisions (
  decision_id TEXT    NOT NULL REFERENCES decisions (id),
  revision    INTEGER NOT NULL,
  answer_json TEXT    NOT NULL,
  rationale   TEXT,
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (decision_id, revision)
);

-- Audit trail of state changes.
CREATE TABLE events (
  seq         INTEGER PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions (id),
  type        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  reason      TEXT,
  at          TEXT NOT NULL
);

-- Decision graph (DG-01).
CREATE TABLE dependencies (
  decision_id       TEXT NOT NULL REFERENCES decisions (id),
  depends_on        TEXT NOT NULL REFERENCES decisions (id),
  when_options_json TEXT,                -- NULL = unconditional
  PRIMARY KEY (decision_id, depends_on)
);
CREATE INDEX dependencies_parent ON dependencies (depends_on);

CREATE TABLE plans (
  seq        INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,       -- "P-<seq>"
  request    TEXT NOT NULL,
  source     TEXT NOT NULL,             -- user | claude
  session_id TEXT,
  status     TEXT NOT NULL,             -- planning | ready | failed
  created_at TEXT NOT NULL
);

-- One `claude -p` agent run (AG-05). The transcript stays on disk.
CREATE TABLE agent_runs (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,        -- planner | explorer | reviewer
  target          TEXT NOT NULL,        -- decision id, plan id or "project"
  model           TEXT NOT NULL,
  status          TEXT NOT NULL,        -- running | succeeded | failed | cancelled
  started_at      TEXT NOT NULL,
  duration_ms     INTEGER,
  cost_usd        REAL,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  transcript_path TEXT,
  error           TEXT
);

-- Deep Dive results, kept as history.
CREATE TABLE explorations (
  decision_id    TEXT NOT NULL REFERENCES decisions (id),
  run_id         TEXT NOT NULL REFERENCES agent_runs (id),
  summary        TEXT NOT NULL,
  tradeoffs_json TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX explorations_decision ON explorations (decision_id);

-- Reviewer proposals. Nothing is applied until the user accepts one.
CREATE TABLE proposals (
  seq               INTEGER PRIMARY KEY,
  id                TEXT NOT NULL UNIQUE,  -- "RV-<seq>"
  run_id            TEXT NOT NULL REFERENCES agent_runs (id),
  target            TEXT NOT NULL,         -- plan id or "project"
  kind              TEXT NOT NULL,         -- conflict | revisit | add
  title             TEXT NOT NULL,
  reason            TEXT NOT NULL,
  decision_ids_json TEXT NOT NULL,
  draft_json        TEXT,                  -- add: the decision to create
  status            TEXT NOT NULL,         -- open | accepted | dismissed | superseded
  created_at        TEXT NOT NULL,
  resolved_at       TEXT
);
CREATE INDEX proposals_status ON proposals (status);

-- Context handed to Claude on the next prompt (CC-09).
-- Which revision of a decision was already handed to which Claude Code session.
CREATE TABLE deliveries (
  session_id   TEXT    NOT NULL,
  decision_id  TEXT    NOT NULL REFERENCES decisions (id),
  revision     INTEGER NOT NULL,
  delivered_at TEXT    NOT NULL,
  PRIMARY KEY (session_id, decision_id, revision)
);
-- Sessions whose prompt hook has run at least once (baseline for deliveries).
CREATE TABLE sessions_seen (
  session_id    TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL
);
-- Each context block handed to Claude, to measure its size (NFR-10).
CREATE TABLE delivery_log (
  session_id TEXT    NOT NULL,
  items      INTEGER NOT NULL,
  chars      INTEGER NOT NULL,
  at         TEXT    NOT NULL
);
