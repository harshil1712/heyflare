-- Materialized counters for /api/counts and the push badge, maintained entirely by triggers.
-- Replaces 6 COUNT(...) statements per /api/counts call (full scans of growing thread/bundle
-- ranges) with O(#accounts) counter rows. Reads live in src/worker/counts.ts; the full recompute
-- (also used to build these tables on existing databases) lives in 0024_counts_backfill.sql.
--
-- Semantics mirror the old queries exactly, with one time-dependent simplification: a thread is
-- "visible" here when merged_into IS NULL AND bubble_up_at IS NULL. The old queries additionally
-- treated bubble_up_at <= now as visible; that transition is carried by processBubbleUps
-- (src/worker/sync.ts), whose every-minute UPDATE (bubble_up_at = NULL, seen = 0) fires the
-- threads UPDATE trigger below, so counters catch up within a minute of a bubble coming due.
--
-- Metrics (all per account; a missing row means 0):
--   imbox_new_threads   visible imbox threads outside any bundle, unseen, not reply-later/set-aside
--   imbox_open_bundles  open bundles with >= 1 visible imbox thread (not reply-later/set-aside)
--   feed_new            visible feed threads, unseen
--   paper_new_threads   visible paper_trail threads outside any bundle, unseen
--   paper_open_bundles  open bundles with >= 1 visible paper_trail thread (no rl/sa filter - as before)
--   reply_later         visible threads with reply_later = 1
--   set_aside           visible threads with set_aside = 1
-- Plus screener_senders (refcount of visible screener threads per account + last_from_email; the
-- screener count is rows with refs > 0) and bundle_match_counts (per bundle: thread counts matching
-- the imbox / paper_trail bundle-exists predicates).

CREATE TABLE IF NOT EXISTS counters (
  account_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, metric)
);

CREATE TABLE IF NOT EXISTS screener_senders (
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  refs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, email)
);

