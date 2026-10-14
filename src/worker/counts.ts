// Read helpers for the trigger-maintained count tables (migrations 0023/0024).
// Replaces the old /api/queries: instead of six COUNT(...) statements that scan growing
// thread/bundle ranges, reads are O(#accounts) rows out of `counters`/`screener_senders`.
// The tables are maintained by triggers on threads/bundles; a missing row counts as 0.
import type { Counts } from "@shared/types";
import { chunk, placeholders } from "./db";

/** The seven per-account metrics written by the triggers in 0023_counts.sql. */
export type Metric =
  | "imbox_new_threads"
  | "imbox_open_bundles"
  | "feed_new"
  | "paper_new_threads"
  | "paper_open_bundles"
  | "reply_later"
  | "set_aside";

type CountsMap = Partial<Record<Metric, number>>;

const CHUNK = 90;

/** Summed metric totals across the given accounts (e.g. one account, or all of a user's). */
export async function readCounters(db: D1Database, accountIds: string[]): Promise<CountsMap> {
  const out: CountsMap = {};
  for (const ids of chunk(accountIds, CHUNK)) {
    if (!ids.length) continue;
    const rows = await db
      .prepare(`SELECT metric, SUM(n) AS n FROM counters WHERE account_id IN (${placeholders(ids.length)}) GROUP BY metric`)
      .bind(...ids)
      .all<{ metric: Metric; n: number }>();
    for (const r of rows.results) out[r.metric] = (out[r.metric] ?? 0) + (r.n ?? 0);
  }
  return out;
}

/** Distinct visible screener senders across the given accounts (rows with refs > 0). */
export async function screenerSenderCount(db: D1Database, accountIds: string[]): Promise<number> {
  let total = 0;
  for (const ids of chunk(accountIds, CHUNK)) {
    if (!ids.length) continue;
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM screener_senders WHERE account_id IN (${placeholders(ids.length)}) AND refs > 0`)
      .bind(...ids)
      .first<{ n: number }>();
    total += row?.n ?? 0;
  }
  return total;
}

/** The /api/counts payload, identical in shape and value to the old six-statement version. */
export async function getCounts(db: D1Database, accountIds: string[]): Promise<Counts> {
  if (!accountIds.length) return { screener: 0, imbox_new: 0, feed_new: 0, paper_trail_new: 0, reply_later: 0, set_aside: 0 };
  const [c, screener] = await Promise.all([readCounters(db, accountIds), screenerSenderCount(db, accountIds)]);
  return {
    screener,
    imbox_new: (c.imbox_new_threads ?? 0) + (c.imbox_open_bundles ?? 0),
    feed_new: c.feed_new ?? 0,
    paper_trail_new: (c.paper_new_threads ?? 0) + (c.paper_open_bundles ?? 0),
    reply_later: c.reply_later ?? 0,
    set_aside: c.set_aside ?? 0,
  };
}

/** All account ids owned by a user (the badge and other user-scoped reads start here). */
export async function accountIdsForUser(db: D1Database, userId: string): Promise<string[]> {
  const rows = await db.prepare(`SELECT id FROM accounts WHERE user_id = ?`).bind(userId).all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

/**
 * Home-screen badge count: unseen Imbox (threads + open bundles) plus distinct screener
 * senders, summed over the given accounts. Same composition as the old appBadgeCount query.
 */
export async function badgeCount(db: D1Database, accountIds: string[]): Promise<number> {
  if (!accountIds.length) return 0;
  const [c, screener] = await Promise.all([readCounters(db, accountIds), screenerSenderCount(db, accountIds)]);
  return Math.max(0, (c.imbox_new_threads ?? 0) + (c.imbox_open_bundles ?? 0) + screener);
}
