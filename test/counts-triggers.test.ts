// Differential tests for the trigger-maintained counters (migrations 0023/0024).
//
// The reference is the pre-optimization implementation, ported verbatim:
//  - refCounts: the six /api/counts statements as they were before this change.
//  - refDbState: the same predicates recomputed from scratch per account/bundle/sender.
// A seeded-random battery applies hundreds of mutations across every counted dimension and,
// after each one, compares the trigger-maintained tables (and the read helpers) against the
// reference. Time-dependence note: the old formulas treat `bubble_up_at <= now` as visible while
// the triggers only see the state left by writes; the battery therefore only uses bubble times
// that are far in the future (stable) and flushes them with the same DML processBubbleUps runs.
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import m0024 from "../migrations/0024_counts_backfill.sql";
import { splitStatements } from "../src/worker/migrations";
import { getCounts, readCounters, screenerSenderCount, badgeCount, accountIdsForUser } from "../src/worker/counts";
import { appBadgeCount } from "../src/worker/push";
import { ingestParsed, processBubbleUps } from "../src/worker/sync";
import { seedUser, seedAccount, makeParsed, addr, testEnv } from "./helpers";

const VISIBLE = `t.merged_into IS NULL AND (t.bubble_up_at IS NULL OR t.bubble_up_at <= ?)`;
const FAR_FUTURE = Date.now() + 100 * 365 * 24 * 3600 * 1000;

type RefCounts = {
  screener: number;
  imbox_new: number;
  feed_new: number;
  paper_trail_new: number;
  reply_later: number;
  set_aside: number;
};
const ZERO_COUNTS: RefCounts = { screener: 0, imbox_new: 0, feed_new: 0, paper_trail_new: 0, reply_later: 0, set_aside: 0 };

/** The six original /api/counts statements, verbatim. */
async function refCounts(db: D1Database, ids: string[]): Promise<RefCounts> {
  if (!ids.length) return { ...ZERO_COUNTS };
  const t = Date.now();
  const sc = `t.account_id IN (${ids.map(() => "?").join(",")})`;
  const q = async (sql: string) => {
    const times = sql.split(sc).length - 1;
    const params: unknown[] = [];
    for (let i = 0; i < times; i++) params.push(...ids, t);
    return (await db.prepare(sql).bind(...params).first<{ n: number }>())?.n ?? 0;
  };
  const [screener, imbox, feed, paper, rl, sa] = await Promise.all([
    q(`SELECT COUNT(DISTINCT t.account_id || '|' || t.last_from_email) AS n FROM threads t WHERE ${sc} AND t.bucket = 'screener' AND ${VISIBLE}`),
    q(`SELECT (SELECT COUNT(*) FROM threads t WHERE ${sc} AND t.bucket = 'imbox' AND t.bundle_id IS NULL AND t.seen = 0 AND t.reply_later = 0 AND t.set_aside = 0 AND ${VISIBLE})
         + (SELECT COUNT(*) FROM bundles b WHERE b.status = 'open' AND EXISTS (SELECT 1 FROM threads t WHERE t.bundle_id = b.id AND ${sc} AND t.bucket = 'imbox' AND t.reply_later = 0 AND t.set_aside = 0 AND ${VISIBLE})) AS n`),
    q(`SELECT COUNT(*) AS n FROM threads t WHERE ${sc} AND t.bucket = 'feed' AND t.seen = 0 AND ${VISIBLE}`),
    q(`SELECT (SELECT COUNT(*) FROM threads t WHERE ${sc} AND t.bucket = 'paper_trail' AND t.bundle_id IS NULL AND t.seen = 0 AND ${VISIBLE})
         + (SELECT COUNT(*) FROM bundles b WHERE b.status = 'open' AND EXISTS (SELECT 1 FROM threads t WHERE t.bundle_id = b.id AND ${sc} AND t.bucket = 'paper_trail' AND ${VISIBLE})) AS n`),
    q(`SELECT COUNT(*) AS n FROM threads t WHERE ${sc} AND t.reply_later = 1 AND ${VISIBLE}`),
    q(`SELECT COUNT(*) AS n FROM threads t WHERE ${sc} AND t.set_aside = 1 AND ${VISIBLE}`),
  ]);
  return { screener, imbox_new: imbox, feed_new: feed, paper_trail_new: paper, reply_later: rl, set_aside: sa };
}

// ---------------------------------------------------------------- state diffing

type CounterRow = { account_id: string; metric: string; n: number };
type ScreenerRow = { account_id: string; email: string; refs: number };
type BundleMatchRow = { bundle_id: string; imbox_n: number; paper_n: number };
type DbState = { counters: CounterRow[]; screener: ScreenerRow[]; bundles: BundleMatchRow[] };

