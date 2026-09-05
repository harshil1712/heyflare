-- Web Push subscriptions + per-thread notify cooldown.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_push_subs_user ON push_subscriptions(user_id);

CREATE TABLE push_notify_log (
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  notified_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id)
);
CREATE INDEX idx_push_notify_at ON push_notify_log(notified_at);
