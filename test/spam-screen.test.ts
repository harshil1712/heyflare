import { describe, it, expect, vi } from "vitest";
import { deliverInbound, parseInbound } from "../src/worker/inbound";
import { normalizeVerdict } from "../src/worker/ai/spam";
import { seedAccount, seedDomain, seedUser, testEnv } from "./helpers";

function rfc822(opts: { from: string; to: string; subject: string; body: string; messageId: string }) {
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Message-ID: ${opts.messageId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    opts.body,
  ].join("\r\n");
}

describe("spam verdict parsing", () => {
  it("normalizes model output", () => {
    expect(normalizeVerdict("spam")).toBe("spam");
    expect(normalizeVerdict("HAM")).toBe("ham");
    expect(normalizeVerdict("legit")).toBe("ham");
    expect(normalizeVerdict("maybe")).toBe("unsure");
  });
});

describe("AI spam screen on domain inbound", () => {
  it("screens out clear spam when Workers AI says spam", async () => {
    const env = testEnv();
    const user = await seedUser();
    await env.DB.prepare(`UPDATE users SET settings_json = ? WHERE id = ?`)
      .bind(JSON.stringify({ aiSpamScreen: true }), user.id)
      .run();
    const account = await seedAccount(user.id, { email: "inbox@mail.test", provider: "domain" });
    await seedDomain(user.id, "mail.test", { catchAllAccountId: account.id });

    (env as any).AI = {
      run: vi.fn(async () => ({ response: '{"verdict":"spam"}' })),
    };

    const raw = rfc822({
      from: "Winner <prize@scam.example>",
      to: "inbox@mail.test",
      subject: "You won $1,000,000 — claim now",
      body: "Click here to verify your bank details and claim your prize immediately.",
      messageId: "<spam-ai-1@scam.example>",
    });
    const parsed = await parseInbound(raw, "prize@scam.example", "inbox@mail.test");
    const r = await deliverInbound(env, account, parsed);
    expect(r.added).toBe(1);

    const contact = await env.DB.prepare(`SELECT screen_status FROM contacts WHERE account_id = ? AND email = ?`)
      .bind(account.id, "prize@scam.example")
      .first<{ screen_status: string }>();
    expect(contact?.screen_status).toBe("screened_out");

    const thread = await env.DB.prepare(`SELECT bucket FROM threads WHERE account_id = ?`)
      .bind(account.id)
      .first<{ bucket: string }>();
    expect(thread?.bucket).toBe("screened_out");
  });

  it("leaves unsure mail for the Screener", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: "inbox@mail.test", provider: "domain" });

    (env as any).AI = {
      run: vi.fn(async () => ({ response: '{"verdict":"unsure"}' })),
    };

    const raw = rfc822({
      from: "Sam <sam@example.com>",
      to: "inbox@mail.test",
      subject: "Quick question",
      body: "Are you free Thursday?",
      messageId: "<unsure-ai-1@example.com>",
    });
    const parsed = await parseInbound(raw, "sam@example.com", "inbox@mail.test");
    await deliverInbound(env, account, parsed);

    const thread = await env.DB.prepare(`SELECT bucket FROM threads WHERE account_id = ?`)
      .bind(account.id)
      .first<{ bucket: string }>();
    expect(thread?.bucket).toBe("screener");
  });

  it("respects aiSpamScreen: false", async () => {
    const env = testEnv();
    const user = await seedUser();
    await env.DB.prepare(`UPDATE users SET settings_json = ? WHERE id = ?`)
      .bind(JSON.stringify({ aiSpamScreen: false }), user.id)
      .run();
    const account = await seedAccount(user.id, { email: "inbox@mail.test", provider: "domain" });

    const run = vi.fn(async () => ({ response: '{"verdict":"spam"}' }));
    (env as any).AI = { run };

    const raw = rfc822({
      from: "Bot <bot@spam.example>",
      to: "inbox@mail.test",
      subject: "Buy now",
      body: "Cheap pills",
      messageId: "<off-ai-1@spam.example>",
    });
    const parsed = await parseInbound(raw, "bot@spam.example", "inbox@mail.test");
    await deliverInbound(env, account, parsed);
    expect(run).not.toHaveBeenCalled();

    const thread = await env.DB.prepare(`SELECT bucket FROM threads WHERE account_id = ?`)
      .bind(account.id)
      .first<{ bucket: string }>();
    expect(thread?.bucket).toBe("screener");
  });
});
