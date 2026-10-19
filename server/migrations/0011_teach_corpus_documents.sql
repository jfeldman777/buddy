-- Buddy-018 step 8A-files: Creator-uploaded PDF/DOCX texts for teach sessions.
CREATE TABLE teach_corpus_documents (
  id TEXT PRIMARY KEY NOT NULL,
  admin_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('pdf', 'docx', 'text')),
  text TEXT NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX teach_corpus_documents_admin_created
  ON teach_corpus_documents (admin_id, created_at);

ALTER TABLE teach_sessions ADD COLUMN corpus_kind TEXT NOT NULL DEFAULT 'notion';
