-- Large domain-mail attachment blobs live in R2; D1 keeps a pointer.
-- Retention ages are stored in users.settings_json (paperTrailRetentionDays / trashRetentionDays).
ALTER TABLE attachments ADD COLUMN r2_key TEXT;
