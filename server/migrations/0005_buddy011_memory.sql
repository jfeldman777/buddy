-- Buddy-011: personal memory, teachings, shared KB, strategies, A–Bi chat budget.
-- Separate from DCB protocols and the DCB $10 purse.
-- Structured memory and conversation context live here (not a full chat archive).

-- Configurable hard cap for A–Bi OpenAI spend (default $1 = 1_000_000 micros for first trials).
CREATE TABLE buddy_chat_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  granted_micros INTEGER NOT NULL,
  spent_micros INTEGER NOT NULL DEFAULT 0,
  reserved_micros INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  CHECK (spent_micros >= 0),
  CHECK (reserved_micros >= 0),
  CHECK (spent_micros + reserved_micros <= granted_micros)
);

INSERT INTO buddy_chat_budget (id, granted_micros, spent_micros, reserved_micros, updated_at)
VALUES (1, 1000000, 0, 0, '1970-01-01T00:00:00.000Z');

CREATE TABLE buddy_chat_reservations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'released')),
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX buddy_chat_reservations_status ON buddy_chat_reservations (status, expires_at);

CREATE TABLE buddy_chat_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  reservation_id TEXT,
  speaker TEXT NOT NULL CHECK (speaker IN ('bi', 'extract', 'teach')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX buddy_chat_usage_session ON buddy_chat_usage (session_id);

-- Consent to store structured personal memory on the server (D2/D3).
CREATE TABLE bi_memory_consent (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  consent_version TEXT NOT NULL,
  consented_at TEXT NOT NULL
);

CREATE TABLE bi_memory_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  map TEXT NOT NULL CHECK (map IN ('personality', 'worldview', 'communication')),
  layer TEXT NOT NULL CHECK (layer IN ('fact', 'valuation', 'plan')),
  provenance TEXT NOT NULL CHECK (provenance IN ('from_a', 'bi_observation', 'hypothesis', 'confirmed', 'corrected')),
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  forbidden INTEGER NOT NULL DEFAULT 0 CHECK (forbidden IN (0, 1)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX bi_memory_entries_user ON bi_memory_entries (user_id, deleted, updated_at);

CREATE TABLE bi_memory_revisions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES bi_memory_entries (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'forbid', 'restore')),
  prev_text TEXT,
  new_text TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX bi_memory_revisions_entry ON bi_memory_revisions (entry_id, created_at);

CREATE TABLE bi_model_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  personality_json TEXT NOT NULL DEFAULT '{}',
  worldview_json TEXT NOT NULL DEFAULT '{}',
  communication_json TEXT NOT NULL DEFAULT '{}',
  preferences_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX bi_model_snapshots_user ON bi_model_snapshots (user_id);

CREATE TABLE bi_teachings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  formulation TEXT NOT NULL,
  examples_json TEXT NOT NULL DEFAULT '[]',
  constraints_text TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'awaiting_confirm', 'confirmed', 'rejected')),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX bi_teachings_user ON bi_teachings (user_id, status, updated_at);

CREATE TABLE bi_relationship_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note',
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX bi_relationship_events_user ON bi_relationship_events (user_id, created_at);

CREATE TABLE bi_chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  strategy_version TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  knowledge_epoch TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX bi_chat_sessions_user ON bi_chat_sessions (user_id, started_at);

-- Important context and unfinished threads (not a full transcript archive).
CREATE TABLE bi_conversation_context (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  session_id TEXT REFERENCES bi_chat_sessions (id) ON DELETE SET NULL,
  summary TEXT NOT NULL DEFAULT '',
  open_threads_json TEXT NOT NULL DEFAULT '[]',
  active_teaching_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE kb_proposals (
  id TEXT PRIMARY KEY,
  teaching_id TEXT NOT NULL REFERENCES bi_teachings (id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'revoked')),
  admin_comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX kb_proposals_status ON kb_proposals (status, updated_at);

CREATE TABLE kb_proposal_decisions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES kb_proposals (id) ON DELETE CASCADE,
  admin_user_id TEXT NOT NULL REFERENCES users (id),
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'return', 'revoke')),
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX kb_proposal_decisions_proposal ON kb_proposal_decisions (proposal_id, created_at);

CREATE TABLE kb_shared (
  id TEXT PRIMARY KEY,
  proposal_id TEXT REFERENCES kb_proposals (id) ON DELETE SET NULL,
  author_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  formulation TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  examples_json TEXT NOT NULL DEFAULT '[]',
  constraints_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('approved', 'revoked', 'superseded')),
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX kb_shared_status ON kb_shared (status, updated_at);

CREATE TABLE bi_strategies (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('draft', 'in_dcb', 'approved', 'revoked')),
  dcb_session_id TEXT,
  supersedes_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX bi_strategies_status ON bi_strategies (status, updated_at);
