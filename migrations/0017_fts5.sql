-- FTS5 indexes for mail search (trigram confirmed available in D1/workerd).
-- Empty tables + triggers only: backfill lived-in DBs via src/worker/fts.ts (batched), not a giant INSERT SELECT.
CREATE VIRTUAL TABLE threads_fts USING fts5(
  subject,
  custom_subject,
  snippet,
  note,
  content='threads',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text_body,
  content='messages',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER threads_fts_ai AFTER INSERT ON threads BEGIN
  INSERT INTO threads_fts(rowid, subject, custom_subject, snippet, note)
  VALUES (new.rowid, new.subject, coalesce(new.custom_subject, ''), new.snippet, new.note);
END;

CREATE TRIGGER threads_fts_ad AFTER DELETE ON threads BEGIN
  INSERT INTO threads_fts(threads_fts, rowid) VALUES('delete', old.rowid);
END;

CREATE TRIGGER threads_fts_au AFTER UPDATE OF subject, custom_subject, snippet, note ON threads BEGIN
  INSERT INTO threads_fts(threads_fts, rowid) VALUES('delete', old.rowid);
  INSERT INTO threads_fts(rowid, subject, custom_subject, snippet, note)
  VALUES (new.rowid, new.subject, coalesce(new.custom_subject, ''), new.snippet, new.note);
END;

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text_body) VALUES (new.rowid, new.text_body);
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid) VALUES('delete', old.rowid);
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE OF text_body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid) VALUES('delete', old.rowid);
  INSERT INTO messages_fts(rowid, text_body) VALUES (new.rowid, new.text_body);
END;
