// Session lookup for Agents WebSocket / HTTP (cookie or Bearer), without Hono.
import type { Env } from "./env";
import type { UserRow } from "./db";
import { now } from "./db";

const SESSION_COOKIE = "hey_session";

function sessionIdFromRequest(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const tok = auth.slice(7).trim();
    if (tok && !tok.startsWith("hf_")) return tok;
  }
  const cookie = request.headers.get("cookie") ?? "";
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export async function userFromRequest(env: Env, request: Request): Promise<UserRow | null> {
  const id = sessionIdFromRequest(request);
  if (!id) return null;
  return (
    (await env.DB.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`)
      .bind(id, now())
      .first<UserRow>()) ?? null
  );
}
