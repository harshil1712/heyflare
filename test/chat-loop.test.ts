import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { compactHistory, estimateChars, READ_ONLY_TOOLS, runToolBatch } from "../src/worker/ai/chat";
import type { ToolContext } from "../src/worker/ai/tools";
import { seedAccount, seedUser, testEnv } from "./helpers";

describe("agent loop helpers", () => {
  it("compacts long history while keeping the tail", () => {
    const messages: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(5000) });
    }
    expect(estimateChars(messages)).toBeGreaterThan(120_000);
    const compacted = compactHistory(messages, 50_000, 6);
    expect(compacted.length).toBe(7); // 1 summary + 6 tail
    expect(JSON.stringify(compacted[0]!.content)).toMatch(/compacted history/);
  });

  it("classifies write tools as non-parallel", () => {
    for (const w of ["create_draft", "send_draft", "screen_sender", "remember", "forget", "thread_action"]) {
      expect(READ_ONLY_TOOLS.has(w)).toBe(false);
    }
    for (const r of ["search_mail", "list_threads", "read_thread", "list_memory"]) {
      expect(READ_ONLY_TOOLS.has(r)).toBe(true);
    }
  });

  it("runToolBatch executes write tools without overlapping starts", async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const live: string[] = [];
    const maxLive = { n: 0 };
    const ctx: ToolContext = {
      env: testEnv(),
      user: { id: user.id, email: user.email, name: user.name },
      accounts: [account],
      autoSend: false,
      emit: () => {},
    };

    // Two write tools: if they ran in parallel, live would briefly be 2.
    const uses = [
      { type: "tool_use", id: "a", name: "remember", input: { kind: "fact", content: "one" } },
      { type: "tool_use", id: "b", name: "remember", input: { kind: "fact", content: "two" } },
    ] as Anthropic.ToolUseBlock[];

    const { runTool } = await import("../src/worker/ai/tools");
    // Wrap via a local batch that mirrors production scheduling using the real runToolBatch + tracked send.
    const trackedSend = async (e: { type: string; name?: string; status?: string }) => {
      if (e.type === "tool" && e.status === "running" && e.name === "remember") {
        live.push("remember");
        maxLive.n = Math.max(maxLive.n, live.length);
      }
      if (e.type === "tool" && e.status === "done" && e.name === "remember") {
        live.pop();
      }
    };

    // Slow down remember slightly by inserting delay in send running→done path is enough if serial.
    const results = await runToolBatch(ctx, uses, trackedSend as any);
    expect(results).toHaveLength(2);
    expect(maxLive.n).toBe(1);
    void runTool;
  });
});
