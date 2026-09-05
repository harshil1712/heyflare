-- Gmail users.watch + Pub/Sub push metadata (Phase 2).
ALTER TABLE accounts ADD COLUMN gmail_watch_expiration INTEGER;
ALTER TABLE accounts ADD COLUMN gmail_watch_resource_id TEXT;
