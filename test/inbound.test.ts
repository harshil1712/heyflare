import { describe, it, expect } from "vitest";
import { deliverInbound, parseInbound, resolveMailbox } from "../src/worker/inbound";
import { seedAccount, seedDomain, seedUser, testEnv } from "./helpers";

function rfc822(opts: { from: string; to: string; subject: string; body: string; messageId: string; date?: string }) {
  const date = opts.date ?? new Date().toUTCString();
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Message-ID: ${opts.messageId}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    opts.body,
  ].join("\r\n");
}

describe("inbound", () => {
  it("parses RFC822 and stores via deliverInbound", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: "inbox@mail.test", provider: "domain" });
    await seedDomain(user.id, "mail.test", { catchAllAccountId: account.id });

    const raw = rfc822({
      from: "Alice <alice@gmail.com>",
      to: "inbox@mail.test",
      subject: "Hello inbound",
      body: "This is the inbound body",
      messageId: "<inbound-1@gmail.com>",
    });
    const parsed = await parseInbound(raw, "alice@gmail.com", "inbox@mail.test");
    expect(parsed.from.email).toBe("alice@gmail.com");
    expect(parsed.subject).toBe("Hello inbound");
    expect(parsed.messageId).toBe("<inbound-1@gmail.com>");

    const r = await deliverInbound(env, account, parsed);
    expect(r.added).toBe(1);

    const msg = await env.DB.prepare(`SELECT subject, text_body FROM messages WHERE account_id = ?`).bind(account.id).first<{ subject: string; text_body: string }>();
    expect(msg?.subject).toBe("Hello inbound");
    expect(msg?.text_body).toContain("inbound body");
  });

  it("resolves catch-all domain mailboxes", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: "catch@example.com", provider: "domain" });
    await seedDomain(user.id, "example.com", { catchAllAccountId: account.id });

    const direct = await resolveMailbox(env.DB, "catch@example.com");
    expect(direct?.id).toBe(account.id);

    const viaCatchAll = await resolveMailbox(env.DB, "anything@example.com");
    expect(viaCatchAll?.id).toBe(account.id);

    const missing = await resolveMailbox(env.DB, "nobody@other.com");
    expect(missing).toBeNull();
  });

  it("dedupes on Message-ID", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: "inbox@mail.test", provider: "domain" });

    const raw = rfc822({
      from: "Bob <bob@gmail.com>",
      to: "inbox@mail.test",
      subject: "Once",
      body: "only once",
      messageId: "<dup-msg@gmail.com>",
    });
    const parsed = await parseInbound(raw, "bob@gmail.com", "inbox@mail.test");
    expect((await deliverInbound(env, account, parsed)).added).toBe(1);
    expect((await deliverInbound(env, account, parsed)).added).toBe(0);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE account_id = ?`).bind(account.id).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
