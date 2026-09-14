// Web Push: subscription CRUD, Imbox/Screener gating, VAPID-authenticated pushes (SW shows the title).
import type { Env } from "./env";
import type { ThreadRow } from "./db";
import { uid, now } from "./db";

const COOLDOWN_MS = 6 * 3600_000; // don't re-notify the same thread within 6h

export interface PushSubRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
}

type NotifyThread = Pick<ThreadRow, "id" | "bucket" | "seen" | "reply_later" | "is_sent_only" | "last_from_email" | "last_from_name">;

/** Threads that should wake the user's phone: Imbox, Reply Later, or Screener. */
export function threadsToNotify(threads: Pick<ThreadRow, "id" | "bucket" | "seen" | "reply_later" | "is_sent_only">[]): string[] {
  return threads
    .filter(
      (t) =>
        !t.is_sent_only &&
        t.seen === 0 &&
        (t.bucket === "imbox" || t.bucket === "screener" || t.reply_later === 1)
    )
    .map((t) => t.id);
}

function senderLabel(t: Pick<ThreadRow, "last_from_email" | "last_from_name">): string {
  const name = (t.last_from_name || "").trim();
  const email = (t.last_from_email || "").trim();
  return name || email || "Someone";
}

/** Title / body / deep-link for a batch of due threads (Imbox, Reply Later, Screener). */
export function pushCopyForThreads(dueThreads: NotifyThread[]): {
  title: string;
  body: string;
  url: string;
} {
  const imboxish = dueThreads.filter((t) => t.bucket === "imbox" || t.reply_later === 1);
  const screener = dueThreads.filter((t) => t.bucket === "screener");
  const screenerByEmail = new Map<string, NotifyThread>();
  for (const t of screener) {
    const key = t.last_from_email.toLowerCase();
    if (!screenerByEmail.has(key)) screenerByEmail.set(key, t);
  }
  const screenerSenders = [...screenerByEmail.values()];

  if (imboxish.length && !screenerSenders.length) {
    return {
      title: imboxish.length === 1 ? "New mail" : `${imboxish.length} new messages`,
      body: imboxish.length === 1 ? "Something new in your Imbox." : "Open heyflare to catch up.",
      url: `/t/${imboxish[0].id}`,
    };
  }

  if (screenerSenders.length && !imboxish.length) {
    if (screenerSenders.length === 1) {
      const who = senderLabel(screenerSenders[0]);
      return {
        title: "New sender",
        body: `${who} is waiting in the Screener.`,
        url: "/screener",
      };
    }
    return {
      title: `${screenerSenders.length} new senders`,
      body: "Open heyflare to decide who gets in.",
      url: "/screener",
    };
  }

  // Mixed Imbox + Screener in one sync batch.
  const primary = imboxish[0] ?? screener[0];
  const parts: string[] = [];
  if (imboxish.length) parts.push(imboxish.length === 1 ? "1 in Imbox" : `${imboxish.length} in Imbox`);
  if (screenerSenders.length) {
    parts.push(screenerSenders.length === 1 ? "1 in Screener" : `${screenerSenders.length} in Screener`);
  }
  return {
    title: "New mail",
    body: parts.join(", ") + ".",
    url: primary.bucket === "screener" ? "/screener" : `/t/${primary.id}`,
  };
}

export async function upsertPushSubscription(
  env: Env,
  userId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent?: string | null
): Promise<PushSubRow> {
  const t = now();
  const existing = await env.DB.prepare(`SELECT * FROM push_subscriptions WHERE endpoint = ?`).bind(sub.endpoint).first<PushSubRow>();
  if (existing) {
    await env.DB.prepare(`UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, user_agent = ?, last_seen_at = ? WHERE id = ?`)
      .bind(userId, sub.keys.p256dh, sub.keys.auth, userAgent ?? null, t, existing.id)
      .run();
    return { ...existing, user_id: userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, last_seen_at: t };
  }
  const row: PushSubRow = {
    id: uid(),
    user_id: userId,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    user_agent: userAgent ?? null,
    created_at: t,
    last_seen_at: t,
  };
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(row.id, row.user_id, row.endpoint, row.p256dh, row.auth, row.user_agent, row.created_at, row.last_seen_at)
    .run();
  return row;
}

