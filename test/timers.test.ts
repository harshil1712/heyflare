import { describe, it, expect, vi, afterEach } from "vitest";
import { SELF, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { TimerWorkflow, scheduleTimer, type TimerParams } from "../src/worker/timers";
import { sendScheduledDraft } from "../src/worker/send";
import { fireBubbleUp } from "../src/worker/sync";
import { nextAlarmAt } from "../src/worker/sync-actor";
import { uid, now } from "../src/worker/db";
import { ingestParsed } from "../src/worker/sync";
import type { Env } from "../src/worker/env";
import type { AccountRow } from "../src/worker/db";
import { addr, makeParsed, seedAccount, seedUser, testEnv } from "./helpers";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function insertSession(userId: string): Promise<string> {
  const id = crypto.randomUUID().replaceAll("-", "");
  const t = Date.now();
  await testEnv()
    .DB.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, NULL)`)
    .bind(id, userId, t, t + SESSION_TTL_MS)
    .run();
  return id;
}

function stubTimers() {
  return { create: vi.fn(async () => ({})) } as unknown as Workflow<TimerParams>;
}

async function insertDraft(env: Env, accountId: string, sendAt: number | null, status = "scheduled") {
  const db = env.DB;
  const id = uid();
  const t = now();
  await db
    .prepare(
      `INSERT INTO drafts (id, account_id, thread_id, reply_to_message_id, to_json, cc_json, bcc_json, subject, body_html, send_at, status, error, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, ?, '[]', '[]', ?, ?, ?, ?, NULL, ?, ?)`
    )
    .bind(id, accountId, JSON.stringify([{ email: "jane@example.com", name: "" }]), "Timer draft", "<p>hi</p>", sendAt, status, t, t)
    .run();
  return id;
}

describe("event timers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (testEnv() as any).TIMERS;
  });

  it("sendScheduledDraft sends a due draft exactly once", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: "me@example.com", provider: "domain" });
    const send = vi.fn(async () => ({ messageId: "mid@example.com" }));
    const e2 = { ...env, EMAIL: { send } } as unknown as Env;

    const at = now() + 60_000;
    const draftId = await insertDraft(e2, account.id, at);

    // Wrong `at` → stale, draft untouched.
    expect(await sendScheduledDraft(e2, draftId, at + 1000)).toBe("stale");
    const untouched = await e2.DB.prepare(`SELECT status FROM drafts WHERE id = ?`).bind(draftId).first<{ status: string }>();
    expect(untouched?.status).toBe("scheduled");

    // Right `at` → sent, draft deleted.
    expect(await sendScheduledDraft(e2, draftId, at)).toBe("sent");
    const gone = await e2.DB.prepare(`SELECT id FROM drafts WHERE id = ?`).bind(draftId).first();
    expect(gone).toBeNull();

    // Second call is a no-op: claim guard prevents any double send.
    expect(await sendScheduledDraft(e2, draftId, at)).toBe("stale");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sendScheduledDraft leaves cancelled and failed sends alone", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: "me@example.com", provider: "domain" });
    const send = vi.fn(async () => {
      throw new Error("cloudflare_send_failed: refused");
    });
    const e2 = { ...env, EMAIL: { send } } as unknown as Env;

    const at = now() + 60_000;
    const cancelled = await insertDraft(e2, account.id, null, "draft");
    expect(await sendScheduledDraft(e2, cancelled, at)).toBe("stale");

    const draftId = await insertDraft(e2, account.id, at);
    expect(await sendScheduledDraft(e2, draftId, at)).toBe("failed");
    const row = await e2.DB.prepare(`SELECT status, error FROM drafts WHERE id = ?`).bind(draftId).first<{ status: string; error: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("refused");
  });

  it("fireBubbleUp only fires when the stored bubble_up_at matches", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const r = await ingestParsed(env, account, [
      makeParsed({ gmailId: "b1", threadId: "t-b1", from: addr("a@gmail.com"), to: [addr(account.email)], subject: "Later", text: "later" }),
    ]);
    const threadId = r.threadIds[0]!;
    const at = now() + 3600_000;
    await env.DB.prepare(`UPDATE threads SET bubble_up_at = ?, bubbled = 0, seen = 1, unread = 0 WHERE id = ?`).bind(at, threadId).run();

    // Stale timer (different at) → no-op.
    await fireBubbleUp(env.DB, threadId, at + 1000);
    let row = await env.DB.prepare(`SELECT bubbled, bubble_up_at, seen, unread FROM threads WHERE id = ?`).bind(threadId).first<any>();
    expect(row).toEqual({ bubbled: 0, bubble_up_at: at, seen: 1, unread: 0 });

    await fireBubbleUp(env.DB, threadId, at);
    row = await env.DB.prepare(`SELECT bubbled, bubble_up_at, seen, unread FROM threads WHERE id = ?`).bind(threadId).first<any>();
    expect(row).toEqual({ bubbled: 1, bubble_up_at: null, seen: 0, unread: 1 });
  });

  it("TimerWorkflow sleeps until `at` then fires the right action", async () => {
    // WorkflowEntrypoint's constructor wants a real ExecutionContext; run() only needs this.env.
    const wf = Object.create(TimerWorkflow.prototype) as TimerWorkflow;
    (wf as any).env = testEnv();
    const calls: unknown[] = [];
    const step = {
      sleepUntil: vi.fn(async (name: string, at: number) => calls.push([name, at])),
      do: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    } as unknown as WorkflowStep;
    const at = now() + 10_000;

    const res = await wf.run({ payload: { kind: "bubble_up", threadId: "no-such-thread", at } } as any, step);
    expect(step.sleepUntil).toHaveBeenCalledWith("wait", at);
    expect(step.do).toHaveBeenCalledTimes(1);
    void res;
  });

  it("scheduleTimer creates an instance, tolerates duplicates, rethrows real errors, no-ops without a binding", async () => {
    const env = testEnv();
    const timers = stubTimers();
    (env as any).TIMERS = timers;
    const p: TimerParams = { kind: "send", draftId: "d1", at: 123 };
    await scheduleTimer(env, p);
    expect(timers.create).toHaveBeenCalledWith({ id: "send-d1-123", params: p });

    timers.create = vi.fn(async () => {
      throw new Error('Workflow instance "send-d1-123" already exists');
    }) as any;
    await expect(scheduleTimer(env, p)).resolves.toBeUndefined();

    timers.create = vi.fn(async () => {
      throw new Error("backend exploded");
    }) as any;
    await expect(scheduleTimer(env, p)).rejects.toThrow("backend exploded");

    delete (env as any).TIMERS;
    await expect(scheduleTimer(env, p)).resolves.toBeUndefined();
  });

  it("POST /api/send with a future send_at schedules a workflow", async () => {
    const env = testEnv();
    const timers = stubTimers();
    (env as any).TIMERS = timers;
    const user = await seedUser();
    await seedAccount(user.id, { email: "me@example.com", provider: "domain" });
    const sid = await insertSession(user.id);

    const res = await SELF.fetch("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `hey_session=${sid}` },
      body: JSON.stringify({ to: ["jane@example.com"], subject: "Later", body_html: "<p>hi</p>", send_at: now() + 3600_000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ scheduled: boolean; send_at: number; draft_id: string }>();
    expect(body.scheduled).toBe(true);
    expect(timers.create).toHaveBeenCalledWith({ id: `send-${body.draft_id}-${body.send_at}`, params: { kind: "send", draftId: body.draft_id, at: body.send_at } });
  });

  it("bubble_up action schedules a workflow only when `at` is set", async () => {
    const env = testEnv();
    const timers = stubTimers();
    (env as any).TIMERS = timers;
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const sid = await insertSession(user.id);
    const r = await ingestParsed(env, account, [
      makeParsed({ gmailId: "bu-1", threadId: "t-bu1", from: addr("a@gmail.com"), to: [addr(account.email)], subject: "Snooze", text: "snooze" }),
    ]);
    const threadId = r.threadIds[0]!;
    const at = now() + 3600_000;

    const res = await SELF.fetch(`http://localhost/api/threads/${threadId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `hey_session=${sid}` },
      body: JSON.stringify({ action: "bubble_up", at }),
    });
    expect(res.status).toBe(200);
    expect(timers.create).toHaveBeenCalledWith({ id: `bubble_up-${threadId}-${at}`, params: { kind: "bubble_up", threadId, at } });

    timers.create.mockClear();
    const res2 = await SELF.fetch(`http://localhost/api/threads/${threadId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `hey_session=${sid}` },
      body: JSON.stringify({ action: "bubble_up", at: null }),
    });
    expect(res2.status).toBe(200);
    expect(timers.create).not.toHaveBeenCalled();
  });
});

describe("SyncActor alarm multiplexing", () => {
  it("nextAlarmAt returns the earliest defined time or null", () => {
    expect(nextAlarmAt()).toBeNull();
    expect(nextAlarmAt(undefined, undefined)).toBeNull();
    expect(nextAlarmAt(100, 50)).toBe(50);
    expect(nextAlarmAt(100)).toBe(100);
    expect(nextAlarmAt(undefined, 50)).toBe(50);
  });

  it("setWatchRenewal arms the DO alarm at the earlier of backoff / renewal", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const stub = env.SYNC_ACTOR!.getByName(account.id);

    const renew = now() + 24 * 3600_000;
    await runInDurableObject(stub, async (instance) => {
      await instance.setWatchRenewal(renew);
      expect(await instance.ctx.storage.getAlarm()).toBe(renew);
      // A nearer backoff wins.
      await instance.ctx.storage.put("backoffAt", renew - 1000);
      await instance.alarm();
      expect(await instance.ctx.storage.getAlarm()).toBe(renew - 1000);
    });
  });

  it("alarm() with a due watchRenewAt clears the key (renew not-ok without a topic)", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const stub = env.SYNC_ACTOR!.getByName(account.id);

    await runInDurableObject(stub, async (instance) => {
      await instance.setWatchRenewal(now() - 1000); // already due
      expect(await instance.ctx.storage.getAlarm()).toBeLessThanOrEqual(now());
    });
    // GMAIL_PUBSUB_TOPIC is unset in tests → renewGmailWatch returns not-ok; key just clears.
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance) => {
      expect(await instance.ctx.storage.get<number>("watchRenewAt")).toBeUndefined();
    });
  });
});

describe("counts stale-account wake", () => {
  async function waitForRunCount(accountId: string, n: number, timeoutMs = 3000): Promise<boolean> {
    const stub = testEnv().SYNC_ACTOR!.getByName(accountId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await stub.getRunCount()) >= n) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it("GET /api/counts wakes a stale idle Gmail account, not a fresh or foreign one", async () => {
    const env = testEnv();
    const user = await seedUser();
    const stale = await seedAccount(user.id, { email: "stale@gmail.com" });
    const fresh = await seedAccount(user.id, { email: "fresh@gmail.com" });
    const otherUser = await seedUser();
    const foreign = await seedAccount(otherUser.id, { email: "other@gmail.com" });

    // Stale: refresh token present, idle, initial sync done, quiet > 15 min.
    await env.DB.prepare(`UPDATE accounts SET refresh_token = 'x', last_synced_at = ? WHERE id = ?`).bind(now() - 60 * 60_000, stale.id).run();
    // Fresh: synced a minute ago.
    await env.DB.prepare(`UPDATE accounts SET refresh_token = 'x', last_synced_at = ? WHERE id = ?`).bind(now() - 60_000, fresh.id).run();
    // Foreign: stale but another user's.
    await env.DB.prepare(`UPDATE accounts SET refresh_token = 'x', last_synced_at = ? WHERE id = ?`).bind(now() - 60 * 60_000, foreign.id).run();

    const sid = await insertSession(user.id);
    const res = await SELF.fetch("http://localhost/api/counts", { headers: { cookie: `hey_session=${sid}` } });
    expect(res.status).toBe(200);

    expect(await waitForRunCount(stale.id, 1)).toBe(true);
    expect(await env.SYNC_ACTOR!.getByName(fresh.id).getRunCount()).toBe(0);
    expect(await env.SYNC_ACTOR!.getByName(foreign.id).getRunCount()).toBe(0);
  });
});
