import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { SELF } from "cloudflare:test";
import { requireUser, requireAccount } from "../src/worker/auth";
import { seedUser, seedAccount, testEnv } from "./helpers";
import type { AccountRow } from "../src/worker/db";
import type { AppEnv } from "../src/worker/env";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function insertSession(userId: string, opts: { expiresAt?: number } = {}): Promise<string> {
  const id = crypto.randomUUID().replaceAll("-", "");
  const t = Date.now();
  await testEnv()
    .DB.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, NULL)`)
    .bind(id, userId, t, opts.expiresAt ?? t + SESSION_TTL_MS)
    .run();
  return id;
}

/** Two accounts with deterministic created_at order: first is accounts[0], second accounts[1]. */
async function seedTwoAccounts(userId: string): Promise<[AccountRow, AccountRow]> {
  const db = testEnv().DB;
  const a1 = await seedAccount(userId, { email: "first@gmail.com" });
  const a2 = await seedAccount(userId, { email: "second@gmail.com" });
  const t = Date.now();
  await db.prepare(`UPDATE accounts SET created_at = ? WHERE id = ?`).bind(t, a1.id).run();
  await db.prepare(`UPDATE accounts SET created_at = ? WHERE id = ?`).bind(t + 1000, a2.id).run();
  // Re-read so the returned rows carry the updated created_at.
  const first = (await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(a1.id).first<AccountRow>())!;
  const second = (await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(a2.id).first<AccountRow>())!;
  return [first, second];
}

/** Minimal app mounting the real middlewares, echoing the context values they set. */
function scopeApp() {
  const app = new Hono<AppEnv>();
  app.use("*", requireUser);
  app.use("*", requireAccount);
  app.get("/scope", (c) =>
    c.json({
      user: { id: c.get("user").id, email: c.get("user").email, created_at: c.get("user").created_at, password_hash: c.get("user").password_hash },
      account: c.get("account"),
      accountIds: c.get("accountIds"),
      allAccountIds: c.get("allAccountIds"),
    })
  );
  return app;
}

function get(app: ReturnType<typeof scopeApp>, path: string, headers: Record<string, string> = {}) {
  return app.request(`http://localhost${path}`, { headers }, testEnv());
}

describe("auth middleware: one query, unchanged scope semantics", () => {
  const app = scopeApp();

  it("absent X-Account-Id: unified scope, account = accounts[0]", async () => {
    const user = await seedUser();
    const [first, second] = await seedTwoAccounts(user.id);
    const sid = await insertSession(user.id);

    const res = await get(app, "/scope", { cookie: `hey_session=${sid}` });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    // The user row must come out of the join intact (not overwritten by account columns).
    expect(body.user.id).toBe(user.id);
    expect(body.user.email).toBe(user.email);
    expect(body.user.created_at).toBe(user.created_at);
    expect(body.user.password_hash).toBe(user.password_hash);
    expect(body.account).toEqual(first);
    expect(body.accountIds).toEqual([first.id, second.id]);
    expect(body.allAccountIds).toEqual([first.id, second.id]);
  });

  it("valid X-Account-Id: scoped to that account", async () => {
    const user = await seedUser();
    const [first, second] = await seedTwoAccounts(user.id);
    const sid = await insertSession(user.id);

    const res = await get(app, "/scope", { cookie: `hey_session=${sid}`, "x-account-id": second.id });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.account).toEqual(second);
    expect(body.accountIds).toEqual([second.id]);
    expect(body.allAccountIds).toEqual([first.id, second.id]);
  });

  it("?account= query param scopes like the header", async () => {
    const user = await seedUser();
    const [first, second] = await seedTwoAccounts(user.id);
    const sid = await insertSession(user.id);

    const res = await get(app, `/scope?account=${second.id}`, { cookie: `hey_session=${sid}` });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.account.id).toBe(second.id);
    expect(body.accountIds).toEqual([second.id]);
    expect(body.allAccountIds).toEqual([first.id, second.id]);
  });

  it("unknown X-Account-Id: falls back to accounts[0] with unified scope", async () => {
    const user = await seedUser();
    const [first, second] = await seedTwoAccounts(user.id);
    const sid = await insertSession(user.id);

    const res = await get(app, "/scope", { cookie: `hey_session=${sid}`, "x-account-id": "no-such-account" });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.account).toEqual(first);
    expect(body.accountIds).toEqual([first.id, second.id]);
    expect(body.allAccountIds).toEqual([first.id, second.id]);
  });

  it('X-Account-Id: "all" is the unified scope', async () => {
    const user = await seedUser();
    const [first, second] = await seedTwoAccounts(user.id);
    const sid = await insertSession(user.id);

    const res = await get(app, "/scope", { cookie: `hey_session=${sid}`, "x-account-id": "all" });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.account).toEqual(first);
    expect(body.accountIds).toEqual([first.id, second.id]);
    expect(body.allAccountIds).toEqual([first.id, second.id]);
  });

  it("user with no accounts gets 400 no_account", async () => {
    const user = await seedUser();
    const sid = await insertSession(user.id);

    const res = await get(app, "/scope", { cookie: `hey_session=${sid}` });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe("no_account");
  });

  it("expired session gets 401", async () => {
    const user = await seedUser();
    await seedTwoAccounts(user.id);
    const sid = await insertSession(user.id, { expiresAt: Date.now() - 1000 });

    const res = await get(app, "/scope", { cookie: `hey_session=${sid}` });
    expect(res.status).toBe(401);
    expect((await res.json<{ error: string }>()).error).toBe("unauthorized");
  });

  it("disabled user gets 403 account_disabled", async () => {
    const user = await seedUser();
    await seedTwoAccounts(user.id);
    const sid = await insertSession(user.id);
    await testEnv().DB.prepare(`UPDATE users SET disabled = 1 WHERE id = ?`).bind(user.id).run();

    const res = await get(app, "/scope", { cookie: `hey_session=${sid}` });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toBe("account_disabled");
  });

  it("hf_… API tokens are never treated as session ids", async () => {
    const user = await seedUser();
    await seedTwoAccounts(user.id);

    const res = await get(app, "/scope", { authorization: "Bearer hf_abc123" });
    expect(res.status).toBe(401);
  });

  it("non-hf Bearer token works as a session id", async () => {
    const user = await seedUser();
    const [first, second] = await seedTwoAccounts(user.id);
    const sid = await insertSession(user.id);

    const res = await get(app, "/scope", { authorization: `Bearer ${sid}` });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.account).toEqual(first);
    expect(body.accountIds).toEqual([first.id, second.id]);
  });

  it("end-to-end: real app /api/counts with a session cookie", async () => {
    const user = await seedUser();
    await seedTwoAccounts(user.id);
    const sid = await insertSession(user.id);

    const res = await SELF.fetch("http://localhost/api/counts", { headers: { cookie: `hey_session=${sid}` } });
    expect(res.status).toBe(200);
    const counts = await res.json<Record<string, unknown>>();
    expect(typeof counts.imbox_new).toBe("number");
    expect(counts.screener).toBe(0);
  });
});
