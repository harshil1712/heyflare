// Web Push: subscription CRUD, Imbox gating, VAPID-authenticated empty pushes (SW shows the title).
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

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

/** Threads that should wake the user's phone: new Imbox (or Reply Later tray). */
export function threadsToNotify(threads: Pick<ThreadRow, "id" | "bucket" | "seen" | "reply_later" | "is_sent_only">[]): string[] {
  return threads
    .filter((t) => !t.is_sent_only && (t.bucket === "imbox" || t.reply_later === 1) && t.seen === 0)
    .map((t) => t.id);
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

async function importVapidPrivateKey(pemOrB64: string): Promise<CryptoKey> {
  // Expect raw PKCS8 base64 (no PEM headers) or full PEM.
  const cleaned = pemOrB64.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", bin, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function vapidAuthHeader(env: Env, endpoint: string): Promise<string | null> {
  const priv = env.VAPID_PRIVATE_KEY;
  const pub = env.VAPID_PUBLIC_KEY;
  const sub = env.VAPID_SUBJECT || "mailto:owner@heyflare.local";
  if (!priv || !pub) return null;
  const audience = new URL(endpoint).origin;
  const key = await importVapidPrivateKey(priv);
  const header = b64urlJson({ typ: "JWT", alg: "ES256" });
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const payload = b64urlJson({ aud: audience, exp, sub });
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  // Convert IEEE P1363 sig to... WebCrypto ECDSA gives P1363 already; JWT wants that raw r||s.
  const jwt = `${header}.${payload}.${b64url(sig)}`;
  return `vapid t=${jwt}, k=${pub}`;
}

/** Send an empty (or minimal) Web Push; SW paints the notification. Returns false if unconfigured / gone. */
export async function sendPush(env: Env, sub: PushSubRow): Promise<"ok" | "gone" | "skip" | "error"> {
  const auth = await vapidAuthHeader(env, sub.endpoint).catch(() => null);
  if (!auth) return "skip";
  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        authorization: auth,
        ttl: "60",
        urgency: "high",
        "content-length": "0",
      },
    });
    if (res.status === 404 || res.status === 410) return "gone";
    if (!res.ok) return "error";
    return "ok";
  } catch {
    return "error";
  }
}

/**
 * After ingest: notify the account owner about newly arrived Imbox / Reply Later threads.
 * Dedupes per thread + cooldown; drops gone subscriptions.
 */
export async function notifyNewMail(
  env: Env,
  userId: string,
  threads: Pick<ThreadRow, "id" | "bucket" | "seen" | "reply_later" | "is_sent_only">[]
): Promise<{ attempted: number; notified_threads: number; skipped: number }> {
  const candidates = threadsToNotify(threads);
  const due = await filterNotifyCooldown(env, userId, candidates);
  if (!due.length) return { attempted: 0, notified_threads: 0, skipped: candidates.length };

  const subs = await listPushSubscriptions(env, userId);
  if (!subs.length) return { attempted: 0, notified_threads: 0, skipped: due.length };

  let attempted = 0;
  for (const sub of subs) {
    const r = await sendPush(env, sub);
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
