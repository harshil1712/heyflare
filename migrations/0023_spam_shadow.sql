CREATE TABLE IF NOT EXISTS spam_shadow_results (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  gemma_verdict TEXT NOT NULL CHECK (gemma_verdict IN ('spam', 'ham', 'unsure', 'skipped')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'invalid_response', 'timeout', 'error')),
  score REAL CHECK (score >= 0 AND score <= 1),
  latency_ms INTEGER,
  CHECK ((status = 'ok' AND score IS NOT NULL) OR (status != 'ok' AND score IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_spam_shadow_created ON spam_shadow_results(created_at);
