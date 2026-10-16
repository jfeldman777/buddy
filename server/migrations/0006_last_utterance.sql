-- Last Bi utterance for turn continuity (not a full chat archive).
ALTER TABLE bi_conversation_context ADD COLUMN last_utterance TEXT NOT NULL DEFAULT '';