export async function deletePushSubscription(env: Env, userId: string, endpoint: string): Promise<boolean> {
  const r = await env.DB.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`).bind(userId, endpoint).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function listPushSubscriptions(env: Env, userId: string): Promise<PushSubRow[]> {
  return (await env.DB.prepare(`SELECT * FROM push_subscriptions WHERE user_id = ?`).bind(userId).all<PushSubRow>()).results;
}

/** Which of these thread ids have not been notified recently for this user. */
export async function filterNotifyCooldown(env: Env, userId: string, threadIds: string[]): Promise<string[]> {
  if (!threadIds.length) return [];
  const t = now();
  const out: string[] = [];
  for (const id of threadIds) {
    const row = await env.DB.prepare(`SELECT notified_at FROM push_notify_log WHERE user_id = ? AND thread_id = ?`)
      .bind(userId, id)
      .first<{ notified_at: number }>();
    if (row && t - row.notified_at < COOLDOWN_MS) continue;
    out.push(id);
  }
  return out;
}

export type WebPushMessage = {
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Home-screen icon badge count (iOS/Android PWA Badging API). */
  badge?: number;
};

/**
 * Encrypted Web Push (RFC 8291 aes128gcm + VAPID). Works with Chrome, Firefox, Android, and iOS Home Screen PWAs.
 * VAPID_PUBLIC_KEY = base64url uncompressed P-256 point; VAPID_PRIVATE_KEY = JWK `d` (see scripts/gen-vapid.mjs).
 */
export async function sendPush(
  env: Env,
  sub: PushSubRow,
  message: WebPushMessage = { title: "New mail", body: "Something new landed in your Imbox", data: { url: "/" } }
): Promise<"ok" | "gone" | "skip" | "error"> {
  const priv = env.VAPID_PRIVATE_KEY;
  const pub = env.VAPID_PUBLIC_KEY;
  if (!priv || !pub) return "skip";
  try {
    const { buildPushPayload } = await import("@block65/webcrypto-web-push");
    const payload = await buildPushPayload(
      {
        data: {
          title: message.title,
          body: message.body,
          badge: message.badge ?? 0,
          data: message.data ?? { url: "/" },
        },
        options: { ttl: 60, urgency: "high" },
      },
      { endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      {
        subject: env.VAPID_SUBJECT || "mailto:owner@heyflare.local",
        publicKey: pub,
        privateKey: priv,
      }
    );
    const res = await fetch(sub.endpoint, payload);
    if (res.status === 404 || res.status === 410) return "gone";
    if (!res.ok) return "error";
    return "ok";
  } catch {
    return "error";
  }
}

/**
 * Unseen Imbox + Screener counts for the home-screen badge (PWA Badging API).
 * Scoped to every account the user owns.
 */
export async function appBadgeCount(db: D1Database, userId: string): Promise<number> {
  const t = now();
  const visible = `t.merged_into IS NULL AND (t.bubble_up_at IS NULL OR t.bubble_up_at <= ?)`;
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM threads t JOIN accounts a ON a.id = t.account_id
           WHERE a.user_id = ? AND t.bucket = 'imbox' AND t.bundle_id IS NULL AND t.seen = 0
             AND t.reply_later = 0 AND t.set_aside = 0 AND ${visible})
       + (SELECT COUNT(*) FROM bundles b
           WHERE b.status = 'open' AND EXISTS (
             SELECT 1 FROM threads t JOIN accounts a ON a.id = t.account_id
             WHERE t.bundle_id = b.id AND a.user_id = ? AND t.bucket = 'imbox'
               AND t.reply_later = 0 AND t.set_aside = 0 AND ${visible}
           ))
       + (SELECT COUNT(DISTINCT t.account_id || '|' || t.last_from_email) FROM threads t JOIN accounts a ON a.id = t.account_id
           WHERE a.user_id = ? AND t.bucket = 'screener' AND ${visible})
       AS n`
    )
    .bind(userId, t, userId, t, userId, t)
    .first<{ n: number }>();
  return Math.max(0, row?.n ?? 0);
}

/**
 * After ingest: notify the account owner about newly arrived Imbox / Reply Later / Screener threads.
 * Dedupes per thread + cooldown; drops gone Web Push subscriptions.
 */
export async function notifyNewMail(
  env: Env,
  userId: string,
  threads: NotifyThread[]
): Promise<{ attempted: number; notified_threads: number; skipped: number }> {
  const candidates = threadsToNotify(threads);
  const due = await filterNotifyCooldown(env, userId, candidates);
  if (!due.length) return { attempted: 0, notified_threads: 0, skipped: candidates.length };

  const subs = await listPushSubscriptions(env, userId);
  if (!subs.length) return { attempted: 0, notified_threads: 0, skipped: due.length };

  const dueSet = new Set(due);
  const dueThreads = threads.filter((t) => dueSet.has(t.id));
  const { title, body, url } = pushCopyForThreads(dueThreads);
  const badge = await appBadgeCount(env.DB, userId).catch(() => due.length);
  const pushMessage: WebPushMessage = {
    title,
    body,
    badge,
    data: { url, badge: String(badge) },
  };

  let attempted = 0;
  for (const sub of subs) {
    const r = await sendPush(env, sub, pushMessage);
    if (r === "gone") {
      await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).bind(sub.id).run();
      continue;
    }
    if (r === "ok") attempted++;
  }

  const t = now();
  for (const threadId of due) {
    await env.DB.prepare(
      `INSERT INTO push_notify_log (user_id, thread_id, notified_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, thread_id) DO UPDATE SET notified_at = excluded.notified_at`
    )
      .bind(userId, threadId, t)
      .run();
  }
  return { attempted, notified_threads: due.length, skipped: candidates.length - due.length };
}

