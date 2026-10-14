-- Full recompute of the trigger-maintained count tables from 0023_counts.sql.
-- Split from 0023 so tests can wipe the derived tables and re-run just this file.
-- Safe to re-run: clears all three tables, then rebuilds them from threads/bundles.
-- Predicates here must stay in sync with the triggers in 0023_counts.sql.

DELETE FROM counters;
DELETE FROM screener_senders;
DELETE FROM bundle_match_counts;

-- Per-bundle match counts: threads matching the imbox / paper_trail bundle-exists predicates.
INSERT INTO bundle_match_counts (bundle_id, imbox_n, paper_n)
SELECT t.bundle_id,
  COUNT(CASE WHEN t.bucket = 'imbox' AND t.reply_later = 0 AND t.set_aside = 0 AND t.merged_into IS NULL AND t.bubble_up_at IS NULL THEN 1 END),
  COUNT(CASE WHEN t.bucket = 'paper_trail' AND t.merged_into IS NULL AND t.bubble_up_at IS NULL THEN 1 END)
FROM threads t
JOIN bundles b ON b.id = t.bundle_id
WHERE t.bundle_id IS NOT NULL
GROUP BY t.bundle_id;

-- Screener: refcount of visible screener threads per (account, last_from_email).
INSERT INTO screener_senders (account_id, email, refs)
SELECT account_id, last_from_email, COUNT(*)
FROM threads
WHERE bucket = 'screener' AND merged_into IS NULL AND bubble_up_at IS NULL
GROUP BY account_id, last_from_email;

-- Thread-level counters.
INSERT INTO counters (account_id, metric, n)
SELECT account_id, 'imbox_new_threads', COUNT(*)
FROM threads
WHERE bucket = 'imbox' AND bundle_id IS NULL AND seen = 0 AND reply_later = 0 AND set_aside = 0
  AND merged_into IS NULL AND bubble_up_at IS NULL
GROUP BY account_id;

INSERT INTO counters (account_id, metric, n)
SELECT account_id, 'feed_new', COUNT(*)
FROM threads
WHERE bucket = 'feed' AND seen = 0
  AND merged_into IS NULL AND bubble_up_at IS NULL
GROUP BY account_id;

INSERT INTO counters (account_id, metric, n)
SELECT account_id, 'paper_new_threads', COUNT(*)
FROM threads
WHERE bucket = 'paper_trail' AND bundle_id IS NULL AND seen = 0
  AND merged_into IS NULL AND bubble_up_at IS NULL
GROUP BY account_id;

INSERT INTO counters (account_id, metric, n)
SELECT account_id, 'reply_later', COUNT(*)
FROM threads
WHERE reply_later = 1
  AND merged_into IS NULL AND bubble_up_at IS NULL
GROUP BY account_id;

INSERT INTO counters (account_id, metric, n)
SELECT account_id, 'set_aside', COUNT(*)
FROM threads
WHERE set_aside = 1
  AND merged_into IS NULL AND bubble_up_at IS NULL
GROUP BY account_id;

-- Open-bundle counters from the match counts.
INSERT INTO counters (account_id, metric, n)
SELECT b.account_id, 'imbox_open_bundles', COUNT(*)
FROM bundles b
JOIN bundle_match_counts m ON m.bundle_id = b.id
WHERE b.status = 'open' AND m.imbox_n > 0
GROUP BY b.account_id;

INSERT INTO counters (account_id, metric, n)
SELECT b.account_id, 'paper_open_bundles', COUNT(*)
FROM bundles b
JOIN bundle_match_counts m ON m.bundle_id = b.id
WHERE b.status = 'open' AND m.paper_n > 0
GROUP BY b.account_id;
