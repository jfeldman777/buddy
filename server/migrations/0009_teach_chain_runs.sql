-- Buddy-018 step 7A: Creator-approved chain runs with pause/stop.
CREATE TABLE teach_chain_runs (
  id TEXT PRIMARY KEY NOT NULL,
  program_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'running',
    'paused',
    'completed',
    'failed'
  )),
  pause_reason TEXT NOT NULL DEFAULT '',
  cursor_index INTEGER NOT NULL DEFAULT 0,
  fragment_ids_json TEXT NOT NULL,
  results_json TEXT NOT NULL DEFAULT '[]',
  admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX teach_chain_runs_admin_updated
  ON teach_chain_runs (admin_id, updated_at);
