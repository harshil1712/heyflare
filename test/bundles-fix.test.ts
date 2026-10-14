import { describe, expect, it } from "vitest";
import type { Bundle } from "../src/shared/types";
import { attachAvatars, inClause, loadBundles, toThreadSummary, type BundleRow, type ThreadRow } from "../src/worker/db";
import { seedAccount, seedUser, testEnv } from "./helpers";

/**
 * Reference implementation: the original N+1 version of `loadBundles`, copied verbatim. One query
 * for the bundle rows, then per bundle a latest-thread query, a counts query and an avatar pass.
 * The optimized implementation must return deep-equal output.
 */
async function loadBundlesReference(db: D1Database, accountIds: string[], bucket: "imbox" | "paper_trail", now_: number): Promise<Bundle[]> {
  if (!accountIds.length) return [];
  const sc = inClause(accountIds);
  const rows = await db
    .prepare(
      `SELECT b.*, c.name AS contact_name, c.avatar_url AS contact_avatar FROM bundles b
       LEFT JOIN contacts c ON c.id = b.contact_id
       WHERE b.account_id IN ${sc.sql}
         AND EXISTS (SELECT 1 FROM threads t WHERE t.bundle_id = b.id AND t.bucket = ? AND t.merged_into IS NULL AND t.reply_later = 0 AND t.set_aside = 0 AND (t.bubble_up_at IS NULL OR t.bubble_up_at <= ?))
       ORDER BY b.last_message_at DESC LIMIT 200`
    )
    .bind(...sc.params, bucket, now_)
    .all<BundleRow & { contact_name: string | null; contact_avatar: string | null }>();
  if (!rows.results.length) return [];
  const out: Bundle[] = [];
  for (const b of rows.results) {
    const latestRow = await db
      .prepare(
        `SELECT t.* FROM threads t WHERE t.bundle_id = ? AND t.bucket = ? AND t.merged_into IS NULL AND t.reply_later = 0 AND t.set_aside = 0 AND (t.bubble_up_at IS NULL OR t.bubble_up_at <= ?) ORDER BY t.last_message_at DESC LIMIT 1`
      )
      .bind(b.id, bucket, now_)
      .first<ThreadRow>();
    if (!latestRow) continue;
    const counts = await db
      .prepare(`SELECT COUNT(*) AS threads, COALESCE(SUM(message_count), 0) AS messages FROM threads t WHERE t.bundle_id = ? AND t.merged_into IS NULL AND t.reply_later = 0 AND t.set_aside = 0`)
      .bind(b.id)
      .first<{ threads: number; messages: number }>();
    const [latest] = await attachAvatars(db, [toThreadSummary(latestRow, [])]);
    out.push({
      id: b.id,
      contact_id: b.contact_id,
      account_id: b.account_id,
      email: b.email,
      name: b.contact_name || latest.last_from.name || b.email,
      avatar_url: b.contact_avatar || latest.last_from.avatar_url || "",
      status: b.status,
      thread_count: counts?.threads ?? b.thread_count,
      message_count: counts?.messages ?? b.message_count,
      latest,
      first_message_at: b.first_message_at,
      last_message_at: b.last_message_at,
    });
  }
  return out;
}

let seq = 0;
const nextId = () => crypto.randomUUID();

async function seedContact(accountId: string, email: string, opts: { name?: string; avatar?: string } = {}): Promise<string> {
  const db = testEnv().DB;
  const t = Date.now();
  const id = nextId();
  await db
    .prepare(
      `INSERT INTO contacts (id, account_id, email, name, screen_status, screened_at, first_seen_at, last_seen_at, message_count, notes, avatar_url, bundled)
       VALUES (?, ?, ?, ?, 'imbox', ?, ?, ?, 0, '', ?, 1)`
    )
    .bind(id, accountId, email.toLowerCase(), opts.name ?? "", t, t, t, opts.avatar ?? "")
    .run();
  return id;
}