async function readDbState(db: D1Database): Promise<DbState> {
  const [counters, screener, bundles] = await Promise.all([
    db.prepare(`SELECT account_id, metric, n FROM counters ORDER BY account_id, metric`).all<CounterRow>(),
    db.prepare(`SELECT account_id, email, refs FROM screener_senders ORDER BY account_id, email`).all<ScreenerRow>(),
    db.prepare(`SELECT bundle_id, imbox_n, paper_n FROM bundle_match_counts ORDER BY bundle_id`).all<BundleMatchRow>(),
  ]);
  return { counters: counters.results, screener: screener.results, bundles: bundles.results };
}

/** Zero rows are permitted bookkeeping; the invariant is about non-zero content. */
function normalize(state: DbState): DbState {
  return {
    counters: state.counters.filter((r) => r.n !== 0).sort((a, b) => (a.account_id + a.metric).localeCompare(b.account_id + b.metric)),
    screener: state.screener.filter((r) => r.refs !== 0).sort((a, b) => (a.account_id + a.email).localeCompare(b.account_id + b.email)),
    bundles: state.bundles.filter((r) => r.imbox_n !== 0 || r.paper_n !== 0).sort((a, b) => a.bundle_id.localeCompare(b.bundle_id)),
  };
}

/** Old-formula recompute of every maintained row, from scratch (4 statements). */
async function refDbState(db: D1Database): Promise<DbState> {
  const t = Date.now();
  const counters: CounterRow[] = [];
  // The five thread metrics, old predicates, one row per account. VISIBLE occurs 5x -> 5 binds.
  const threadMetrics = await db
    .prepare(
      `SELECT account_id,
         SUM(CASE WHEN bucket = 'imbox' AND bundle_id IS NULL AND seen = 0 AND reply_later = 0 AND set_aside = 0 AND ${VISIBLE} THEN 1 ELSE 0 END) AS imbox_new_threads,
         SUM(CASE WHEN bucket = 'feed' AND seen = 0 AND ${VISIBLE} THEN 1 ELSE 0 END) AS feed_new,
         SUM(CASE WHEN bucket = 'paper_trail' AND bundle_id IS NULL AND seen = 0 AND ${VISIBLE} THEN 1 ELSE 0 END) AS paper_new_threads,
         SUM(CASE WHEN reply_later = 1 AND ${VISIBLE} THEN 1 ELSE 0 END) AS reply_later,
         SUM(CASE WHEN set_aside = 1 AND ${VISIBLE} THEN 1 ELSE 0 END) AS set_aside
       FROM threads t GROUP BY t.account_id`
    )
    .bind(t, t, t, t, t)
    .all<{ account_id: string; imbox_new_threads: number | null; feed_new: number | null; paper_new_threads: number | null; reply_later: number | null; set_aside: number | null }>();
  for (const r of threadMetrics.results) {
    for (const metric of ["imbox_new_threads", "feed_new", "paper_new_threads", "reply_later", "set_aside"] as const) {
      const n = r[metric] ?? 0;
      if (n !== 0) counters.push({ account_id: r.account_id, metric, n });
    }
  }
  // Open bundles with matches, per account (threads share the bundle's account). VISIBLE 2x.
  const openBundles = await db
    .prepare(
      `SELECT b.account_id,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM threads t WHERE t.bundle_id = b.id AND t.account_id = b.account_id AND t.bucket = 'imbox' AND t.reply_later = 0 AND t.set_aside = 0 AND ${VISIBLE}) THEN 1 ELSE 0 END) AS imbox_n,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM threads t WHERE t.bundle_id = b.id AND t.account_id = b.account_id AND t.bucket = 'paper_trail' AND ${VISIBLE}) THEN 1 ELSE 0 END) AS paper_n
       FROM bundles b WHERE b.status = 'open' GROUP BY b.account_id`
    )
    .bind(t, t)
    .all<{ account_id: string; imbox_n: number | null; paper_n: number | null }>();
  for (const r of openBundles.results) {
    if ((r.imbox_n ?? 0) !== 0) counters.push({ account_id: r.account_id, metric: "imbox_open_bundles", n: r.imbox_n ?? 0 });
    if ((r.paper_n ?? 0) !== 0) counters.push({ account_id: r.account_id, metric: "paper_open_bundles", n: r.paper_n ?? 0 });
  }
  // Screener senders = the old COUNT(DISTINCT account_id || '|' || last_from_email), per pair.
  const screener = (
    await db
      .prepare(`SELECT t.account_id, t.last_from_email AS email, COUNT(*) AS refs FROM threads t WHERE t.bucket = 'screener' AND ${VISIBLE} GROUP BY t.account_id, t.last_from_email`)
      .bind(t)
      .all<ScreenerRow>()
  ).results.filter((r) => r.refs !== 0);
  // Match counts keyed by bundle; dangling references (bundle deleted) contribute nothing,
  // exactly like the old EXISTS-over-bundles queries. VISIBLE 2x.
  const bundles = (
    await db
      .prepare(
        `SELECT t.bundle_id AS bundle_id,
           COUNT(CASE WHEN t.bucket = 'imbox' AND t.reply_later = 0 AND t.set_aside = 0 AND ${VISIBLE} THEN 1 END) AS imbox_n,
           COUNT(CASE WHEN t.bucket = 'paper_trail' AND ${VISIBLE} THEN 1 END) AS paper_n
         FROM threads t JOIN bundles b ON b.id = t.bundle_id
         WHERE t.bundle_id IS NOT NULL
         GROUP BY t.bundle_id`
      )
      .bind(t, t)
      .all<BundleMatchRow>()
  ).results;
  return normalize({ counters, screener, bundles });
}

