import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "./env";
import type { UserRow, AccountRow } from "./db";
import { now } from "./db";

const PBKDF2_ITER = 100_000;
const SESSION_COOKIE = "hey_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = fromB64(parts[2]);
  const expected = fromB64(parts[3]);
  const actual = await pbkdf2(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

function randomId(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSession(c: Context<AppEnv>, userId: string): Promise<string> {
  const id = randomId(32);
  const t = now();
  await c.env.DB.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, userId, t, t + SESSION_TTL_MS, c.req.header("user-agent") ?? null)
    .run();
  const secure = new URL(c.req.url).protocol === "https:";
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return id;
}

export async function destroySession(c: Context<AppEnv>) {
  const id = getSessionId(c);
  if (id) await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

function getSessionId(c: Context<AppEnv>): string | null {
  const auth = c.req.header("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const tok = auth.slice(7).trim();
    // API tokens (hf_…) are for /mcp only — never treat them as session ids.
    if (tok && !tok.startsWith("hf_")) return tok;
  }
  return getCookie(c, SESSION_COOKIE) ?? null;
}

export async function getSessionUser(c: Context<AppEnv>): Promise<UserRow | null> {
  const id = getSessionId(c);
  if (!id) return null;
  const row = await c.env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`
  )
    .bind(id, now())
    .first<UserRow>();
  return row ?? null;
}

// ---------- Single-query auth: session + user + accounts in one round trip ----------
//
// `users` and `accounts` both have `id`, `email` and `created_at` columns, so `u.*, a.*` leaves those three
// keys ambiguous in the flat D1 row. Both sides are aliased (`u_*` / `a_*`) and every value is routed via
// its own alias, so the split below never depends on how D1 resolves duplicate keys. The LEFT JOIN fans
// out to one row per owned account, or a lone row with NULL account columns when the user has none.

type AuthRow = UserRow &
  Partial<AccountRow> & {
    u_id: string;
    u_email: string;
    u_created_at: number;
    a_id: string | null;
    a_email: string | null;
    a_created_at: number | null;
  };

/** Column names only `accounts` has (keep in sync with the schema: migrations/0001 + later ALTERs). */
const ACCOUNT_ONLY_KEYS = new Set([
  "user_id",
  "provider",
  "domain_id",
  "display_name",
  "access_token",
  "refresh_token",
  "token_expires_at",
  "history_id",
  "initial_sync_done",
  "initial_sync_page_token",
  "initial_sync_count",
  "sync_status",
  "sync_error",
  "last_synced_at",
  "signature",
  "cover_art",
  "avatar_url",
  "photos_synced_at",
  "contacts_changed_at",
  "scopes",
  "calendar_error",
  "gmail_watch_expiration",
  "gmail_watch_resource_id",
]);

/** Column names only `users` has (new users columns flow through automatically). */
const USER_ONLY_KEYS = new Set([
  "name",
  "password_hash",
  "role",
  "disabled",
  "settings_json",
  "last_login_at",
  "totp_secret",
  "totp_enabled",
  "recovery_codes_json",
]);

const AUTH_ALIASES = new Set(["u_id", "u_email", "u_created_at", "a_id", "a_email", "a_created_at"]);
/** Column names both tables have — routed via the aliases instead of the ambiguous bare key. */
const SHARED_KEYS = new Set(["id", "email", "created_at"]);

function splitAuthRow(row: AuthRow): { user: UserRow; account: AccountRow | null } {
  const user: Record<string, unknown> = {};
  const account: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (AUTH_ALIASES.has(key) || SHARED_KEYS.has(key)) continue;
    if (ACCOUNT_ONLY_KEYS.has(key)) account[key] = value;
    else user[key] = value;
  }
  user.id = row.u_id;
  user.email = row.u_email;
  user.created_at = row.u_created_at;
  if (row.a_id == null) return { user: user as unknown as UserRow, account: null };
  account.id = row.a_id;
  account.email = row.a_email;
  account.created_at = row.a_created_at;
  return { user: user as unknown as UserRow, account: account as unknown as AccountRow };
}

export interface SessionContext {
  user: UserRow;
  accounts: AccountRow[];
}

/**
 * Session → user plus every owned account, in a single D1 query. Used by `requireUser` so the per-request
 * auth cost is one round trip; `getSessionUser` above stays the lightweight path for anonymous requests.
 * Accounts come back ordered by `created_at ASC`, same as the old standalone accounts query.
 */
export async function getSessionUserWithAccounts(c: Context<AppEnv>): Promise<SessionContext | null> {
  const id = getSessionId(c);
  if (!id) return null;
  const rows = await c.env.DB.prepare(
    `SELECT u.*, a.*,
            u.id AS u_id, u.email AS u_email, u.created_at AS u_created_at,
            a.id AS a_id, a.email AS a_email, a.created_at AS a_created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN accounts a ON a.user_id = u.id
      WHERE s.id = ? AND s.expires_at > ?
      ORDER BY a.created_at ASC`
  )
    .bind(id, now())
    .all<AuthRow>();
  let user: UserRow | undefined;
  const accounts: AccountRow[] = [];
  for (const row of rows.results) {
    const split = splitAuthRow(row);
    user ??= split.user;
    if (split.account) accounts.push(split.account);
  }
  if (!user) return null;
  return { user, accounts };
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await getSessionUserWithAccounts(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  if (session.user.disabled) return c.json({ error: "account_disabled" }, 403);
  c.set("user", session.user);
  c.set("accounts", session.accounts);
  await next();
};


/**
 * Account scope. `X-Account-Id: <id>` (or `?account=<id>`) narrows to one account; `all` or absent is the
 * unified scope across every account the user owns. An id that doesn't belong to the user falls back to unified.
 */
export const requireAccount: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  const wanted = (c.req.header("x-account-id") || c.req.query("account") || "").trim();
  // Accounts were joined into the auth query and stashed by `requireUser` — no second query per request.
  // The fallback query only runs if this middleware is ever mounted without `requireUser` before it.
  let accounts = c.get("accounts");
  if (!accounts) {
    const all = await c.env.DB.prepare(`SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at ASC`).bind(user.id).all<AccountRow>();
    accounts = all.results;
  }
  if (!accounts.length) return c.json({ error: "no_account" }, 400);
  const specific = wanted && wanted !== "all" ? accounts.find((a) => a.id === wanted) ?? null : null;
  c.set("account", specific ?? accounts[0]);
  c.set("accountIds", specific ? [specific.id] : accounts.map((a) => a.id));
  c.set("allAccountIds", accounts.map((a) => a.id));
  await next();
};