async function seedBundle(
  accountId: string,
  contactId: string,
  email: string,
  opts: { status?: "open" | "seen"; lastAt?: number; firstAt?: number } = {}
): Promise<string> {
  const db = testEnv().DB;
  const t = Date.now();
  const id = nextId();
  // Stale counts on purpose: loadBundles must recompute them from threads, not trust the row.
  await db
    .prepare(
      `INSERT INTO bundles (id, account_id, contact_id, email, status, thread_count, message_count, first_message_at, last_message_at, seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, 999, 999, ?, ?, NULL, ?)`
    )
    .bind(id, accountId, contactId, email.toLowerCase(), opts.status ?? "open", opts.firstAt ?? t, opts.lastAt ?? t, t)
    .run();
  return id;
}

interface ThreadSeed {
  lastAt: number;
  firstAt?: number;
  bucket?: string;
  messageCount?: number;
  subject?: string;
  customSubject?: string | null;
  lastFromEmail?: string;
  lastFromName?: string;
  setAside?: boolean;
  replyLater?: boolean;
  bubbleUpAt?: number | null;
  mergedInto?: string | null;
  participants?: { email: string; name?: string }[];
}

async function seedThread(accountId: string, bundleId: string | null, o: ThreadSeed): Promise<string> {
  const db = testEnv().DB;
  const id = nextId();
  await db
    .prepare(
      `INSERT INTO threads (id, account_id, gmail_thread_id, subject, custom_subject, snippet, bucket, seen, unread, reply_later, set_aside, bubble_up_at, merged_into, participants_json, last_from_email, last_from_name, message_count, first_message_at, last_message_at, is_sent_only, bundle_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .bind(
      id,
      accountId,
      `gt-${++seq}`,
      o.subject ?? "Subject",
      o.customSubject ?? null,
      "snippet text",
      o.bucket ?? "imbox",
      o.replyLater ? 1 : 0,
      o.setAside ? 1 : 0,
      o.bubbleUpAt ?? null,
      o.mergedInto ?? null,
      JSON.stringify(o.participants ?? []),
      o.lastFromEmail ?? "sender@example.com",
      o.lastFromName ?? "Sender",
      o.messageCount ?? 1,
      o.firstAt ?? o.lastAt,
      o.lastAt,
      bundleId,
      Date.now(),
      Date.now()
    )
    .run();
  return id;
}

async function seedAddressBook(accountId: string, email: string, avatar: string): Promise<void> {
  await testEnv()
    .DB.prepare(`INSERT INTO address_book (account_id, email, name, avatar_url, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(accountId, email.toLowerCase(), "", avatar, Date.now())
    .run();
}

describe("loadBundles (optimized vs reference)", () => {
  it("matches the reference implementation exactly on a mixed dataset", async () => {
    const db = testEnv().DB;
    const user = await seedUser();
    const other = await seedUser();
    const a1 = await seedAccount(user.id, { email: "me1@gmail.com" });
    const a2 = await seedAccount(user.id, { email: "me2@gmail.com" });
    const a3 = await seedAccount(other.id, { email: "other@gmail.com" });

    const base = Date.now();
    const NOW = base + 1000;
    const future = base + 10_000_000;

    // Contacts. c2 has empty name/avatar so the fallback chain is exercised.
    const c1 = await seedContact(a1.id, "news@acme.com", { name: "Acme News", avatar: "https://img/acme.png" });
    const c2 = await seedContact(a1.id, "billing@stripe.com", { name: "", avatar: "" });
    const cP = await seedContact(a1.id, "helper@p.com", { name: "Helper One", avatar: "https://img/helper.png" });
    await seedContact(a3.id, "news@acme.com", { name: "Acme Other", avatar: "https://img/acme-other.png" });
    await seedAddressBook(a1.id, "billing@stripe.com", "https://img/stripe-ab.png");
    await seedAddressBook(a2.id, "digest@github.com", "https://img/gh-ab.png");

    // B1: mixed threads. latest should be t2 (t3 set aside, t4 bubbled into the future).
    // Counts (no bucket/bubble filter): t1, t2, t4 => 3 threads, 6 messages.
    const b1 = await seedBundle(a1.id, c1, "news@acme.com", { lastAt: base + 10000 });
    await seedThread(a1.id, b1, { lastAt: base + 5000, messageCount: 2, lastFromEmail: "news@acme.com", lastFromName: "Acme News" });
    const t2 = await seedThread(a1.id, b1, {
      lastAt: base + 6000,
      messageCount: 3,
      subject: "acme weekly",
      customSubject: "Acme Weekly",
      lastFromEmail: "news@acme.com",
      lastFromName: "Acme News",
      participants: [{ email: "helper@p.com", name: "Helper One" }, { email: "news@acme.com", name: "Acme News" }],
    });
    await seedThread(a1.id, b1, { lastAt: base + 9000, messageCount: 7, setAside: true });
    await seedThread(a1.id, b1, { lastAt: base + 8000, messageCount: 1, bubbleUpAt: future });

    // B2: a visible imbox thread + a feed thread. The feed thread must not be the latest
    // (bucket filter) but must count toward thread/message counts (no bucket filter there).
    // Name falls back to the bundle email (contact name is empty, last_from name is empty).
    const b2 = await seedBundle(a1.id, c2, "billing@stripe.com", { lastAt: base + 9000, status: "seen" });
    await seedThread(a1.id, b2, { lastAt: base + 4000, messageCount: 5, lastFromEmail: "billing@stripe.com", lastFromName: "" });
    await seedThread(a1.id, b2, { lastAt: base + 4500, messageCount: 4, bucket: "feed", lastFromEmail: "billing@stripe.com", lastFromName: "" });

    // B3..B6: bundles whose every thread is hidden in one of the four ways -> must not appear.
    const b3 = await seedBundle(a1.id, c1, "digest@nope1.com", { lastAt: base + 8000 });
    await seedThread(a1.id, b3, { lastAt: base + 7000, setAside: true });
    const b4 = await seedBundle(a1.id, c1, "digest@nope2.com", { lastAt: base + 7500 });
    await seedThread(a1.id, b4, { lastAt: base + 7200, replyLater: true });
    const b5 = await seedBundle(a1.id, c1, "digest@nope3.com", { lastAt: base + 7400 });
    await seedThread(a1.id, b5, { lastAt: base + 7300, mergedInto: nextId() });
    const b6 = await seedBundle(a1.id, c1, "digest@nope4.com", { lastAt: base + 7600 });
    await seedThread(a1.id, b6, { lastAt: base + 7100, bubbleUpAt: future });

    // B7: on the second account, contact row missing (LEFT JOIN null) -> name falls back to
    // last_from.name, avatar to the address-book lookup.
    const b7 = await seedBundle(a2.id, "missing-contact", "digest@github.com", { lastAt: base + 2000 });
    await seedThread(a2.id, b7, { lastAt: base + 1000, messageCount: 1, lastFromEmail: "digest@github.com", lastFromName: "GitHub Mailer" });

    // B8: another user's account, newest of all -> must never leak in.
    const b8 = await seedBundle(a3.id, nextId(), "news@acme.com", { lastAt: base + 15000 });
    await seedThread(a3.id, b8, { lastAt: base + 14000, messageCount: 9 });

    // B9: one paper_trail thread + one imbox thread. In the imbox load the imbox thread is the
    // latest; in the paper_trail load the paper_trail one. Counts ignore bucket either way.
    const b9 = await seedBundle(a1.id, c1, "weekly@paper.com", { lastAt: base + 7000 });
    const p1t = await seedThread(a1.id, b9, { lastAt: base + 3000, messageCount: 2, bucket: "paper_trail", lastFromEmail: "weekly@paper.com" });
    const p2t = await seedThread(a1.id, b9, { lastAt: base + 3500, messageCount: 1, bucket: "imbox", lastFromEmail: "weekly@paper.com" });

    // B10: bubble boundary -- bubble_up_at exactly NOW must count as visible (<=).
    const b10 = await seedBundle(a1.id, c1, "edge@bubble.com", { lastAt: base + 6000 });
    await seedThread(a1.id, b10, { lastAt: base + 5500, messageCount: 1, bubbleUpAt: NOW });

    // A thread with no bundle at all: must not influence anything.
    await seedThread(a1.id, null, { lastAt: base + 11000, messageCount: 1 });

    const expectedIds = [b1, b2, b9, b10, b7];

    const fast = await loadBundles(db, [a1.id, a2.id], "imbox", NOW);
    const reference = await loadBundlesReference(db, [a1.id, a2.id], "imbox", NOW);
    expect(fast).toEqual(reference);

    expect(fast.map((b) => b.id)).toEqual(expectedIds);

    const byId = new Map(fast.map((b) => [b.id, b]));
    const one = byId.get(b1)!;
    expect(one.thread_count).toBe(3);
    expect(one.message_count).toBe(6);
    expect(one.latest.id).toBe(t2);
    expect(one.latest.subject).toBe("Acme Weekly");
    expect(one.name).toBe("Acme News");
    expect(one.avatar_url).toBe("https://img/acme.png");
    expect(one.latest.last_from.avatar_url).toBe("https://img/acme.png");
    expect(one.latest.participants.find((p) => p.email === "helper@p.com")?.avatar_url).toBe("https://img/helper.png");

    const two = byId.get(b2)!;
    expect(two.status).toBe("seen");
    expect(two.thread_count).toBe(2);
    expect(two.message_count).toBe(9);
    expect(two.name).toBe("billing@stripe.com");
    expect(two.avatar_url).toBe("https://img/stripe-ab.png");

    const seven = byId.get(b7)!;
    expect(seven.name).toBe("GitHub Mailer");
    expect(seven.avatar_url).toBe("https://img/gh-ab.png");

    // paper_trail bucket: only b9 qualifies, and its latest is the paper_trail thread.
    const fastPaper = await loadBundles(db, [a1.id], "paper_trail", NOW);
    const refPaper = await loadBundlesReference(db, [a1.id], "paper_trail", NOW);
    expect(fastPaper).toEqual(refPaper);
    expect(fastPaper.map((b) => b.id)).toEqual([b9]);
    expect(fastPaper[0].latest.id).toBe(p1t);
    expect(fastPaper[0].thread_count).toBe(2);
    expect(fastPaper[0].message_count).toBe(3);
    void p2t;
  });

  it("matches the reference for edge cases (empty accounts, empty results)", async () => {
    const db = testEnv().DB;
    const user = await seedUser();
    const a1 = await seedAccount(user.id, { email: "me@gmail.com" });

    expect(await loadBundles(db, [], "imbox", Date.now())).toEqual(await loadBundlesReference(db, [], "imbox", Date.now()));
    expect(await loadBundles(db, [], "imbox", Date.now())).toEqual([]);

    // An account with no bundles at all.
    expect(await loadBundles(db, [a1.id], "imbox", Date.now())).toEqual(await loadBundlesReference(db, [a1.id], "imbox", Date.now()));
    expect(await loadBundles(db, [a1.id], "imbox", Date.now())).toEqual([]);

    // A bundle whose only thread is a future bubble: hidden both ways.
    const base = Date.now();
    const c = await seedContact(a1.id, "x@y.com", { name: "X" });
    const b = await seedBundle(a1.id, c, "x@y.com", { lastAt: base + 1000 });
    await seedThread(a1.id, b, { lastAt: base, bubbleUpAt: base + 1000 });
    const now2 = base - 1; // bubble not yet due
    expect(await loadBundles(db, [a1.id], "imbox", now2)).toEqual(await loadBundlesReference(db, [a1.id], "imbox", now2));
    expect(await loadBundles(db, [a1.id], "imbox", now2)).toEqual([]);
    // Once the bubble is due, the bundle appears with that thread as latest.
    const now3 = base + 2000;
    const fast = await loadBundles(db, [a1.id], "imbox", now3);
    expect(fast).toEqual(await loadBundlesReference(db, [a1.id], "imbox", now3));
    expect(fast.map((x) => x.id)).toEqual([b]);
  });
});
