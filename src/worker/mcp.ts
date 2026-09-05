// Minimal Streamable HTTP MCP (JSON-RPC) over /mcp — reuses runTool.
import type { Env } from "./env";
import { TOOLS, runTool, type ToolContext } from "./ai/tools";
import { authenticateBearer, toolAllowed, MCP_READ_TOOLS, type AuthTokenContext } from "./api-tokens";
import { loadAiConfig } from "./ai/provider";

type JsonRpcId = string | number | null;
interface JsonRpcReq {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

function ok(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function err(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function mcpToolsFor(scopes: "read" | "write") {
  return TOOLS.filter((t) => toolAllowed(scopes, t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  }));
}

async function toolContext(env: Env, auth: AuthTokenContext): Promise<ToolContext> {
  const cfg = await loadAiConfig(env, auth.user.id);
  return {
    env,
    user: { id: auth.user.id, email: auth.user.email, name: auth.user.name },
    accounts: auth.accounts,
    autoSend: !!cfg?.autoSend && auth.scopes === "write",
    emit: () => {},
  };
}

export async function handleMcpJsonRpc(env: Env, auth: AuthTokenContext, body: JsonRpcReq): Promise<unknown> {
  const id = body.id ?? null;
  const method = body.method ?? "";
  const params = body.params ?? {};

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "heyflare", version: "0.3.0" },
      });
    case "notifications/initialized":
      return ok(id, {});
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: mcpToolsFor(auth.scopes) });
    case "tools/call": {
      const name = String((params as any).name ?? "");
      const args = ((params as any).arguments ?? {}) as Record<string, unknown>;
      if (!name) return err(id, -32602, "name required");
      if (!toolAllowed(auth.scopes, name)) {
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify({ error: "tool_not_permitted", tool: name, scope: auth.scopes }) }],
          isError: true,
        });
      }
      const ctx = await toolContext(env, auth);
      const r = await runTool(ctx, name, args);
      return ok(id, {
        content: [{ type: "text", text: r.result }],
        isError: !!r.isError,
      });
    }
    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcpRequest(env: Env, request: Request): Promise<Response> {
  if (request.method === "GET") {
    return Response.json({
      name: "heyflare",
      transport: "streamable-http",
      read_tools: [...MCP_READ_TOOLS],
      hint: "POST JSON-RPC with Authorization: Bearer hf_…",
    });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const auth = await authenticateBearer(env, request.headers.get("authorization"));
  if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as JsonRpcReq | JsonRpcReq[] | null;
  if (!body) return Response.json(err(null, -32700, "Parse error"), { status: 400 });

  if (Array.isArray(body)) {
    const results = [];
    for (const item of body) results.push(await handleMcpJsonRpc(env, auth, item));
    return Response.json(results);
  }
  return Response.json(await handleMcpJsonRpc(env, auth, body));
}

export { authenticateBearer };
