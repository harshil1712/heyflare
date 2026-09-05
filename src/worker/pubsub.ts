// Gmail users.watch + Pub/Sub push decoding.
import type { Env } from "./env";
import type { AccountRow } from "./db";
import { logSync, now } from "./db";
import { gmailPost, hasMailScope } from "./google";
import { wakeSyncActor } from "./sync-actor";

export interface PubSubPushBody {
  message?: { data?: string; messageId?: string; publishTime?: string };
  subscription?: string;
}

export interface GmailPushData {
  emailAddress?: string;
  historyId?: number | string;
}

/** Decode the Gmail Pub/Sub push envelope → { email, historyId }. */
export function decodeGmailPush(body: PubSubPushBody): { email: string; historyId: string } | null {
  const raw = body.message?.data;
  if (!raw) return null;
  try {
    const json = JSON.parse(atob(raw)) as GmailPushData;
    const email = (json.emailAddress ?? "").toLowerCase().trim();
    const historyId = json.historyId != null ? String(json.historyId) : "";
    if (!email) return null;
    return { email, historyId };
  } catch {
    return null;
  }
}

export function pubsubAuthorized(env: Env, request: Request): boolean {
  const expected = env.PUBSUB_VERIFICATION_TOKEN;
  if (!expected) return false;
  const url = new URL(request.url);
  const q = url.searchParams.get("token");
  if (q && q === expected) return true;
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ") && auth.slice(7).trim() === expected) return true;
  return false;
}

/** Start or renew Gmail users.watch for push notifications. No-op when topic not configured. */
export async function ensureGmailWatch(env: Env, account: AccountRow): Promise<{ ok: boolean; expiration?: number; error?: string }> {
  const topic = env.GMAIL_PUBSUB_TOPIC;
  if (!topic || account.provider !== "gmail" || !hasMailScope(account.scopes)) {
    return { ok: false, error: "watch_unconfigured" };
  }
  try {
    const res = await gmailPost<{ historyId?: string; expiration?: string }>(env, account, "watch", {
      topicName: topic,
      labelIds: ["INBOX"],
    });
    const expiration = res.expiration ? parseInt(res.expiration, 10) : now() + 6 * 24 * 3600_000;
    await env.DB.prepare(`UPDATE accounts SET gmail_watch_expiration = ?, gmail_watch_resource_id = ?, history_id = COALESCE(?, history_id) WHERE id = ?`)
      .bind(expiration, topic, res.historyId ?? null, account.id)
      .run();
    await logSync(env.DB, account.id, "info", `Gmail watch renewed until ${new Date(expiration).toISOString()}`);
    return { ok: true, expiration };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    await logSync(env.DB, account.id, "warn", `Gmail watch failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

/** Cron sweeper: renew watches expiring within 24h; wake stale accounts that may have missed pushes. */
export async function sweepGmailWatches(env: Env): Promise<{ renewed: number; woke: number }> {
  const db = env.DB;
  const t = now();
  let renewed = 0;
  let woke = 0;
  if (env.GMAIL_PUBSUB_TOPIC) {
    const due = await db
      .prepare(
        `SELECT * FROM accounts WHERE provider = 'gmail' AND refresh_token IS NOT NULL AND sync_status <> 'disconnected'
         AND (gmail_watch_expiration IS NULL OR gmail_watch_expiration < ?) LIMIT 20`
      )
      .bind(t + 24 * 3600_000)
      .all<AccountRow>();
    for (const acc of due.results) {
      if (!hasMailScope(acc.scopes)) continue;
      const r = await ensureGmailWatch(env, acc);
      if (r.ok) renewed++;
    }
  }
  // Missed-push catch-up: accounts quiet for >15 min get a gentle wake (not the primary path).
  const stale = await db
    .prepare(
      `SELECT id FROM accounts WHERE provider = 'gmail' AND refresh_token IS NOT NULL AND sync_status = 'idle'
       AND initial_sync_done = 1 AND COALESCE(last_synced_at, 0) < ? LIMIT 5`
    )
    .bind(t - 15 * 60_000)
    .all<{ id: string }>();
  for (const row of stale.results) {
    await wakeSyncActor(env, row.id, "cron-sweep");
    woke++;
  }
  return { renewed, woke };
}

/** Handle an authorized Pub/Sub push: map email → account, wake SyncActor. */
export async function handlePubSubPush(env: Env, body: PubSubPushBody): Promise<{ ok: boolean; status: string }> {
  const decoded = decodeGmailPush(body);
  if (!decoded) return { ok: false, status: "bad_payload" };
  const account = await env.DB.prepare(`SELECT * FROM accounts WHERE provider = 'gmail' AND email = ? LIMIT 1`)
    .bind(decoded.email)
    .first<AccountRow>();
  if (!account) return { ok: true, status: "unknown_email" }; // ACK so Pub/Sub doesn't retry forever
  await wakeSyncActor(env, account.id, "pubsub");
  return { ok: true, status: "woke" };
}
