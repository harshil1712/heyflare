// Per-account Durable Object: serializes sync triggers (push / cron / manual) and caches OAuth tokens in memory.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { AccountRow } from "./db";
import { logSync } from "./db";
import { syncAccount } from "./sync";
import { getAccessToken } from "./google";

export interface WakeResult {
  added: number;
  status: string;
  coalesced?: boolean;
  runs?: number;
}

export class SyncActor extends DurableObject<Env> {
  /** In-memory OAuth access token (lost on eviction — cold wake refreshes). */
  private cachedToken: string | null = null;
  private cachedTokenExpiresAt = 0;
  private debounceScheduled = false;
  private pending = false;
  private lastReason = "wake";
  private running = false;
  /** Observability: how many syncAccount calls this isolate has started. */
  private runCount = 0;

  /**
   * Enqueue a sync. Concurrent wakes within the debounce window collapse to one run
   * (push storms → a single SyncActor run in sync_log).
   */
  async wake(reason = "wake"): Promise<WakeResult> {
    this.pending = true;
    this.lastReason = reason;
    if (this.debounceScheduled || this.running) {
      return { added: 0, status: "coalesced", coalesced: true, runs: this.runCount };
    }
    this.debounceScheduled = true;
    this.ctx.waitUntil(this.debouncedRun());
    return { added: 0, status: "started", runs: this.runCount };
  }

  /** Block until idle (tests). */
  async flush(): Promise<{ runs: number }> {
    for (let i = 0; i < 200; i++) {
      if (!this.debounceScheduled && !this.running && !this.pending) return { runs: this.runCount };
      await new Promise((r) => setTimeout(r, 25));
    }
    return { runs: this.runCount };
  }

  async getRunCount(): Promise<number> {
    return this.runCount;
  }

  /** Simulate eviction: drop the in-memory token cache. */
  async clearTokenCache(): Promise<void> {
    this.cachedToken = null;
    this.cachedTokenExpiresAt = 0;
  }

  /**
   * Refresh + cache access token. Cold wake (empty cache) always hits getAccessToken.
   */
  async ensureAccessToken(accountId: string): Promise<{ token: string; refreshed: boolean }> {
    const now = Date.now();
    if (this.cachedToken && this.cachedTokenExpiresAt - now > 60_000) {
      return { token: this.cachedToken, refreshed: false };
    }
    const account = await this.env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountId).first<AccountRow>();
    if (!account) throw new Error("account_not_found");
    // Memory empty (cold wake / eviction): load via getAccessToken (DB token if still valid, else OAuth refresh).
    const token = await getAccessToken(this.env, account, false);
    this.cachedToken = token;
    this.cachedTokenExpiresAt = Math.max(account.token_expires_at ?? 0, now + 55 * 60_000);
    return { token, refreshed: true };
  }

  private async debouncedRun(): Promise<void> {
    await new Promise((r) => setTimeout(r, 50));
    this.debounceScheduled = false;
    if (!this.pending) return;
    this.pending = false;
    this.running = true;
    try {
      await this.runOnce(this.lastReason);
    } finally {
      this.running = false;
      // A wake that arrived during the run gets one follow-up (not an unbounded storm).
      if (this.pending && !this.debounceScheduled) {
        this.debounceScheduled = true;
        this.ctx.waitUntil(this.debouncedRun());
      }
    }
  }

  private async runOnce(reason: string): Promise<number> {
    const accountId = this.ctx.id.name;
    if (!accountId) return 0;
    const account = await this.env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountId).first<AccountRow>();
    if (!account) return 0;
    this.runCount += 1;
    await logSync(this.env.DB, account.id, "info", `SyncActor run (${reason})`);
    try {
      await this.ensureAccessToken(account.id);
    } catch (e) {
      await logSync(this.env.DB, account.id, "warn", `Token warm failed: ${(e as Error).message}`);
    }
    const fresh = (await this.env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(account.id).first<AccountRow>()) ?? account;
    const r = await syncAccount(this.env, fresh);
    if (r.status === "error") {
      const backoff = Math.min(30 * 60_000, 5_000 * Math.max(1, this.runCount));
      await this.ctx.storage.setAlarm(Date.now() + backoff);
    }
    return r.added;
  }

  async alarm(): Promise<void> {
    await this.wake("alarm-backoff");
  }
}

/** Wake the per-account SyncActor (falls back to direct syncAccount if binding missing). */
export async function wakeSyncActor(env: Env, accountId: string, reason: string): Promise<WakeResult> {
  if (!env.SYNC_ACTOR) {
    const account = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountId).first<AccountRow>();
    if (!account) return { added: 0, status: "missing" };
    const r = await syncAccount(env, account);
    return { added: r.added, status: r.status };
  }
  const stub = env.SYNC_ACTOR.getByName(accountId);
  return stub.wake(reason);
}
