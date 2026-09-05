import { Hono } from "hono";
import type { AppEnv } from "../env";
import { createApiToken, listApiTokens, revokeApiToken } from "../api-tokens";

const tokens = new Hono<AppEnv>();

tokens.get("/", async (c) => {
  const user = c.get("user");
  const rows = await listApiTokens(c.env, user.id);
  return c.json({
    tokens: rows.map((t) => ({
      id: t.id,
      label: t.label,
      token_prefix: t.token_prefix,
      scopes: t.scopes,
      account_id: t.account_id,
      created_at: t.created_at,
      last_used_at: t.last_used_at,
      revoked: !!t.revoked_at,
    })),
  });
});

tokens.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ label?: string; scopes?: "read" | "write"; account_id?: string | null }>().catch(() => ({}) as any);
  if (body.scopes === "write" && body.account_id) {
    const own = await c.env.DB.prepare(`SELECT id FROM accounts WHERE id = ? AND user_id = ?`).bind(body.account_id, user.id).first();
    if (!own) return c.json({ error: "account_not_found" }, 400);
  }
  if (body.account_id) {
    const own = await c.env.DB.prepare(`SELECT id FROM accounts WHERE id = ? AND user_id = ?`).bind(body.account_id, user.id).first();
    if (!own) return c.json({ error: "account_not_found" }, 400);
  }
  const { token, row } = await createApiToken(c.env, user.id, {
    label: body.label,
    scopes: body.scopes,
    accountId: body.account_id ?? null,
  });
  return c.json({
    token, // shown once
    id: row.id,
    label: row.label,
    token_prefix: row.token_prefix,
    scopes: row.scopes,
    account_id: row.account_id,
    created_at: row.created_at,
  });
});

tokens.delete("/:id", async (c) => {
  const user = c.get("user");
  const ok = await revokeApiToken(c.env, user.id, c.req.param("id"));
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

export default tokens;
