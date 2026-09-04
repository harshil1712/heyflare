import { describe, it, expect } from "vitest";
import { runTool, type ToolContext } from "../src/worker/ai/tools";
import { ingestParsed } from "../src/worker/sync";
import { addr, makeParsed, seedAccount, seedUser, testEnv } from "./helpers";

function ctx(user: { id: string; email: string; name: string }, accounts: ToolContext["accounts"], autoSend = false): ToolContext {
  return {
    env: testEnv(),
    user,
    accounts,
    autoSend,
    emit: () => {},
  };
}

describe("AI tools money path", () => {
  it("search_mail → read_thread → create_draft → send_draft blocked without autoSend", async () => {
    const env = testEnv();
    const user = await seedUser({ email: "owner@example.com" });
    const account = await seedAccount(user.id, { email: "me@gmail.com" });

    await ingestParsed(env, account, [
      makeParsed({
        gmailId: "inv-1",
        threadId: "t-inv",
        from: addr("jane@gmail.com", "Jane Cooper"),
        to: [addr(account.email)],
        subject: "Design review invoice",
        text: "Here is the invoice for the design review.",
        labelIds: ["INBOX", "UNREAD"],
      }),
    ]);

    const toolCtx = ctx({ id: user.id, email: user.email, name: user.name }, [account], false);

    const search = await runTool(toolCtx, "search_mail", { query: "invoice" });
    expect(search.isError).toBeFalsy();
    const searchBody = JSON.parse(search.result) as { results: { thread_id: string; subject: string }[] };
    expect(searchBody.results.length).toBeGreaterThanOrEqual(1);
    const threadId = searchBody.results[0].thread_id;
    expect(threadId).toBeTruthy();

    const read = await runTool(toolCtx, "read_thread", { thread_id: threadId });
    expect(read.isError).toBeFalsy();
    const readBody = JSON.parse(read.result) as { subject: string; messages: unknown[] };
    expect(readBody.subject).toMatch(/invoice/i);
    expect(readBody.messages.length).toBeGreaterThanOrEqual(1);

    const draft = await runTool(toolCtx, "create_draft", {
      mode: "reply",
      thread_id: threadId,
      body_text: "Thanks Jane — got the invoice.",
    });
    expect(draft.isError).toBeFalsy();
    const draftBody = JSON.parse(draft.result) as { draft_id: string };
    expect(draftBody.draft_id).toBeTruthy();

    const send = await runTool(toolCtx, "send_draft", { draft_id: draftBody.draft_id });
    expect(send.isError).toBeFalsy();
    const sendBody = JSON.parse(send.result) as { needs_confirmation?: boolean };
    expect(sendBody.needs_confirmation).toBe(true);

    const stillThere = await env.DB.prepare(`SELECT id FROM drafts WHERE id = ?`).bind(draftBody.draft_id).first();
    expect(stillThere).toBeTruthy();
  });

  it("scopes tools to the user's accounts only", async () => {
    const env = testEnv();
    const u1 = await seedUser({ email: "one@example.com" });
    const u2 = await seedUser({ email: "two@example.com" });
    const a1 = await seedAccount(u1.id, { email: "one@gmail.com" });
    const a2 = await seedAccount(u2.id, { email: "two@gmail.com" });

    const r = await ingestParsed(env, a2, [
      makeParsed({
        gmailId: "secret-1",
        threadId: "t-secret",
        from: addr("other@gmail.com"),
        to: [addr(a2.email)],
        subject: "Secret invoice",
        text: "private invoice for user two",
      }),
    ]);
    const foreignThreadId = r.threadIds[0];

    const toolCtx = ctx({ id: u1.id, email: u1.email, name: u1.name }, [a1], false);
    const search = await runTool(toolCtx, "search_mail", { query: "invoice" });
    const searchBody = JSON.parse(search.result) as { results: unknown[] };
    expect(searchBody.results).toHaveLength(0);

    const read = await runTool(toolCtx, "read_thread", { thread_id: foreignThreadId });
    expect(read.isError).toBe(true);
  });
});
