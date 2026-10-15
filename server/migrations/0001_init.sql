-- Stage 4: accounts, passkeys, recovery codes, sessions, administrator audit.
-- Budget tables (payments_received, budget_grants, budgets, usage_*) come with stages 5–6.
-- Times: *_at TEXT are ISO 8601 for people; expires_at / window_start INTEGER are milliseconds for comparisons.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at TEXT NOT NULL
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX credentials_user ON credentials (user_id);

-- Only HMAC-SHA-256(code, RECOVERY_PEPPER) is stored. Administrators have no row here.
CREATE TABLE recovery_codes (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  code_hmac TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Only SHA-256 of the session token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  elevated INTEGER NOT NULL DEFAULT 0 CHECK (elevated IN (0, 1)),
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'add_passkey')),
  user_id TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX challenges_expires ON challenges (expires_at);

CREATE TABLE rate_counters (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE service_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL REFERENCES users (id),
  action TEXT NOT NULL,
  target TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL
);