async function expectStateMatches(db: D1Database, ctx: string) {
  const raw = await readDbState(db);
  for (const c of raw.counters) expect(c.n, `${ctx}: counter ${c.account_id}/${c.metric} must not go negative`).toBeGreaterThanOrEqual(0);
  for (const s of raw.screener) expect(s.refs, `${ctx}: screener refs ${s.account_id}/${s.email} must not go negative`).toBeGreaterThanOrEqual(0);
  expect(normalize(raw), ctx).toEqual(await refDbState(db));
}

// ---------------------------------------------------------------- seeding helpers

let seq = 0;
const BUCKETS = ["imbox", "feed", "paper_trail", "screener", "screened_out", "trash"] as const;

interface ThreadSpec {
  bucket?: string;
  seen?: 0 | 1;
  replyLater?: 0 | 1;
  setAside?: 0 | 1;
  bubbleUpAt?: number | null;
  mergedInto?: string | null;
  bundleId?: string | null;
  email?: string;
}

async function insertThread(db: D1Database, accountId: string, spec: ThreadSpec = {}): Promise<string> {
  const id = `t-${++seq}`;
  const t = Date.now() + seq;
  await db
    .prepare(
      `INSERT INTO threads (id, account_id, gmail_thread_id, subject, snippet, bucket, seen, unread, reply_later, set_aside, bubble_up_at, merged_into, bundle_id, last_from_email, last_from_name, message_count, first_message_at, last_message_at, created_at, updated_at)
       VALUES (?, ?, ?, 'subject', 'snippet', ?, ?, 1, ?, ?, ?, ?, ?, ?, 'Sender', 1, ?, ?, ?, ?)`
    )
    .bind(
      id,
      accountId,
      `gt-${++seq}`,
      spec.bucket ?? "imbox",
      spec.seen ?? 0,
      spec.replyLater ?? 0,
      spec.setAside ?? 0,
      spec.bubbleUpAt ?? null,
      spec.mergedInto ?? null,
      spec.bundleId ?? null,
      spec.email ?? "sender@example.com",
      t,
      t,
      t,
      t
    )
    .run();
  return id;
}

async function insertBundle(db: D1Database, accountId: string, status: "open" | "seen", email = "bundle@example.com"): Promise<string> {
  const id = `b-${++seq}`;
  const t = Date.now();
  await db
    .prepare(
      `INSERT INTO bundles (id, account_id, contact_id, email, status, thread_count, message_count, first_message_at, last_message_at, created_at)
       VALUES (?, ?, 'c', ?, ?, 0, 0, ?, ?, ?)`
    )
    .bind(id, accountId, email.toLowerCase(), status, t, t, t)
    .run();
  return id;
}

