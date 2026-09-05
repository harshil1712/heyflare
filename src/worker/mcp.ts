// Stateless MCP (2026-07-28) via official createMcpHandler — Cloudflare Workers guidance.
// Dual-era: modern Streamable HTTP + legacy 2025 stateless fallback (SDK default).
// Auth stays heyflare API bearer tokens (Settings → Security); no OAuth/DO session.
import { z } from "zod";
import {
  McpServer,
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  localhostAllowedHostnames,
} from "@modelcontextprotocol/server";
import type { Env } from "./env";
import { TOOLS, runTool, type ToolContext } from "./ai/tools";
import { authenticateBearer, toolAllowed, type AuthTokenContext } from "./api-tokens";
import { loadAiConfig } from "./ai/provider";
import { VERSION } from "@shared/version";

function toolInputSchema(tool: (typeof TOOLS)[number]) {
  const props = (tool.input_schema as { properties?: Record<string, unknown> })?.properties ?? {};
  const shape: Record<string, z.ZodType> = {};
  for (const key of Object.keys(props)) {
    shape[key] = z.unknown().optional().nullable();
  }
  return Object.keys(shape).length ? z.object(shape).passthrough() : z.object({});
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

/** Fresh McpServer per request so tools close over the authenticated token scope. */
export async function createHeyflareMcpServer(env: Env, auth: AuthTokenContext): Promise<McpServer> {
  const server = new McpServer({ name: "heyflare", version: VERSION });
  const ctx = await toolContext(env, auth);

  for (const tool of TOOLS) {
    if (!toolAllowed(auth.scopes, tool.name)) continue;
    const name = tool.name;
    server.registerTool(
      name,
      {
        description: tool.description ?? name,
        inputSchema: toolInputSchema(tool),
      },
      async (args) => {
        const r = await runTool(ctx, name, args ?? {});
        return {
          content: [{ type: "text" as const, text: r.result }],
          isError: !!r.isError,
        };
      }
    );
  }
  return server;
}

function securityReject(env: Env, request: Request): Response | undefined {
  const host = new URL(request.url).hostname;
  const hosts = [...localhostAllowedHostnames(), host];
  if (env.APP_URL) {
    try {
      hosts.push(new URL(env.APP_URL).hostname);
    } catch {
      /* ignore */
    }
  }
  // Skip Host check when the header is absent (Vitest SELF.fetch); Workers always send Host.
  if (request.headers.get("host")) {
    const hostReject = hostHeaderValidationResponse(request, hosts);
    if (hostReject) return hostReject;
  }
  return originValidationResponse(request, hosts);
}

/**
 * Mount at `/mcp`. Uses MCP SDK v2 `createMcpHandler` (stateless 2026-07-28 +
 * 2025 legacy fallback). Bearer `hf_…` tokens from Settings → Security.
 */
export async function handleMcpRequest(env: Env, request: Request): Promise<Response> {
  const blocked = securityReject(env, request);
  if (blocked) return blocked;

  const raw = request.headers.get("authorization");
  const auth = await authenticateBearer(env, raw);
  if (!auth) {
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: { "www-authenticate": 'Bearer realm="heyflare-mcp"' } }
    );
  }

  const token = raw!.slice(7).trim();
  const handler = createMcpHandler(async () => createHeyflareMcpServer(env, auth), {
    // Default dual-era: modern 2026-07-28 + stateless 2025 clients (Claude Desktop, etc.).
    legacy: "stateless",
    // Tools-only: prefer a single JSON body (avoids SSE for list/call).
    responseMode: "json",
    onerror: (e) => console.error("mcp handler error", e),
  });

  return handler.fetch(request, {
    authInfo: {
      token,
      clientId: auth.tokenId,
      scopes: auth.scopes === "write" ? ["mcp:write"] : ["mcp:read"],
      extra: { userId: auth.user.id, scopes: auth.scopes },
    },
  });
}
