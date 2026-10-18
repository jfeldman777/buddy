-- Buddy-018 step 8A: Creator↔Bi teaching sessions (corpus first, tasks one-by-one).
CREATE TABLE teach_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  admin_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'ingesting',
    'ready',
    'closed'
  )),
  corpus_id TEXT NOT NULL DEFAULT '',
  page_ids_json TEXT NOT NULL,
  ingest_index INTEGER NOT NULL DEFAULT 0,
  pages_json TEXT NOT NULL DEFAULT '[]',
  messages_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX teach_sessions_admin_updated
  ON teach_sessions (admin_id, updated_at);