// ---------------------------------------------------------------- random battery

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("counts triggers: differential battery", () => {
  it("maintains all tables through hundreds of random mutations", async () => {
    const db = testEnv().DB;
    const userA = await seedUser();
    const userB = await seedUser();
    const a1 = await seedAccount(userA.id, { email: "a1@gmail.com" });
    const a2 = await seedAccount(userA.id, { email: "a2@gmail.com" });
    const b1 = await seedAccount(userB.id, { email: "b1@gmail.com" });
    const accounts = [a1.id, a2.id, b1.id];
    const emails = ["news@acme.com", "billing@stripe.com", "digest@github.com", "hello@lob.com", "updates@ship.io", "pal@x.com"];

    const rng = mulberry32(20260421);
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
    const chance = (p: number) => rng() < p;

    const threads: { id: string; account: string; bundle: string | null }[] = [];
    const bundleList: string[] = [];
    const bundleAccount = new Map<string, string>();
    const accountBundles = (account: string) => bundleList.filter((b) => bundleAccount.get(b) === account);

    // Initial state: a mix across accounts, buckets, bundles and flags.
    const bundleA = await insertBundle(db, a1.id, "open", "news@acme.com");
    const bundleA2 = await insertBundle(db, a1.id, "seen", "billing@stripe.com");
    const bundleB = await insertBundle(db, b1.id, "open", "digest@github.com");
    bundleList.push(bundleA, bundleA2, bundleB);
    bundleAccount.set(bundleA, a1.id);
    bundleAccount.set(bundleA2, a1.id);
    bundleAccount.set(bundleB, b1.id);
    const add = async (account: string, spec: ThreadSpec, bundle: string | null = null) => {
      const id = await insertThread(db, account, { ...spec, bundleId: spec.bundleId ?? bundle });
      threads.push({ id, account, bundle: spec.bundleId ?? bundle });
      return id;
    };
    await add(a1.id, { bucket: "screener", email: emails[0] });
    await add(a1.id, { bucket: "screener", email: emails[1] });
    await add(a1.id, { bucket: "screener", email: emails[0], seen: 1 });
    await add(a1.id, { bucket: "imbox", email: emails[2] });
    await add(a1.id, { bucket: "imbox", seen: 1 });
    await add(a1.id, { bucket: "imbox", replyLater: 1 });
    await add(a1.id, { bucket: "imbox", setAside: 1 });
    await add(a1.id, { bucket: "imbox" }, bundleA);
    await add(a1.id, { bucket: "imbox", seen: 1 }, bundleA);
    await add(a1.id, { bucket: "imbox", replyLater: 1 }, bundleA);
    await add(a1.id, { bucket: "feed" });
    await add(a1.id, { bucket: "feed", seen: 1 });
    await add(a1.id, { bucket: "paper_trail" }, bundleA2);
    await add(a1.id, { bucket: "paper_trail", seen: 1 });
    await add(a1.id, { bucket: "screened_out" });
    await add(a1.id, { bucket: "trash" });
    await add(a2.id, { bucket: "screener", email: emails[3] });
    await add(a2.id, { bucket: "imbox" });
    await add(a2.id, { bucket: "paper_trail" }, bundleA2);
    await add(a2.id, { bucket: "feed", seen: 1 });
    await add(b1.id, { bucket: "screener", email: emails[4] });
    await add(b1.id, { bucket: "imbox" }, bundleB);
    await add(b1.id, { bucket: "paper_trail" });
    await add(b1.id, { bucket: "imbox", bubbleUpAt: FAR_FUTURE });

    await expectStateMatches(db, "initial state");
    const allIds = accounts;
    expect(await getCounts(db, allIds)).toEqual(await refCounts(db, allIds));
    expect(await getCounts(db, [a1.id])).toEqual(await refCounts(db, [a1.id]));
    expect(await getCounts(db, [b1.id])).toEqual(await refCounts(db, [b1.id]));

    // ---- seeded random mutation battery
    for (let step = 0; step < 400; step++) {
      const op = pick(["insert", "delete", "update", "update", "update", "update", "insertBundle", "flipBundle", "deleteBundleRaw", "deleteBundleRoute", "bulkMove", "bundleSeenRoute", "repointMerge", "bulkSeen", "flushBubbles"] as const);
      if (op === "insert") {
        const account = pick(accounts);
        const sameAccountBundles = accountBundles(account);
        const bundle = sameAccountBundles.length && chance(0.5) ? pick(sameAccountBundles) : null;
        const sameAccountThreads = threads.filter((t) => t.account === account);
        const mergedInto = sameAccountThreads.length && chance(0.1) ? pick(sameAccountThreads).id : null;
        const id = await insertThread(db, account, {
          bucket: pick(BUCKETS),
          seen: chance(0.3) ? 1 : 0,
          replyLater: chance(0.2) ? 1 : 0,
          setAside: chance(0.2) ? 1 : 0,
          bubbleUpAt: chance(0.2) ? FAR_FUTURE : null,
          email: pick(emails),
          bundleId: bundle,
          mergedInto,
        });
        threads.push({ id, account, bundle });
      } else if (op === "delete" && threads.length > 5) {
        const t = pick(threads);
        await db.prepare(`DELETE FROM threads WHERE id = ?`).bind(t.id).run();
        threads.splice(threads.indexOf(t), 1);
      } else if (op === "update" && threads.length) {
        const t = pick(threads);
        const dim = pick(["bucket", "seen", "replyLater", "setAside", "bundle", "mergedInto", "bubble", "email", "account"] as const);
        if (dim === "bucket") {
          await db.prepare(`UPDATE threads SET bucket = ? WHERE id = ?`).bind(pick(BUCKETS), t.id).run();
        } else if (dim === "seen") {
          await db.prepare(`UPDATE threads SET seen = 1 - seen WHERE id = ?`).bind(t.id).run();
        } else if (dim === "replyLater") {
          await db.prepare(`UPDATE threads SET reply_later = 1 - reply_later WHERE id = ?`).bind(t.id).run();
        } else if (dim === "setAside") {
          await db.prepare(`UPDATE threads SET set_aside = 1 - set_aside WHERE id = ?`).bind(t.id).run();
        } else if (dim === "bundle") {
          const sameAccountBundles = accountBundles(t.account);
          const to = sameAccountBundles.length && chance(0.7) ? pick(sameAccountBundles) : null;
          await db.prepare(`UPDATE threads SET bundle_id = ? WHERE id = ?`).bind(to, t.id).run();
          t.bundle = to;
        } else if (dim === "mergedInto") {
          const others = threads.filter((x) => x.account === t.account && x.id !== t.id);
          const to = others.length && chance(0.6) ? pick(others).id : null;
          await db.prepare(`UPDATE threads SET merged_into = ? WHERE id = ?`).bind(to, t.id).run();
        } else if (dim === "bubble") {
          const to = chance(0.5) ? FAR_FUTURE : null;
          await db.prepare(`UPDATE threads SET bubble_up_at = ? WHERE id = ?`).bind(to, t.id).run();
        } else if (dim === "email") {
          await db.prepare(`UPDATE threads SET last_from_email = ? WHERE id = ?`).bind(pick(emails), t.id).run();
        } else if (dim === "account" && !t.bundle) {
          // The app never re-accounts threads; exercise the defensive path only for un-bundled
          // threads (a bundled thread moving accounts would violate the bundle-account invariant).
          const to = pick(accounts.filter((a) => a !== t.account));
          await db.prepare(`UPDATE threads SET account_id = ? WHERE id = ?`).bind(to, t.id).run();
          t.account = to;
        }
      } else if (op === "insertBundle") {
        const account = pick(accounts);
        const id = await insertBundle(db, account, chance(0.5) ? "open" : "seen", pick(emails));
        bundleList.push(id);
        bundleAccount.set(id, account);
      } else if (op === "flipBundle" && bundleList.length) {
        const b = pick(bundleList);
        await db.prepare(`UPDATE bundles SET status = CASE WHEN status = 'open' THEN 'seen' ELSE 'open' END WHERE id = ?`).bind(b).run();
      } else if (op === "deleteBundleRaw" && bundleList.length) {
        // Raw delete: leaves dangling bundle_id references behind (threads keep pointing at it).
        const b = pick(bundleList);
        await db.prepare(`DELETE FROM bundles WHERE id = ?`).bind(b).run();
        bundleList.splice(bundleList.indexOf(b), 1);
        bundleAccount.delete(b);
      } else if (op === "deleteBundleRoute" && bundleList.length) {
        // Route-style delete: detach threads first (bundles.ts DELETE handler).
        const b = pick(bundleList);
        await db.batch([
          db.prepare(`UPDATE threads SET bundle_id = NULL, updated_at = ? WHERE bundle_id = ?`).bind(Date.now(), b),
          db.prepare(`DELETE FROM bundles WHERE id = ?`).bind(b),
        ]);
        for (const t of threads) if (t.bundle === b) t.bundle = null;
        bundleList.splice(bundleList.indexOf(b), 1);
        bundleAccount.delete(b);
      } else if (op === "bulkMove" && bundleList.length > 1) {
        // Route-style bulk move (bundle fold / assignBundles): UPDATE threads SET bundle_id = ?
        const from = pick(bundleList);
        const candidates = bundleList.filter((b) => b !== from && bundleAccount.get(b) === bundleAccount.get(from));
        const to = candidates.length && chance(0.8) ? pick(candidates) : null;
        await db.prepare(`UPDATE threads SET bundle_id = ?, updated_at = ? WHERE bundle_id = ?`).bind(to, Date.now(), from).run();
        for (const t of threads) if (t.bundle === from) t.bundle = to;
      } else if (op === "bundleSeenRoute" && bundleList.length) {
        // bundles.ts POST /:id/seen: close the batch and mark its threads seen.
        const b = pick(bundleList);
        await db.batch([
          db.prepare(`UPDATE bundles SET status = 'seen', seen_at = ? WHERE id = ?`).bind(Date.now(), b),
          db.prepare(`UPDATE threads SET seen = 1, unread = 0, bubbled = 0, updated_at = ? WHERE bundle_id = ?`).bind(Date.now(), b),
        ]);
      } else if (op === "repointMerge" && threads.length > 2) {
        const y = pick(threads);
        const candidates = threads.filter((x) => x.account === y.account && x.id !== y.id);
        if (!candidates.length) continue;
        const x = pick(candidates);
        // applyAction("merge"): disappear y into x, then re-point anything merged into y.
        await db.batch([
          db.prepare(`UPDATE threads SET merged_into = ?, reply_later = 0, set_aside = 0, updated_at = ? WHERE id = ?`).bind(x.id, Date.now(), y.id),
          db.prepare(`UPDATE threads SET merged_into = ? WHERE merged_into = ?`).bind(x.id, y.id),
        ]);
      } else if (op === "bulkSeen" && threads.length > 3) {
        const ids = threads.slice(0, 1 + Math.floor(rng() * 3)).map((t) => t.id);
        await db
          .prepare(`UPDATE threads SET seen = 1, unread = 0, bubbled = 0, updated_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
          .bind(Date.now(), ...ids)
          .run();
      } else if (op === "flushBubbles") {
        // The exact DML processBubbleUps runs (with a timestamp that makes every pending bubble due).
        await db
          .prepare(`UPDATE threads SET bubbled = 1, bubble_up_at = NULL, seen = 0, unread = 1, updated_at = ? WHERE bubble_up_at IS NOT NULL AND bubble_up_at <= ?`)
          .bind(Date.now(), FAR_FUTURE + 1)
          .run();
      } else {
        continue;
      }
      await expectStateMatches(db, `after step ${step} (${op})`);
    }

    // Final: aggregate reads over every scope still equal the old formulas.
    expect(await getCounts(db, allIds)).toEqual(await refCounts(db, allIds));
    expect(await getCounts(db, [a1.id, a2.id])).toEqual(await refCounts(db, [a1.id, a2.id]));
    expect(await getCounts(db, [b1.id])).toEqual(await refCounts(db, [b1.id]));

    // Backfill reproducibility: wipe the derived tables, re-run 0024, same state comes back.
    const before = normalize(await readDbState(db));
    await db.batch([db.prepare(`DELETE FROM counters`), db.prepare(`DELETE FROM screener_senders`), db.prepare(`DELETE FROM bundle_match_counts`)]);
    await db.batch(splitStatements(m0024).map((s) => db.prepare(s)));
    expect(normalize(await readDbState(db)), "backfill reproduces the incrementally maintained state").toEqual(before);
    expect(await getCounts(db, allIds)).toEqual(await refCounts(db, allIds));
  }, 120_000);

  it("matches the reference through real app paths (ingest, screen, bundle assign)", async () => {
    const env = testEnv();
    const db = env.DB;
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: "me@gmail.com" });

    // Real ingest path: two threads from different senders.
    const r1 = await ingestParsed(env, account, [
      makeParsed({ gmailId: "g1", threadId: "th1", from: addr("new.sender@x.com", "New Sender"), to: [addr(account.email)], subject: "Hello", text: "hi" }),
      makeParsed({ gmailId: "g2", threadId: "th2", from: addr("known@y.com", "Known"), to: [addr(account.email)], subject: "Invoice", text: "pay up" }),
    ]);
    expect(r1.added).toBe(2);
    await expectStateMatches(db, "after ingest");
    expect(await getCounts(db, [account.id])).toEqual(await refCounts(db, [account.id]));

    // Promote the known sender to the imbox with reply-later, then bundle the sender (as the real
    // applyBundleFlag would: flip the existing contact created by ingest).
    await db.prepare(`UPDATE threads SET bucket = 'imbox', reply_later = 1 WHERE id = ?`).bind(r1.threadIds[1]).run();
    await expectStateMatches(db, "after reply-later");
    await db.prepare(`UPDATE contacts SET bundled = 1, screen_status = 'imbox' WHERE account_id = ? AND email = ?`).bind(account.id, "known@y.com").run();
    const r2 = await ingestParsed(env, account, [
      makeParsed({ gmailId: "g3", threadId: "th3", from: addr("known@y.com", "Known"), to: [addr(account.email)], subject: "Invoice 2", text: "pay up 2" }),
    ]);
    expect(r2.added).toBe(1);
    await expectStateMatches(db, "after bundled ingest");
    const bundled = await db.prepare(`SELECT bundle_id FROM threads WHERE id = ?`).bind(r2.threadIds[0]).first<{ bundle_id: string | null }>();
    expect(bundled?.bundle_id).toBeTruthy();

    // App-level mutation paths (same statements the routes issue).
    await db.prepare(`UPDATE threads SET seen = 1, unread = 0 WHERE id = ?`).bind(r1.threadIds[0]).run();
    await db.prepare(`UPDATE threads SET bucket = 'feed' WHERE id = ?`).bind(r1.threadIds[1]).run();
    await expectStateMatches(db, "after route-style updates");

    // processBubbleUps (the real every-minute DML) moves a due bubble into the counters.
    // A past-due-but-unprocessed bubble is the one documented divergence window (the old query
    // counts it as visible, the triggers wait for the cron DML), so no comparison in between.
    const bubId = await insertThread(db, account.id, { bucket: "imbox", seen: 1, bubbleUpAt: Date.now() - 1000, email: "bubble@x.com" });
    const flushed = await processBubbleUps(db);
    // NOTE: meta.changes on a threads UPDATE now includes trigger row writes, so it exceeds the
    // number of flushed threads. Assert on the resulting state instead of the count.
    expect(flushed).toBeGreaterThan(0);
    const flushedRow = await db.prepare(`SELECT bubble_up_at, seen FROM threads WHERE id = ?`).bind(bubId).first<{ bubble_up_at: number | null; seen: number }>();
    expect(flushedRow?.bubble_up_at).toBeNull();
    expect(flushedRow?.seen).toBe(0);
    await expectStateMatches(db, "after processBubbleUps");
    const counts = await getCounts(db, [account.id]);
    expect(counts.imbox_new).toBe(2); // the returned bubble + the open bundle holding th3
  });

  it("readCounters/screenerSenderCount chunking keeps totals stable beyond one IN batch", async () => {
    const db = testEnv().DB;
    const user = await seedUser();
    const account = await seedAccount(user.id);
    await insertThread(db, account.id, { bucket: "screener", email: "a@x.com" });
    await insertThread(db, account.id, { bucket: "imbox", email: "b@x.com" });
    const fake = Array.from({ length: 95 }, () => crypto.randomUUID());
    const withFake = [account.id, ...fake];
    expect(await readCounters(db, withFake)).toEqual(await readCounters(db, [account.id]));
    expect(await screenerSenderCount(db, withFake)).toBe(await screenerSenderCount(db, [account.id]));
    expect(await getCounts(db, withFake)).toEqual(await getCounts(db, [account.id]));
    expect(await getCounts(db, [])).toEqual(ZERO_COUNTS);
  });
});

// ---------------------------------------------------------------- route + badge equivalence

async function insertSession(userId: string): Promise<string> {
  const id = crypto.randomUUID().replaceAll("-", "");
  const t = Date.now();
  await testEnv()
    .DB.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, NULL)`)
    .bind(id, userId, t, t + 30 * 24 * 3600 * 1000)
    .run();
  return id;
}

describe("counts reads: route and badge equivalence", () => {
  it("GET /api/counts returns the same JSON the old six statements produced", async () => {
    const db = testEnv().DB;
    const user = await seedUser();
    const other = await seedUser();
    const a1 = await seedAccount(user.id, { email: "first@gmail.com" });
    const a2 = await seedAccount(user.id, { email: "second@gmail.com" });
    const otherAcct = await seedAccount(other.id, { email: "intruder@gmail.com" });

    const bundle = await insertBundle(db, a1.id, "open", "news@acme.com");
    const paperBundle = await insertBundle(db, a1.id, "open", "docs@paper.com");
    const seenBundle = await insertBundle(db, a1.id, "seen", "old@timer.com");
    // Screener: 3 distinct (account, sender) pairs; a future-bubble screener thread is invisible.
    await insertThread(db, a1.id, { bucket: "screener", email: "news@acme.com" });
    await insertThread(db, a1.id, { bucket: "screener", email: "billing@stripe.com", seen: 1 });
    await insertThread(db, a2.id, { bucket: "screener", email: "news@acme.com" });
    await insertThread(db, a2.id, { bucket: "screener", email: "hidden@lurk.com", bubbleUpAt: FAR_FUTURE });
    // Imbox: new, seen, reply-later, set-aside, bundled (open + seen bundles), future bubble, merged.
    await insertThread(db, a1.id, { bucket: "imbox" });
    await insertThread(db, a1.id, { bucket: "imbox", seen: 1 });
    await insertThread(db, a1.id, { bucket: "imbox", replyLater: 1 });
    await insertThread(db, a1.id, { bucket: "imbox", setAside: 1 });
    await insertThread(db, a1.id, { bucket: "imbox", bundleId: bundle });
    await insertThread(db, a1.id, { bucket: "imbox", bundleId: bundle, seen: 1 });
    await insertThread(db, a1.id, { bucket: "imbox", bundleId: seenBundle });
    await insertThread(db, a1.id, { bucket: "imbox", bubbleUpAt: FAR_FUTURE });
    await insertThread(db, a1.id, { bucket: "imbox", mergedInto: "t-nonexistent" });
    // Feed.
    await insertThread(db, a1.id, { bucket: "feed" });
    await insertThread(db, a1.id, { bucket: "feed", seen: 1 });
    await insertThread(db, a2.id, { bucket: "feed" });
    // Paper trail: new, seen, bundled, reply-later-inside-open-bundle (no rl/sa filter for paper bundles).
    await insertThread(db, a1.id, { bucket: "paper_trail" });
    await insertThread(db, a1.id, { bucket: "paper_trail", seen: 1 });
    await insertThread(db, a1.id, { bucket: "paper_trail", bundleId: paperBundle });
    await insertThread(db, a1.id, { bucket: "paper_trail", bundleId: paperBundle, replyLater: 1 });
    // Noise that must count nowhere.
    await insertThread(db, a1.id, { bucket: "trash" });
    await insertThread(db, a1.id, { bucket: "screened_out" });
    await insertThread(db, otherAcct.id, { bucket: "imbox" });
    await insertThread(db, otherAcct.id, { bucket: "screener", email: "nope@nope.com" });

    const sid = await insertSession(user.id);
    const res = await SELF.fetch("http://localhost/api/counts", { headers: { cookie: `hey_session=${sid}` } });
    expect(res.status).toBe(200);
    const body = await res.json<RefCounts>();
    const expected = await refCounts(db, [a1.id, a2.id]);
    expect(body).toEqual(expected);
    expect(body).toEqual({ screener: 3, imbox_new: 2, feed_new: 2, paper_trail_new: 2, reply_later: 2, set_aside: 1 });

    // Single-account scope via the X-Account-Id header.
    const scoped = await SELF.fetch("http://localhost/api/counts", { headers: { cookie: `hey_session=${sid}`, "x-account-id": a2.id } });
    expect(scoped.status).toBe(200);
    const scopedBody = await scoped.json<RefCounts>();
    expect(scopedBody).toEqual(await refCounts(db, [a2.id]));
    expect(scopedBody.screener).toBe(1);

    // And the read helpers agree with the route.
    expect(await getCounts(db, [a1.id, a2.id])).toEqual(expected);
  });

  it("appBadgeCount equals the old user-scoped query", async () => {
    const db = testEnv().DB;
    const user = await seedUser();
    const stranger = await seedUser();
    const a1 = await seedAccount(user.id, { email: "one@gmail.com" });
    const a2 = await seedAccount(user.id, { email: "two@gmail.com" });
    const strangerAcct = await seedAccount(stranger.id, { email: "stranger@gmail.com" });

    await insertThread(db, a1.id, { bucket: "imbox" });
    await insertThread(db, a1.id, { bucket: "imbox", seen: 1 });
    await insertThread(db, a1.id, { bucket: "screener", email: "news@acme.com" });
    await insertThread(db, a1.id, { bucket: "screener", email: "news@acme.com", seen: 1 });
    const bundle = await insertBundle(db, a2.id, "open", "docs@paper.com");
    await insertThread(db, a2.id, { bundleId: bundle, bucket: "imbox" });
    await insertThread(db, a2.id, { bucket: "imbox", replyLater: 1 });
    await insertThread(db, strangerAcct.id, { bucket: "imbox" });
    await insertThread(db, strangerAcct.id, { bucket: "screener", email: "nope@nope.com" });

    expect((await accountIdsForUser(db, user.id)).sort()).toEqual([a1.id, a2.id].sort());
    const t = Date.now();
    const imboxThreads =
      (
        await db
          .prepare(
            `SELECT COUNT(*) AS n FROM threads t JOIN accounts a ON a.id = t.account_id
             WHERE a.user_id = ? AND t.bucket = 'imbox' AND t.bundle_id IS NULL AND t.seen = 0
               AND t.reply_later = 0 AND t.set_aside = 0 AND ${VISIBLE}`
          )
          .bind(user.id, t)
          .first<{ n: number }>()
      )?.n ?? 0;
    const openBundles =
      (
        await db
          .prepare(
            `SELECT COUNT(*) AS n FROM bundles b
             WHERE b.status = 'open' AND EXISTS (
               SELECT 1 FROM threads t JOIN accounts a ON a.id = t.account_id
               WHERE t.bundle_id = b.id AND a.user_id = ? AND t.bucket = 'imbox'
                 AND t.reply_later = 0 AND t.set_aside = 0 AND ${VISIBLE})`
          )
          .bind(user.id, t)
          .first<{ n: number }>()
      )?.n ?? 0;
    const screenerSenders =
      (
        await db
          .prepare(
            `SELECT COUNT(DISTINCT t.account_id || '|' || t.last_from_email) AS n FROM threads t JOIN accounts a ON a.id = t.account_id
             WHERE a.user_id = ? AND t.bucket = 'screener' AND ${VISIBLE}`
          )
          .bind(user.id, t)
          .first<{ n: number }>()
      )?.n ?? 0;
    const badge = await appBadgeCount(db, user.id);
    expect(badge).toBe(Math.max(0, imboxThreads + openBundles + screenerSenders));
    expect(badge).toBe(3); // 1 imbox thread + 1 open bundle + 1 screener sender
    expect(badge).toBe(await badgeCount(db, await accountIdsForUser(db, user.id)));
  });
});
