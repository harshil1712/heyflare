import { describe, it, expect } from "vitest";
import { assistantTools, type ToolContext } from "../src/worker/ai/tools";

const ctx: ToolContext = {
  env: {} as any,
  user: { id: "u", email: "a@b.c", name: "" },
  accounts: [],
  autoSend: false,
};

describe("assistant tools", () => {
  it("exposes mail tools as an AI SDK ToolSet", () => {
    const tools = assistantTools(ctx);
    expect(tools.search_mail).toBeDefined();
    expect(tools.create_draft).toBeDefined();
    expect(tools.list_memory).toBeDefined();
  });
});
