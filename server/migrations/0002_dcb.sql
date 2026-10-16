-- DCB-010: training module Di–Si–Bi.
-- Protocols live here on purpose. Buddy's personal chats and journal stay on the device.

-- Single shared purse for the first trials. Exceeding granted_micros is impossible (CHECK).
CREATE TABLE dcb_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  granted_micros INTEGER NOT NULL,
  spent_micros INTEGER NOT NULL DEFAULT 0,
  reserved_micros INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  CHECK (spent_micros >= 0),
  CHECK (reserved_micros >= 0),
  CHECK (spent_micros + reserved_micros <= granted_micros)
);

INSERT INTO dcb_budget (id, granted_micros, spent_micros, reserved_micros, updated_at)
VALUES (1, 10000000, 0, 0, '1970-01-01T00:00:00.000Z');

CREATE TABLE dcb_reservations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'released')),
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX dcb_reservations_status ON dcb_reservations (status, expires_at);

CREATE TABLE dcb_personas (
  id TEXT PRIMARY KEY,
  di_user_id TEXT NOT NULL REFERENCES users (id),
  title TEXT NOT NULL,
  secret_bio TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX dcb_personas_di ON dcb_personas (di_user_id);

CREATE TABLE dcb_sessions (
  id TEXT PRIMARY KEY,
  di_user_id TEXT NOT NULL REFERENCES users (id),
  persona_id TEXT NOT NULL REFERENCES dcb_personas (id),
  mode TEXT NOT NULL CHECK (mode IN ('small', 'large')),
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'finished')),
  bi_strategy_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  question_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX dcb_sessions_di ON dcb_sessions (di_user_id);

-- Facts established in a session (Di seed + Si inventions in large mode).
CREATE TABLE dcb_persona_memory (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES dcb_personas (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES dcb_sessions (id) ON DELETE CASCADE,
  fact TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('from_di', 'from_si')),
  created_at TEXT NOT NULL
);
CREATE INDEX dcb_memory_session ON dcb_persona_memory (session_id);

CREATE TABLE dcb_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES dcb_sessions (id) ON DELETE CASCADE,
  speaker TEXT NOT NULL CHECK (speaker IN ('bi', 'si')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX dcb_messages_session ON dcb_messages (session_id, seq);

CREATE TABLE dcb_bi_model (
  session_id TEXT PRIMARY KEY REFERENCES dcb_sessions (id) ON DELETE CASCADE,
  biography TEXT NOT NULL DEFAULT '',
  facts_json TEXT NOT NULL DEFAULT '[]',
  hypotheses_json TEXT NOT NULL DEFAULT '[]',
  unknowns_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE dcb_reviews (
  session_id TEXT PRIMARY KEY REFERENCES dcb_sessions (id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  good TEXT NOT NULL DEFAULT '',
  mistakes TEXT NOT NULL DEFAULT '',
  missed TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE dcb_ideas (
  session_id TEXT PRIMARY KEY REFERENCES dcb_sessions (id) ON DELETE CASCADE,
  strategy TEXT NOT NULL DEFAULT '',
  acquaintance TEXT NOT NULL DEFAULT '',
  si_notes TEXT NOT NULL DEFAULT '',
  next_trials TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE dcb_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES dcb_sessions (id) ON DELETE CASCADE,
  reservation_id TEXT,
  speaker TEXT NOT NULL CHECK (speaker IN ('bi', 'si', 'check')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX dcb_usage_session ON dcb_usage (session_id);
