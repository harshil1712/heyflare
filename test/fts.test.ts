import { describe, it, expect } from "vitest";
import { ingestParsed } from "../src/worker/sync";
import { searchThreads, shouldUseFts, toFtsMatch, backfillFts } from "../src/worker/fts";
import { splitStatements } from "../src/worker/migrations";
import { addr, makeParsed, seedAccount, seedUser, testEnv } from "./helpers";

describe("FTS5 search", () => {
  it("splitStatements keeps CREATE TRIGGER bodies intact", () => {
    const sql = `
-- comment
CREATE TABLE foo (id TEXT);
CREATE TRIGGER foo_ai AFTER INSERT ON foo BEGIN
  INSERT INTO bar(id) VALUES (new.id);
END;
CREATE TABLE baz (id TEXT);
`;
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(3);
    expect(stmts[1]).toMatch(/CREATE TRIGGER[\s\S]*END;/);
  });

  it("shouldUseFts requires ≥3 chars and a letter", () => {
    expect(shouldUseFts("ab")).toBe(false);
    expect(shouldUseFts("12345")).toBe(false);
    expect(shouldUseFts("invoice")).toBe(true);
    expect(toFtsMatch("invoice")).toBe('"invoice"');
    expect(toFtsMatch('say "hi"')).toBe('"say hi"'); // quotes stripped as operators
  });

  it("finds a word that only appears in text_body via FTS", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id);

    await ingestParsed(env, account, [
      makeParsed({
        gmailId: "fts-body-1",
        threadId: "t-fts-body",
        from: addr("alice@gmail.com", "Alice"),
        to: [addr(account.email)],
        subject: "Weekly notes",
        text: "Please review the xylophone-calibration report before Friday.",
        snippet: "Please review the…",
      }),
      makeParsed({
        gmailId: "fts-other-1",
        threadId: "t-fts-other",
        from: addr("bob@gmail.com", "Bob"),
        to: [addr(account.email)],
        subject: "Lunch plans",
        text: "Want tacos tomorrow?",
      }),
    ]);

    const { hits, mode } = await searchThreads(env.DB, [account.id], "xylophone", { limit: 10 });
    expect(mode).toBe("fts");
    expect(hits.length).toBe(1);
    expect(hits[0]!.thread.subject).toBe("Weekly notes");
  });

  it("ranks a subject match ahead of a weaker body match", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id);

    await ingestParsed(env, account, [
      makeParsed({
        gmailId: "rank-body",
        threadId: "t-rank-body",
        from: addr("a@gmail.com"),
        to: [addr(account.email)],
        subject: "Hello",
        snippet: "a short preview without the keyword",
        text: "mention of zebra once in passing deep in the body text only",
        date: Date.now() - 10_000,
      }),
      makeParsed({
        gmailId: "rank-subj",
        threadId: "t-rank-subj",
        from: addr("b@gmail.com"),
        to: [addr(account.email)],
        subject: "Zebra invoice",
        snippet: "Zebra invoice",
        text: "thanks",
        date: Date.now(),
      }),
    ]);

    const { hits, mode } = await searchThreads(env.DB, [account.id], "zebra", { limit: 10 });
    expect(mode).toBe("fts");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]!.thread.subject).toMatch(/Zebra/i);
    expect(hits[0]!.rank).toBeLessThanOrEqual(hits[1]!.rank);
  });

  it("falls back to LIKE for short queries", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id);

    await ingestParsed(env, account, [
      makeParsed({
        gmailId: "short-1",
        threadId: "t-short",
        from: addr("c@gmail.com"),
        to: [addr(account.email)],
        subject: "OK",
        text: "short subject mail",
      }),
    ]);

    const { hits, mode } = await searchThreads(env.DB, [account.id], "OK", { limit: 10 });
    expect(mode).toBe("like");
    expect(hits.some((h) => h.thread.subject === "OK")).toBe(true);
  });

  it("keeps FTS in sync via triggers on ingest and delete", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id);

    const r = await ingestParsed(env, account, [
      makeParsed({
        gmailId: "sync-1",
        threadId: "t-sync",
        from: addr("d@gmail.com"),
        to: [addr(account.email)],
        subject: "Sync me",
        text: "unique-quokka-token lives here",
      }),
    ]);
    expect(r.added).toBe(1);

    let found = await searchThreads(env.DB, [account.id], "quokka", { limit: 5 });
    expect(found.hits).toHaveLength(1);

    await env.DB.prepare(`DELETE FROM messages WHERE account_id = ?`).bind(account.id).run();
    await env.DB.prepare(`DELETE FROM threads WHERE account_id = ?`).bind(account.id).run();

    found = await searchThreads(env.DB, [account.id], "quokka", { limit: 5 });
    expect(found.hits).toHaveLength(0);
  });

  it("backfillFts indexes rows that predate triggers", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id);

    // Insert bypassing ingest (and thus still via triggers actually — so wipe FTS and re-backfill).
    await ingestParsed(env, account, [
      makeParsed({
        gmailId: "bf-1",
        threadId: "t-bf",
        from: addr("e@gmail.com"),
        to: [addr(account.email)],
        subject: "Backfill",
        text: "pangolin-recovery protocol",
      }),
    ]);
    await env.DB.prepare(`INSERT INTO threads_fts(threads_fts) VALUES('delete-all')`).run();
    await env.DB.prepare(`INSERT INTO messages_fts(messages_fts) VALUES('delete-all')`).run();

    let found = await searchThreads(env.DB, [account.id], "pangolin", { limit: 5 });
    expect(found.hits).toHaveLength(0);

    const n = await backfillFts(env.DB, 10);
    expect(n.threads).toBeGreaterThanOrEqual(1);
    expect(n.messages).toBeGreaterThanOrEqual(1);

    found = await searchThreads(env.DB, [account.id], "pangolin", { limit: 5 });
    expect(found.hits).toHaveLength(1);
  });
});
