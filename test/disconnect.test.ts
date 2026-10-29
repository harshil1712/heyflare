import { describe, it, expect, vi, afterEach } from "vitest";
import { markDisconnected } from "../src/worker/google";
import { syncAccount } from "../src/worker/sync";
import { upsertPushSubscription } from "../src/worker/push";
import type { Env } from "../src/worker/env";
import { seedAccount, seedUser, testEnv } from "./helpers";

// Skip the JOSE layer: sendPush only needs something fetchable to count deliveries.
vi.mock("@block65/webcrypto-web-push", () => ({
  buildPushPayload: async () => ({}),
}));

const VAPID = {
  VAPID_PUBLIC_KEY: "test-public",
  VAPID_PRIVATE_KEY: "test-private",
};

function stubbedPushFetch(calls: string[]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input instanceof Request ? input.url : input);
    calls.push(url);
    return new Response("", { status: 201 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function pushEnv(): Env {
  return { ...testEnv(), ...VAPID } as Env;
}

async function seedSub(userId: string) {
  return upsertPushSubscription(pushEnv(), userId, {
    endpoint: `https://push.example/${crypto.randomUUID()}`,
    keys: { p256dh: "p256", auth: "auth" },
  });
}

describe("disconnect notification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("first transition pushes once per subscription; repeat calls push nothing", async () => {
    const env = pushEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: "gone@gmail.com" });
    await seedSub(user.id);
    await seedSub(user.id);

    const calls: string[] = [];
    const restore = stubbedPushFetch(calls);
    try {
      await markDisconnected(env, account, "Google revoked access (invalid_grant). Please reconnect.");
      expect(calls.filter((u) => u.startsWith("https://push.example/")).length).toBe(2);

      await markDisconnected(env, account, "again");
      expect(calls.filter((u) => u.startsWith("https://push.example/")).length).toBe(2);
    } finally {
      restore();
    }
    const row = await env.DB.prepare(`SELECT sync_status FROM accounts WHERE id = ?`).bind(account.id).first<{ sync_status: string }>();
    expect(row?.sync_status).toBe("disconnected");
  });

  it("the sync path notifies once even though both code paths mark the account", async () => {
    const env = pushEnv();
    const user = await seedUser();
    // No refresh token → syncAccount's early return marks it disconnected; a second markDisconnected
    // anywhere later is a no-op — one push total.
    const account = await seedAccount(user.id, { email: "gone@gmail.com" });
    await seedSub(user.id);

    const calls: string[] = [];
    const restore = stubbedPushFetch(calls);
    try {
      const r = await syncAccount(env, account);
      expect(r.status).toBe("disconnected");
    } finally {
      restore();
    }
    expect(calls.filter((u) => u.startsWith("https://push.example/")).length).toBe(1);
    const row = await env.DB.prepare(`SELECT sync_status FROM accounts WHERE id = ?`).bind(account.id).first<{ sync_status: string }>();
    expect(row?.sync_status).toBe("disconnected");
  });
});
