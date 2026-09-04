import { describe, it, expect } from "vitest";
import { runChatTurn, type ChatDeps, type SseEvent } from "../src/worker/ai/chat";
import { ingestParsed } from "../src/worker/sync";
import { addr, makeParsed, seedAccount, seedUser, testEnv } from "./helpers";

describe("runChatTurn + MockProvider", () => {
  it("runs the mock tool loop and persists content_json blocks", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id, { email: "me@gmail.com" });

    await ingestParsed(env, account, [
      makeParsed({
        gmailId: "inv-chat-1",
        threadId: "t-chat-inv",
        from: addr("jane@gmail.com", "Jane"),
        to: [addr(account.email)],
        subject: "Invoice attached",
        text: "Please find the invoice.",
      }),
    ]);

    const conversationId = crypto.randomUUID();
    const t = Date.now();
    await env.DB.prepare(`INSERT INTO ai_conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, '', ?, ?)`).bind(conversationId, user.id, t, t).run();

    const deps: ChatDeps = {
      env,
      user,
      accounts: [account],
      cfg: {
        provider: "mock",
        preset: "mock",
        baseUrl: "",
        apiKey: "",
        model: "mock-1",
        learn: false,
        autoSend: false,
      },
    };

    const events: SseEvent[] = [];
    await runChatTurn(deps, conversationId, "Find the invoice", async (e) => {
      events.push(e);
    });

    expect(events.some((e) => e.type === "tool" && e.name === "search_mail")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);

    const rows = await env.DB.prepare(`SELECT role, content_json FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC`)
      .bind(conversationId)
      .all<{ role: string; content_json: string }>();
    expect(rows.results.length).toBeGreaterThanOrEqual(3);

    const assistantWithTool = rows.results.find((r) => {
      if (r.role !== "assistant") return false;
      const blocks = JSON.parse(r.content_json) as { type: string; name?: string }[];
      return blocks.some((b) => b.type === "tool_use" && b.name === "search_mail");
    });
    expect(assistantWithTool).toBeTruthy();

    const toolResult = rows.results.find((r) => {
      if (r.role !== "user") return false;
      const blocks = JSON.parse(r.content_json) as { type: string }[];
      return blocks.some((b) => b.type === "tool_result");
    });
    expect(toolResult).toBeTruthy();
  });
});
