-- Photos Di shows Bi during a session (multiple, in order). Not part of secret_bio.
CREATE TABLE dcb_session_photos (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES dcb_sessions (id) ON DELETE CASCADE,
  photo_data TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX dcb_session_photos_session ON dcb_session_photos (session_id, seq);
