import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { createApiToken, toolAllowed, MCP_READ_TOOLS } from "../src/worker/api-tokens";
import { handleMcpJsonRpc } from "../src/worker/mcp";
import { ingestParsed } from "../src/worker/sync";
import { addr, makeParsed, seedAccount, seedUser, testEnv } from "./helpers";
import type { AuthTokenContext } from "../src/worker/api-tokens";

describe("MCP + API tokens", () => {
  it("requires bearer auth", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
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

    const listRes = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { result: { tools: { name: string }[] } };
    const names = listBody.result.tools.map((t) => t.name);
    expect(names).toContain("search_mail");
    expect(names).not.toContain("screen_sender");
    expect(names).not.toContain("create_draft");

    const searchRes = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search_mail", arguments: { query: "invoice" } },
      }),
    });
    const searchBody = (await searchRes.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(searchBody.result.isError).toBeFalsy();
    const parsed = JSON.parse(searchBody.result.content[0]!.text) as { results: unknown[] };
    expect(parsed.results.length).toBeGreaterThanOrEqual(1);
  });

  it("denies write tools on a read-only token", async () => {
    const env = testEnv();
    const user = await seedUser();
    await seedAccount(user.id);
    const { token, row } = await createApiToken(env, user.id, { scopes: "read" });
    expect(toolAllowed("read", "screen_sender")).toBe(false);
    expect(MCP_READ_TOOLS.has("search_mail")).toBe(true);

    const auth: AuthTokenContext = {
      user,
      accounts: [],
      scopes: "read",
      tokenId: row.id,
    };
    const denied = (await handleMcpJsonRpc(env, auth, {
      id: 3,
      method: "tools/call",
      params: { name: "screen_sender", arguments: { contact_id: "x", decision: "imbox" } },
    })) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0]!.text).toMatch(/tool_not_permitted/);

    const viaHttp = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "create_draft", arguments: { mode: "new", to: ["a@gmail.com"], subject: "x", body_text: "hi" } },
      }),
    });
    const body = (await viaHttp.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);
  });
});