CREATE TABLE IF NOT EXISTS bundle_match_counts (
  bundle_id TEXT PRIMARY KEY,
  imbox_n INTEGER NOT NULL DEFAULT 0,
  paper_n INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- threads: INSERT
CREATE TRIGGER counts_threads_ai AFTER INSERT ON threads FOR EACH ROW BEGIN
  INSERT INTO counters (account_id, metric, n) VALUES
    (NEW.account_id, 'imbox_new_threads', CASE WHEN NEW.bucket = 'imbox' AND NEW.bundle_id IS NULL AND NEW.seen = 0 AND NEW.reply_later = 0 AND NEW.set_aside = 0 AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END),
    (NEW.account_id, 'feed_new', CASE WHEN NEW.bucket = 'feed' AND NEW.seen = 0 AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END),
    (NEW.account_id, 'paper_new_threads', CASE WHEN NEW.bucket = 'paper_trail' AND NEW.bundle_id IS NULL AND NEW.seen = 0 AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END),
    (NEW.account_id, 'reply_later', CASE WHEN NEW.reply_later = 1 AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END),
    (NEW.account_id, 'set_aside', CASE WHEN NEW.set_aside = 1 AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END)
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO screener_senders (account_id, email, refs)
    SELECT NEW.account_id, NEW.last_from_email, 1
    WHERE NEW.bucket = 'screener' AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL
  ON CONFLICT(account_id, email) DO UPDATE SET refs = screener_senders.refs + 1;

  INSERT INTO counters (account_id, metric, n)
    SELECT b.account_id, 'imbox_open_bundles', 1
    FROM bundles b
    WHERE b.id = NEW.bundle_id AND b.status = 'open'
      AND NEW.bucket = 'imbox' AND NEW.reply_later = 0 AND NEW.set_aside = 0
      AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL
      AND COALESCE((SELECT imbox_n FROM bundle_match_counts WHERE bundle_id = b.id), 0) = 0
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO counters (account_id, metric, n)
    SELECT b.account_id, 'paper_open_bundles', 1
    FROM bundles b
    WHERE b.id = NEW.bundle_id AND b.status = 'open'
      AND NEW.bucket = 'paper_trail'
      AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL
      AND COALESCE((SELECT paper_n FROM bundle_match_counts WHERE bundle_id = b.id), 0) = 0
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO bundle_match_counts (bundle_id, imbox_n, paper_n)
    SELECT NEW.bundle_id,
      CASE WHEN NEW.bundle_id IS NOT NULL AND NEW.bucket = 'imbox' AND NEW.reply_later = 0 AND NEW.set_aside = 0 AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END,
      CASE WHEN NEW.bundle_id IS NOT NULL AND NEW.bucket = 'paper_trail' AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END
    FROM bundles b
    WHERE b.id = NEW.bundle_id
  ON CONFLICT(bundle_id) DO UPDATE SET
    imbox_n = bundle_match_counts.imbox_n + excluded.imbox_n,
    paper_n = bundle_match_counts.paper_n + excluded.paper_n;
END;

-- ---------------------------------------------------------------- threads: DELETE
CREATE TRIGGER counts_threads_ad AFTER DELETE ON threads FOR EACH ROW BEGIN
  INSERT INTO counters (account_id, metric, n) VALUES
    (OLD.account_id, 'imbox_new_threads', CASE WHEN OLD.bucket = 'imbox' AND OLD.bundle_id IS NULL AND OLD.seen = 0 AND OLD.reply_later = 0 AND OLD.set_aside = 0 AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END),
    (OLD.account_id, 'feed_new', CASE WHEN OLD.bucket = 'feed' AND OLD.seen = 0 AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END),
    (OLD.account_id, 'paper_new_threads', CASE WHEN OLD.bucket = 'paper_trail' AND OLD.bundle_id IS NULL AND OLD.seen = 0 AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END),
    (OLD.account_id, 'reply_later', CASE WHEN OLD.reply_later = 1 AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END),
    (OLD.account_id, 'set_aside', CASE WHEN OLD.set_aside = 1 AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END)
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO screener_senders (account_id, email, refs)
    SELECT OLD.account_id, OLD.last_from_email, -1
    WHERE OLD.bucket = 'screener' AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL
  ON CONFLICT(account_id, email) DO UPDATE SET refs = screener_senders.refs - 1;

  INSERT INTO counters (account_id, metric, n)
    SELECT b.account_id, 'imbox_open_bundles', -1
    FROM bundles b
    WHERE b.id = OLD.bundle_id AND b.status = 'open'
      AND OLD.bucket = 'imbox' AND OLD.reply_later = 0 AND OLD.set_aside = 0
      AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL
      AND COALESCE((SELECT imbox_n FROM bundle_match_counts WHERE bundle_id = b.id), 0) = 1
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO counters (account_id, metric, n)
    SELECT b.account_id, 'paper_open_bundles', -1
    FROM bundles b
    WHERE b.id = OLD.bundle_id AND b.status = 'open'
      AND OLD.bucket = 'paper_trail'
      AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL
      AND COALESCE((SELECT paper_n FROM bundle_match_counts WHERE bundle_id = b.id), 0) = 1
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO bundle_match_counts (bundle_id, imbox_n, paper_n)
    SELECT OLD.bundle_id,
      CASE WHEN OLD.bundle_id IS NOT NULL AND OLD.bucket = 'imbox' AND OLD.reply_later = 0 AND OLD.set_aside = 0 AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END,
      CASE WHEN OLD.bundle_id IS NOT NULL AND OLD.bucket = 'paper_trail' AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END
    FROM bundles b
    WHERE b.id = OLD.bundle_id
  ON CONFLICT(bundle_id) DO UPDATE SET
    imbox_n = bundle_match_counts.imbox_n + excluded.imbox_n,
    paper_n = bundle_match_counts.paper_n + excluded.paper_n;
END;

-- ---------------------------------------------------------------- threads: UPDATE
-- No OF list: fires on every UPDATE, but the WHEN clause skips bodies that touch none of the
-- counted dimensions (bucket, seen, reply_later, set_aside, bundle_id, merged_into,
-- bubble_up_at, last_from_email, account_id). IS NOT = null-safe inequality.
-- The OLD-side and NEW-side halves each apply their own deltas; when the bundle (or account)
-- is unchanged the pair nets out to the correct transition, and when it differs each side is
-- applied to its own key.
CREATE TRIGGER counts_threads_au AFTER UPDATE ON threads
FOR EACH ROW
WHEN OLD.bucket IS NOT NEW.bucket
  OR OLD.seen IS NOT NEW.seen
  OR OLD.reply_later IS NOT NEW.reply_later
  OR OLD.set_aside IS NOT NEW.set_aside
  OR OLD.bundle_id IS NOT NEW.bundle_id
  OR OLD.merged_into IS NOT NEW.merged_into
  OR OLD.bubble_up_at IS NOT NEW.bubble_up_at
  OR OLD.last_from_email IS NOT NEW.last_from_email
  OR OLD.account_id IS NOT NEW.account_id
BEGIN
  INSERT INTO counters (account_id, metric, n) VALUES
    (OLD.account_id, 'imbox_new_threads', CASE WHEN OLD.bucket = 'imbox' AND OLD.bundle_id IS NULL AND OLD.seen = 0 AND OLD.reply_later = 0 AND OLD.set_aside = 0 AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END),
    (OLD.account_id, 'feed_new', CASE WHEN OLD.bucket = 'feed' AND OLD.seen = 0 AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END),
    (OLD.account_id, 'paper_new_threads', CASE WHEN OLD.bucket = 'paper_trail' AND OLD.bundle_id IS NULL AND OLD.seen = 0 AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END),
    (OLD.account_id, 'reply_later', CASE WHEN OLD.reply_later = 1 AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END),
    (OLD.account_id, 'set_aside', CASE WHEN OLD.set_aside = 1 AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END)
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO screener_senders (account_id, email, refs)
    SELECT OLD.account_id, OLD.last_from_email, -1
    WHERE OLD.bucket = 'screener' AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL
  ON CONFLICT(account_id, email) DO UPDATE SET refs = screener_senders.refs - 1;

  INSERT INTO counters (account_id, metric, n)
    SELECT b.account_id, 'imbox_open_bundles', -1
    FROM bundles b
    WHERE b.id = OLD.bundle_id AND b.status = 'open'
      AND OLD.bucket = 'imbox' AND OLD.reply_later = 0 AND OLD.set_aside = 0
      AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL
      AND COALESCE((SELECT imbox_n FROM bundle_match_counts WHERE bundle_id = b.id), 0) = 1
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO counters (account_id, metric, n)
    SELECT b.account_id, 'paper_open_bundles', -1
    FROM bundles b
    WHERE b.id = OLD.bundle_id AND b.status = 'open'
      AND OLD.bucket = 'paper_trail'
      AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL
      AND COALESCE((SELECT paper_n FROM bundle_match_counts WHERE bundle_id = b.id), 0) = 1
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO bundle_match_counts (bundle_id, imbox_n, paper_n)
    SELECT OLD.bundle_id,
      CASE WHEN OLD.bundle_id IS NOT NULL AND OLD.bucket = 'imbox' AND OLD.reply_later = 0 AND OLD.set_aside = 0 AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END,
      CASE WHEN OLD.bundle_id IS NOT NULL AND OLD.bucket = 'paper_trail' AND OLD.merged_into IS NULL AND OLD.bubble_up_at IS NULL THEN -1 ELSE 0 END
    FROM bundles b
    WHERE b.id = OLD.bundle_id
  ON CONFLICT(bundle_id) DO UPDATE SET
    imbox_n = bundle_match_counts.imbox_n + excluded.imbox_n,
    paper_n = bundle_match_counts.paper_n + excluded.paper_n;

  INSERT INTO counters (account_id, metric, n) VALUES
    (NEW.account_id, 'imbox_new_threads', CASE WHEN NEW.bucket = 'imbox' AND NEW.bundle_id IS NULL AND NEW.seen = 0 AND NEW.reply_later = 0 AND NEW.set_aside = 0 AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END),
    (NEW.account_id, 'feed_new', CASE WHEN NEW.bucket = 'feed' AND NEW.seen = 0 AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END),
    (NEW.account_id, 'paper_new_threads', CASE WHEN NEW.bucket = 'paper_trail' AND NEW.bundle_id IS NULL AND NEW.seen = 0 AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END),
    (NEW.account_id, 'reply_later', CASE WHEN NEW.reply_later = 1 AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END),
    (NEW.account_id, 'set_aside', CASE WHEN NEW.set_aside = 1 AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END)
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO screener_senders (account_id, email, refs)
    SELECT NEW.account_id, NEW.last_from_email, 1
    WHERE NEW.bucket = 'screener' AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL
  ON CONFLICT(account_id, email) DO UPDATE SET refs = screener_senders.refs + 1;

  INSERT INTO counters (account_id, metric, n)
    SELECT b.account_id, 'imbox_open_bundles', 1
    FROM bundles b
    WHERE b.id = NEW.bundle_id AND b.status = 'open'
      AND NEW.bucket = 'imbox' AND NEW.reply_later = 0 AND NEW.set_aside = 0
      AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL
      AND COALESCE((SELECT imbox_n FROM bundle_match_counts WHERE bundle_id = b.id), 0) = 0
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO counters (account_id, metric, n)
    SELECT b.account_id, 'paper_open_bundles', 1
    FROM bundles b
    WHERE b.id = NEW.bundle_id AND b.status = 'open'
      AND NEW.bucket = 'paper_trail'
      AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL
      AND COALESCE((SELECT paper_n FROM bundle_match_counts WHERE bundle_id = b.id), 0) = 0
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO bundle_match_counts (bundle_id, imbox_n, paper_n)
    SELECT NEW.bundle_id,
      CASE WHEN NEW.bundle_id IS NOT NULL AND NEW.bucket = 'imbox' AND NEW.reply_later = 0 AND NEW.set_aside = 0 AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END,
      CASE WHEN NEW.bundle_id IS NOT NULL AND NEW.bucket = 'paper_trail' AND NEW.merged_into IS NULL AND NEW.bubble_up_at IS NULL THEN 1 ELSE 0 END
    FROM bundles b
    WHERE b.id = NEW.bundle_id
  ON CONFLICT(bundle_id) DO UPDATE SET
    imbox_n = bundle_match_counts.imbox_n + excluded.imbox_n,
    paper_n = bundle_match_counts.paper_n + excluded.paper_n;
END;

-- ---------------------------------------------------------------- bundles
-- A bundle contributes to imbox_open_bundles / paper_open_bundles while it is open AND its
-- match count is > 0. Thread triggers handle 0 <-> 1 crossings of the match counts; these
-- triggers handle bundle lifecycle.
CREATE TRIGGER counts_bundles_ai AFTER INSERT ON bundles FOR EACH ROW BEGIN
  -- Defensive recompute: also correct if threads were assigned to this bundle id before the
  -- bundle row existed (thread triggers only track matches for existing bundles).
  INSERT INTO bundle_match_counts (bundle_id, imbox_n, paper_n)
  VALUES (
    NEW.id,
    (SELECT COUNT(*) FROM threads t WHERE t.bundle_id = NEW.id AND t.bucket = 'imbox' AND t.reply_later = 0 AND t.set_aside = 0 AND t.merged_into IS NULL AND t.bubble_up_at IS NULL),
    (SELECT COUNT(*) FROM threads t WHERE t.bundle_id = NEW.id AND t.bucket = 'paper_trail' AND t.merged_into IS NULL AND t.bubble_up_at IS NULL)
  )
  ON CONFLICT(bundle_id) DO UPDATE SET
    imbox_n = excluded.imbox_n,
    paper_n = excluded.paper_n;

  INSERT INTO counters (account_id, metric, n)
    SELECT NEW.account_id, 'imbox_open_bundles', 1
    WHERE NEW.status = 'open' AND (SELECT imbox_n FROM bundle_match_counts WHERE bundle_id = NEW.id) > 0
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO counters (account_id, metric, n)
    SELECT NEW.account_id, 'paper_open_bundles', 1
    WHERE NEW.status = 'open' AND (SELECT paper_n FROM bundle_match_counts WHERE bundle_id = NEW.id) > 0
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;
END;

CREATE TRIGGER counts_bundles_au AFTER UPDATE OF status ON bundles
FOR EACH ROW
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO counters (account_id, metric, n)
    SELECT NEW.account_id, 'imbox_open_bundles', CASE WHEN OLD.status = 'open' THEN -1 ELSE 1 END
    WHERE (OLD.status = 'open' OR NEW.status = 'open')
      AND (SELECT imbox_n FROM bundle_match_counts WHERE bundle_id = NEW.id) > 0
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO counters (account_id, metric, n)
    SELECT NEW.account_id, 'paper_open_bundles', CASE WHEN OLD.status = 'open' THEN -1 ELSE 1 END
    WHERE (OLD.status = 'open' OR NEW.status = 'open')
      AND (SELECT paper_n FROM bundle_match_counts WHERE bundle_id = NEW.id) > 0
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;
END;

CREATE TRIGGER counts_bundles_ad AFTER DELETE ON bundles FOR EACH ROW BEGIN
  INSERT INTO counters (account_id, metric, n)
    SELECT OLD.account_id, 'imbox_open_bundles', -1
    WHERE OLD.status = 'open' AND (SELECT imbox_n FROM bundle_match_counts WHERE bundle_id = OLD.id) > 0
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  INSERT INTO counters (account_id, metric, n)
    SELECT OLD.account_id, 'paper_open_bundles', -1
    WHERE OLD.status = 'open' AND (SELECT paper_n FROM bundle_match_counts WHERE bundle_id = OLD.id) > 0
  ON CONFLICT(account_id, metric) DO UPDATE SET n = counters.n + excluded.n;

  DELETE FROM bundle_match_counts WHERE bundle_id = OLD.id;
END;

-- ---------------------------------------------------------------- accounts
-- Account deletion (wipe) removes threads/bundles explicitly; drop the leftover derived rows.
CREATE TRIGGER counts_accounts_ad AFTER DELETE ON accounts FOR EACH ROW BEGIN
  DELETE FROM counters WHERE account_id = OLD.id;
  DELETE FROM screener_senders WHERE account_id = OLD.id;
END;
