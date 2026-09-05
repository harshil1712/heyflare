// API tokens for MCP bearer auth (SHA-256 hash at rest).
import type { Env } from "./env";
import type { AccountRow, UserRow } from "./db";
import { uid, now } from "./db";

export type TokenScope = "read" | "write";

export interface ApiTokenRow {
  id: string;
  user_id: string;
  label: string;
  token_hash: string;
  token_prefix: string;
  scopes: TokenScope;
  account_id: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export const MCP_READ_TOOLS = new Set([
  "search_mail",
  "list_threads",
  "read_thread",
  "list_screener",
  "find_contact",
  "list_memory",
]);

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `hf_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function createApiToken(
  env: Env,
  userId: string,
  opts: { label?: string; scopes?: TokenScope; accountId?: string | null } = {}
): Promise<{ token: string; row: ApiTokenRow }> {
  const raw = randomToken();
  const row: ApiTokenRow = {
    id: uid(),
    user_id: userId,
    label: (opts.label ?? "MCP").slice(0, 80),
    token_hash: await sha256Hex(raw),
    token_prefix: raw.slice(0, 10),
    scopes: opts.scopes === "write" ? "write" : "read",
    account_id: opts.accountId ?? null,
    created_at: now(),
    last_used_at: null,
    revoked_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO api_tokens (id, user_id, label, token_hash, token_prefix, scopes, account_id, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
  )
    .bind(row.id, row.user_id, row.label, row.token_hash, row.token_prefix, row.scopes, row.account_id, row.created_at)
    .run();
  return { token: raw, row };
}

export async function listApiTokens(env: Env, userId: string): Promise<Omit<ApiTokenRow, "token_hash">[]> {
  const r = await env.DB.prepare(
    `SELECT id, user_id, label, token_prefix, scopes, account_id, created_at, last_used_at, revoked_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`
  )
    .bind(userId)
    .all<Omit<ApiTokenRow, "token_hash">>();
  return r.results;
}

export async function revokeApiToken(env: Env, userId: string, id: string): Promise<boolean> {
  const r = await env.DB.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
    .bind(now(), id, userId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export interface AuthTokenContext {
  user: UserRow;
  accounts: AccountRow[];
  scopes: TokenScope;
  tokenId: string;
}

export async function authenticateBearer(env: Env, header: string | null): Promise<AuthTokenContext | null> {
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  const raw = header.slice(7).trim();
  if (!raw.startsWith("hf_")) return null;
  const hash = await sha256Hex(raw);
  const row = await env.DB.prepare(`SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL`).bind(hash).first<ApiTokenRow>();
  if (!row) return null;
  const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(row.user_id).first<UserRow>();
  if (!user || user.disabled) return null;
  let accounts: AccountRow[];
  if (row.account_id) {
    const one = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ? AND user_id = ?`).bind(row.account_id, user.id).first<AccountRow>();
    accounts = one ? [one] : [];
  } else {
    accounts = (await env.DB.prepare(`SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at ASC`).bind(user.id).all<AccountRow>()).results;
  }
  await env.DB.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`).bind(now(), row.id).run();
  return { user, accounts, scopes: row.scopes === "write" ? "write" : "read", tokenId: row.id };
}

export function toolAllowed(scopes: TokenScope, name: string): boolean {
  if (MCP_READ_TOOLS.has(name)) return true;
  return scopes === "write";
}
