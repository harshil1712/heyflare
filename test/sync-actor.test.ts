import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { decodeGmailPush, handlePubSubPush, pubsubAuthorized } from "../src/worker/pubsub";
import { incrementalSync } from "../src/worker/sync";
import { seedAccount, seedUser, testEnv } from "./helpers";
import type { AccountRow } from "../src/worker/db";
import type { Env } from "../src/worker/env";

function workerEnv(): Env {
  return env as unknown as Env;
}

describe("Pub/Sub decode + auth", () => {
  it("decodes Gmail push data", () => {
    const data = btoa(JSON.stringify({ emailAddress: "Me@Gmail.com", historyId: 99 }));
    const r = decodeGmailPush({ message: { data } });
    expect(r).toEqual({ email: "me@gmail.com", historyId: "99" });
  });

  it("checks verification token", () => {
    const e = { ...testEnv(), PUBSUB_VERIFICATION_TOKEN: "secret-token" };
    const ok = new Request("http://localhost/pubsub/push?token=secret-token", { method: "POST" });
    const bad = new Request("http://localhost/pubsub/push?token=nope", { method: "POST" });
    expect(pubsubAuthorized(e, ok)).toBe(true);
    expect(pubsubAuthorized(e, bad)).toBe(false);
  });
});

describe("SyncActor coalesce", () => {
  it("double wake results in a single SyncActor run", async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: `sync-${crypto.randomUUID()}@gmail.com` });
    await testEnv()
      .DB.prepare(`UPDATE accounts SET initial_sync_done = 1, history_id = '1', refresh_token = 'rt', access_token = 'at', token_expires_at = ? WHERE id = ?`)
      .bind(Date.now() + 3600_000, account.id)
      .run();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(typeof input === "string" ? input : input instanceof Request ? input.url : input);
      if (url.includes("/history?")) return new Response(JSON.stringify({ historyId: "2", history: [] }), { status: 200 });
      if (url.includes("/profile")) return new Response(JSON.stringify({ historyId: "2" }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const stub = workerEnv().SYNC_ACTOR!.getByName(account.id);
      const [a, b] = await Promise.all([stub.wake("t1"), stub.wake("t2")]);
      expect([a.status, b.status].sort()).toEqual(["coalesced", "started"].sort());
      await stub.flush();
      expect(await stub.getRunCount()).toBe(1);

      const logs = await testEnv()
        .DB.prepare(`SELECT message FROM sync_log WHERE account_id = ? AND message LIKE 'SyncActor run%'`)
        .bind(account.id)
        .all<{ message: string }>();
      expect(logs.results.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it("cold wake refreshes the token cache after clearTokenCache", async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: `tok-${crypto.randomUUID()}@gmail.com` });
    await testEnv()
      .DB.prepare(`UPDATE accounts SET refresh_token = 'rt', access_token = 'cached-at', token_expires_at = ? WHERE id = ?`)
      .bind(Date.now() + 3600_000, account.id)
      .run();

    const stub = workerEnv().SYNC_ACTOR!.getByName(account.id);
    // First ensure populates cache from DB without force-refresh (token still valid).
    const first = await stub.ensureAccessToken(account.id);
    expect(first.token).toBe("cached-at");
    expect(first.refreshed).toBe(true);

    const second = await stub.ensureAccessToken(account.id);
    expect(second.refreshed).toBe(false);

    await stub.clearTokenCache();
    const third = await stub.ensureAccessToken(account.id);
    expect(third.refreshed).toBe(true);
    expect(third.token).toBe("cached-at");
  });
});

describe("invalid historyId recovery", () => {
  it("incrementalSync falls back when history returns 404", async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: `hist-${crypto.randomUUID()}@gmail.com` });
    await testEnv()
      .DB.prepare(
        `UPDATE accounts SET initial_sync_done = 1, history_id = 'expired', refresh_token = 'rt', access_token = 'at', token_expires_at = ? WHERE id = ?`
      )
      .bind(Date.now() + 3600_000, account.id)
      .run();

    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "new-at", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("/history?")) {
        return new Response("history not found", { status: 404 });
      }
      if (url.includes("/messages?maxResults")) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (url.includes("/profile")) {
        return new Response(JSON.stringify({ historyId: "fresh-hid" }), { status: 200 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const fresh = (await testEnv().DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(account.id).first<AccountRow>())!;
      const r = await incrementalSync(testEnv(), fresh);
      expect(r.added).toBe(0);
      const row = await testEnv().DB.prepare(`SELECT history_id FROM accounts WHERE id = ?`).bind(account.id).first<{ history_id: string }>();
      expect(row?.history_id).toBe("fresh-hid");
      expect(calls.some((u) => u.includes("/history?"))).toBe(true);
      expect(calls.some((u) => u.includes("/profile"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("handlePubSubPush", () => {
  it("wakes the matching account and ACKs unknown emails", async () => {
    const user = await seedUser();
    const email = `push-${crypto.randomUUID()}@gmail.com`;
    const account = await seedAccount(user.id, { email });
    await testEnv()
      .DB.prepare(`UPDATE accounts SET initial_sync_done = 1, history_id = '1', refresh_token = 'rt', access_token = 'at', token_expires_at = ? WHERE id = ?`)
      .bind(Date.now() + 3600_000, account.id)
      .run();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(typeof input === "string" ? input : input instanceof Request ? input.url : input);
      if (url.includes("/history?")) return new Response(JSON.stringify({ historyId: "2", history: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const data = btoa(JSON.stringify({ emailAddress: email, historyId: 42 }));
      const r = await handlePubSubPush(testEnv(), { message: { data } });
      expect(r.status).toBe("woke");
      if (workerEnv().SYNC_ACTOR) {
        await workerEnv().SYNC_ACTOR!.getByName(account.id).flush();
        expect(await workerEnv().SYNC_ACTOR!.getByName(account.id).getRunCount()).toBeGreaterThanOrEqual(1);
      }

      const miss = await handlePubSubPush(testEnv(), {
        message: { data: btoa(JSON.stringify({ emailAddress: "nobody@gmail.com", historyId: 1 })) },
      });
      expect(miss.status).toBe("unknown_email");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
