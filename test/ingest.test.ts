import { describe, it, expect } from "vitest";
import { ingestParsed } from "../src/worker/sync";
import { addr, makeParsed, seedAccount, seedScreenedContact, seedUser, testEnv } from "./helpers";

describe("ingestParsed", () => {
  it("dedupes by gmailId and returns added: 0 on replay", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: "me@gmail.com" });
    const msg = makeParsed({
      gmailId: "gmail-1",
      threadId: "thread-1",
      from: addr("alice@gmail.com", "Alice"),
      to: [addr(account.email)],
      subject: "Invoice",
      text: "Please pay the invoice",
    });

    const first = await ingestParsed(env, account, [msg]);
    expect(first.added).toBe(1);
    expect(first.threadIds).toHaveLength(1);

    const second = await ingestParsed(env, account, [msg]);
    expect(second.added).toBe(0);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE account_id = ?`).bind(account.id).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("inherits screener decisions across accounts for the same user", async () => {
    const env = testEnv();
    const user = await seedUser();
    const a1 = await seedAccount(user.id, { email: "a1@gmail.com" });
    const a2 = await seedAccount(user.id, { email: "a2@gmail.com" });
    await seedScreenedContact(a1.id, "bob@gmail.com", "feed", { name: "Bob" });

    const r = await ingestParsed(env, a2, [
      makeParsed({
        gmailId: "g-bob-1",
        threadId: "t-bob-1",
        from: addr("bob@gmail.com", "Bob"),
        to: [addr(a2.email)],
        subject: "Cross-account",
        text: "hello from bob",
      }),
    ]);
    expect(r.added).toBe(1);

    const thread = await env.DB.prepare(`SELECT bucket FROM threads WHERE id = ?`).bind(r.threadIds[0]).first<{ bucket: string }>();
    expect(thread?.bucket).toBe("feed");

    const contact = await env.DB.prepare(`SELECT screen_status FROM contacts WHERE account_id = ? AND email = ?`)
      .bind(a2.id, "bob@gmail.com")
      .first<{ screen_status: string }>();
    expect(contact?.screen_status).toBe("feed");
  });

  it("puts mail from a bundled sender into an open bundle", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: "me@gmail.com" });
    await seedScreenedContact(account.id, "news@gmail.com", "imbox", { name: "News", bundled: true });

    const r = await ingestParsed(env, account, [
      makeParsed({
        gmailId: "g-bundle-1",
        threadId: "t-bundle-1",
        from: addr("news@gmail.com", "News"),
        to: [addr(account.email)],
        subject: "Daily digest",
        text: "bundled mail",
      }),
    ]);
    expect(r.added).toBe(1);

    const thread = await env.DB.prepare(`SELECT bundle_id, bucket FROM threads WHERE id = ?`).bind(r.threadIds[0]).first<{ bundle_id: string | null; bucket: string }>();
    expect(thread?.bucket).toBe("imbox");
    expect(thread?.bundle_id).toBeTruthy();

    const bundle = await env.DB.prepare(`SELECT status, email FROM bundles WHERE id = ?`).bind(thread!.bundle_id!).first<{ status: string; email: string }>();
    expect(bundle?.status).toBe("open");
    expect(bundle?.email).toBe("news@gmail.com");
  });
});
