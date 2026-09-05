import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { createApiToken, toolAllowed, MCP_READ_TOOLS } from "../src/worker/api-tokens";
import { ingestParsed } from "../src/worker/sync";
import { addr, makeParsed, seedAccount, seedUser, testEnv } from "./helpers";

/** Parse MCP JSON or SSE (`event: message` / `data: …`) response bodies. */
async function mcpJson(res: Response): Promise<any> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("application/json") || text.trimStart().startsWith("{")) return JSON.parse(text);
  const dataLines = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  const last = dataLines[dataLines.length - 1];
  if (!last) throw new Error(`empty MCP body: ${text.slice(0, 200)}`);
  return JSON.parse(last);
}

/** Legacy (2025) JSON-RPC POST — createMcpHandler dual-era serves these without modern headers. */
function mcpPost(token: string, body: unknown) {
  return SELF.fetch("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe("MCP + API tokens (SDK v2)", () => {
  it("requires bearer auth", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("lists tools and runs search_mail for a read token", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id);
    await ingestParsed(env, account, [
      makeParsed({
        gmailId: "mcp-1",
        threadId: "t-mcp",
        from: addr("jane@gmail.com"),
        to: [addr(account.email)],
        subject: "Invoice MCP",
        text: "invoice body for mcp search",
      }),
    ]);
    const { token } = await createApiToken(env, user.id, { label: "test", scopes: "read" });

    const listRes = await mcpPost(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listRes.status).toBe(200);
    const listBody = (await mcpJson(listRes)) as { result: { tools: { name: string }[] } };
    const names = listBody.result.tools.map((t) => t.name);
    expect(names).toContain("search_mail");
    expect(names).not.toContain("screen_sender");
    expect(names).not.toContain("create_draft");

    const searchRes = await mcpPost(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_mail", arguments: { query: "invoice" } },
    });
    const searchBody = (await mcpJson(searchRes)) as {
      result?: { content: { text: string }[]; isError?: boolean };
      error?: unknown;
    };
    expect(searchBody.error).toBeUndefined();
    expect(searchBody.result?.isError).toBeFalsy();
    const parsed = JSON.parse(searchBody.result!.content[0]!.text) as { results: unknown[] };
    expect(parsed.results.length).toBeGreaterThanOrEqual(1);
  });

  it("denies write tools on a read-only token", async () => {
    const env = testEnv();
    const user = await seedUser();
    await seedAccount(user.id);
    const { token } = await createApiToken(env, user.id, { scopes: "read" });
    expect(toolAllowed("read", "screen_sender")).toBe(false);
    expect(MCP_READ_TOOLS.has("search_mail")).toBe(true);

    const viaHttp = await mcpPost(token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "create_draft",
        arguments: { mode: "new", to: ["a@gmail.com"], subject: "x", body_text: "hi" },
      },
    });
    const body = (await mcpJson(viaHttp)) as { result?: { isError?: boolean }; error?: { message?: string } };
    expect(body.result?.isError === true || !!body.error).toBe(true);
  });
});
