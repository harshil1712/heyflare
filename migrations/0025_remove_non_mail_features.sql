-- Mail-only: drop the tables of removed features (calendar, habits, journal, time tracking, AI assistant,
-- collections, clips, Expo device tokens). Children before parents so foreign-key checks pass.
-- Safe to re-run. accounts.calendar_error is left in place: SQLite has no DROP COLUMN IF EXISTS.
DROP TABLE IF EXISTS event_completions;
DROP TABLE IF EXISTS time_entries;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS habit_completions;
DROP TABLE IF EXISTS habits;
DROP TABLE IF EXISTS flex_tasks;
DROP TABLE IF EXISTS day_covers;
DROP TABLE IF EXISTS calendar_days;
DROP TABLE IF EXISTS calendar_settings;
DROP TABLE IF EXISTS calendars;
DROP TABLE IF EXISTS ai_messages;
DROP TABLE IF EXISTS ai_conversations;
DROP TABLE IF EXISTS ai_memory;
DROP TABLE IF EXISTS ai_learning_state;
DROP TABLE IF EXISTS ai_settings;
DROP TABLE IF EXISTS collection_threads;
DROP TABLE IF EXISTS collections;
DROP TABLE IF EXISTS clips;
DROP TABLE IF EXISTS device_tokens;
