-- Buddy-018: Creator disagreements with Examiner (not Bi permanent memory).
CREATE TABLE teach_rulings (
  id TEXT PRIMARY KEY NOT NULL,
  fragment_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  task_prompt TEXT NOT NULL DEFAULT '',
  pupil_answer TEXT NOT NULL DEFAULT '',
  examiner_note TEXT NOT NULL DEFAULT '',
  creator_ruling TEXT NOT NULL,
  source_ref TEXT NOT NULL DEFAULT '',
  admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX teach_rulings_fragment_created
  ON teach_rulings (fragment_id, created_at);
