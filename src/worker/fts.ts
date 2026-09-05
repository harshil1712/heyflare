// FTS5 mail search (trigram) + batched backfill for lived-in databases.
import type { ThreadRow } from "./db";
import { runBatch } from "./db";

const BATCH = 80;
/** Trigram needs ≥3 chars; shorter / non-letter queries fall back to LIKE. */
const FTS_MIN = 3;

export type SearchMode = "fts" | "like";

export interface ThreadSearchHit {
  thread: ThreadRow;
  rank: number;
  highlight?: string | null;
}

/** True when FTS MATCH is preferred over LIKE. */
export function shouldUseFts(query: string): boolean {
  const q = query.trim();
  if (q.length < FTS_MIN) return false;
  // Need at least one letter (unicode) — pure symbols/numbers stay on LIKE.
  return /\p{L}/u.test(q);
}

/**
 * Build an FTS5 MATCH query for the trigram tokenizer.
 * Strips operators that change MATCH syntax; wraps the rest as a phrase.
 */
export function toFtsMatch(query: string): string {
  const cleaned = query
    .trim()
    .replace(/["*^\-:(){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `"${cleaned.replace(/"/g, '""')}"`;
}

export async function backfillFts(db: D1Database, batchSize = BATCH): Promise<{ threads: number; messages: number }> {
  let threads = 0;
  let messages = 0;
  let lastRowid = 0;
  for (;;) {
    const rows = await db
      .prepare(
        `SELECT rowid, subject, custom_subject, snippet, note FROM threads WHERE rowid > ? ORDER BY rowid LIMIT ?`
      )
      .bind(lastRowid, batchSize)
      .all<{ rowid: number; subject: string; custom_subject: string | null; snippet: string; note: string }>();
    if (!rows.results.length) break;
    const stmts = rows.results.map((r) =>
      db
        .prepare(`INSERT INTO threads_fts(rowid, subject, custom_subject, snippet, note) VALUES (?, ?, ?, ?, ?)`)
        .bind(r.rowid, r.subject, r.custom_subject ?? "", r.snippet, r.note)
    );
    await runBatch(db, stmts, 40);
    threads += rows.results.length;
    lastRowid = rows.results[rows.results.length - 1]!.rowid;
  }
  lastRowid = 0;
  for (;;) {
    const rows = await db
      .prepare(`SELECT rowid, text_body FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?`)
      .bind(lastRowid, batchSize)
      .all<{ rowid: number; text_body: string }>();
    if (!rows.results.length) break;
    const stmts = rows.results.map((r) =>
      db.prepare(`INSERT INTO messages_fts(rowid, text_body) VALUES (?, ?)`).bind(r.rowid, r.text_body ?? "")
    );
    await runBatch(db, stmts, 40);
    messages += rows.results.length;
    lastRowid = rows.results[rows.results.length - 1]!.rowid;
  }
  return { threads, messages };
}

/** If FTS indexes are empty but mail exists (post-migration), page-fill them. Safe to call repeatedly. */
export async function maybeBackfillFts(db: D1Database): Promise<void> {
  try {
    const fts = await db.prepare(`SELECT COUNT(*) AS n FROM threads_fts`).first<{ n: number }>();
    if ((fts?.n ?? 0) > 0) return;
    const threads = await db.prepare(`SELECT COUNT(*) AS n FROM threads`).first<{ n: number }>();
    const messages = await db.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>();
    if ((threads?.n ?? 0) === 0 && (messages?.n ?? 0) === 0) return;
    await backfillFts(db);
  } catch {
    /* FTS tables may not exist yet on early boot */
  }
}

async function searchFts(
  db: D1Database,
  accountIds: string[],
  query: string,
  limit: number,
  offset: number
): Promise<ThreadSearchHit[]> {
  if (!accountIds.length) return [];
  const match = toFtsMatch(query);
  const placeholders = accountIds.map(() => "?").join(",");
  const scope = `t.account_id IN (${placeholders}) AND t.merged_into IS NULL AND t.bucket <> 'trash'`;
  // UNION thread-side + message-side hits; bm25 lower = better; pick best rank per thread.
  const rows = await db
    .prepare(
      `SELECT t.*, MIN(h.rank) AS rank, MIN(h.highlight) AS highlight
       FROM (
         SELECT t.id AS thread_id, 0 AS source, bm25(threads_fts) AS rank,
                snippet(threads_fts, 0, '', '', '…', 24) AS highlight
           FROM threads_fts
           JOIN threads t ON t.rowid = threads_fts.rowid
          WHERE threads_fts MATCH ? AND ${scope}
         UNION ALL
         SELECT m.thread_id AS thread_id, 1 AS source, bm25(messages_fts) AS rank,
                snippet(messages_fts, 0, '', '', '…', 24) AS highlight
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
           JOIN threads t ON t.id = m.thread_id
          WHERE messages_fts MATCH ? AND ${scope}
       ) h
       JOIN threads t ON t.id = h.thread_id
       GROUP BY t.id
       ORDER BY MIN(h.source) ASC, MIN(h.rank) ASC, t.last_message_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(match, ...accountIds, match, ...accountIds, limit, offset)
    .all<ThreadRow & { rank: number; highlight: string | null }>();

  return rows.results.map(({ rank, highlight, ...thread }) => ({
    thread: thread as ThreadRow,
    rank: Number(rank),
    highlight,
  }));
}

async function searchLike(
  db: D1Database,
  accountIds: string[],
  query: string,
  limit: number,
  offset: number
): Promise<ThreadSearchHit[]> {
  if (!accountIds.length) return [];
  const like = `%${query}%`;
  const placeholders = accountIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT t.* FROM threads t
       WHERE t.account_id IN (${placeholders})
         AND t.merged_into IS NULL
         AND t.bucket <> 'trash'
         AND (
           t.subject LIKE ? OR t.custom_subject LIKE ? OR t.snippet LIKE ? OR t.participants_json LIKE ? OR t.note LIKE ?
           OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND (m.text_body LIKE ? OR m.from_email LIKE ? OR m.subject LIKE ?))
         )
       ORDER BY t.last_message_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...accountIds, like, like, like, like, like, like, like, like, limit, offset)
    .all<ThreadRow>();
  return rows.results.map((thread, i) => ({ thread, rank: i, highlight: null }));
}

/**
 * Search threads for the given accounts. Uses FTS5+bm25 when the query is long enough;
 * falls back to LIKE for short / non-letter queries (and if FTS fails).
 */
export async function searchThreads(
  db: D1Database,
  accountIds: string[],
  query: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<{ hits: ThreadSearchHit[]; mode: SearchMode }> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const q = query.trim();
  if (!q || !accountIds.length) return { hits: [], mode: "like" };

  if (shouldUseFts(q)) {
    try {
      const hits = await searchFts(db, accountIds, q, limit, offset);
      return { hits, mode: "fts" };
    } catch {
      /* fall through to LIKE */
    }
  }
  return { hits: await searchLike(db, accountIds, q, limit, offset), mode: "like" };
}
