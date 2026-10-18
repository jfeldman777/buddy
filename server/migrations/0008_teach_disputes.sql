-- Buddy-018 step 6: disagreement journal (open questions → resolved teachings).
CREATE TABLE teach_disputes (
  id TEXT PRIMARY KEY NOT NULL,
  fragment_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  task_prompt TEXT NOT NULL DEFAULT '',
  pupil_answer TEXT NOT NULL DEFAULT '',
  examiner_note TEXT NOT NULL DEFAULT '',
  creator_remark TEXT NOT NULL,
  source_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN (
    'open',
    'resolved_bi_error',
    'resolved_examiner_error',
    'resolved_other'
  )),
  resolution_note TEXT NOT NULL DEFAULT '',
  teaching_id TEXT,
  admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX teach_disputes_fragment_status
  ON teach_disputes (fragment_id, status, updated_at);

CREATE TABLE teach_dispute_messages (
  id TEXT PRIMARY KEY NOT NULL,
  dispute_id TEXT NOT NULL REFERENCES teach_disputes (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('creator', 'bi', 'system')),
  kind TEXT NOT NULL DEFAULT 'reply' CHECK (kind IN (
    'remark',
    'reply',
    'revised_answer',
    'resolution'
  )),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX teach_dispute_messages_dispute
  ON teach_dispute_messages (dispute_id, created_at);

-- Carry forward step-5 rulings as open disputes (same ids).
INSERT INTO teach_disputes (
  id, fragment_id, task_id, task_prompt, pupil_answer, examiner_note,
  creator_remark, source_ref, status, resolution_note, teaching_id,
  admin_id, created_at, updated_at, resolved_at
)
SELECT
  id, fragment_id, task_id, task_prompt, pupil_answer, examiner_note,
  creator_ruling, source_ref, 'open', '', NULL,
  admin_id, created_at, created_at, NULL
FROM teach_rulings;

INSERT INTO teach_dispute_messages (id, dispute_id, role, kind, body, created_at)
SELECT
  id || '-remark0',
  id,
  'creator',
  'remark',
  creator_ruling,
  created_at
FROM teach_rulings;
