import { env } from "cloudflare:workers";
import type { Env } from "../src/worker/env";
import type { AccountRow, UserRow } from "../src/worker/db";
import { hashPassword } from "../src/worker/auth";
import type { ParsedMessage } from "../src/worker/mime";
import type { Address } from "../src/shared/types";

export function testEnv(): Env {
  return env as unknown as Env;
}

export function addr(email: string, name = ""): Address {
  return { email: email.toLowerCase(), name };
}

export function makeParsed(partial: Partial<ParsedMessage> & { gmailId: string; threadId: string }): ParsedMessage {
  const from = partial.from ?? addr("sender@gmail.com", "Sender");
  const to = partial.to ?? [addr("me@example.com")];
  const date = partial.date ?? Date.now();
  const subject = partial.subject ?? "Hello";
  const text = partial.text ?? "Body text";
  return {
    gmailId: partial.gmailId,
    threadId: partial.threadId,
    labelIds: partial.labelIds ?? ["INBOX", "UNREAD"],
    snippet: partial.snippet ?? text.slice(0, 120),
    internalDate: partial.internalDate ?? date,
    sizeEstimate: partial.sizeEstimate ?? 100,
    headers: partial.headers ?? {},
    from,
    to,
    cc: partial.cc ?? [],
    bcc: partial.bcc ?? [],
    replyTo: partial.replyTo ?? "",
    subject,
    date,
    messageId: partial.messageId ?? `<${partial.gmailId}@mail.gmail.com>`,
    inReplyTo: partial.inReplyTo ?? "",
    references: partial.references ?? "",
    listUnsubscribe: partial.listUnsubscribe ?? "",
    listId: partial.listId ?? "",
    precedence: partial.precedence ?? "",
    autoSubmitted: partial.autoSubmitted ?? "",
    text,
    html: partial.html ?? "",
    attachments: partial.attachments ?? [],
  };
}

export async function seedUser(opts: { email?: string; name?: string; password?: string } = {}): Promise<UserRow> {
  const db = testEnv().DB;
  const email = (opts.email ?? `owner-${crypto.randomUUID()}@example.com`).toLowerCase();
  const password = opts.password ?? "password123";
  const t = Date.now();
  const user: UserRow = {
    id: crypto.randomUUID(),
    email,
    name: opts.name ?? "Owner",
    password_hash: await hashPassword(password),
    role: "owner",
    disabled: 0,
    settings_json: "{}",
    created_at: t,
    last_login_at: t,
  };
  await db
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, role, disabled, settings_json, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, 0, '{}', ?, ?)`
    )
    .bind(user.id, user.email, user.name, user.password_hash, user.role, user.created_at, user.last_login_at)
    .run();
  return user;
}

export async function seedAccount(
  userId: string,
  opts: { email?: string; provider?: "gmail" | "domain"; domainId?: string | null; id?: string } = {}
): Promise<AccountRow> {
  const db = testEnv().DB;
  const t = Date.now();
  const id = opts.id ?? crypto.randomUUID();
  const email = (opts.email ?? `me-${crypto.randomUUID()}@gmail.com`).toLowerCase();
  const provider = opts.provider ?? "gmail";
  await db
    .prepare(
      `INSERT INTO accounts (id, user_id, provider, domain_id, email, display_name, access_token, refresh_token, token_expires_at, history_id, initial_sync_done, sync_status, signature, cover_art, created_at, scopes)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 1, 'idle', '', '', ?, '')`
    )
    .bind(id, userId, provider, opts.domainId ?? null, email, email.split("@")[0], t)
    .run();
  return (await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first<AccountRow>())!;
}

export async function seedScreenedContact(
  accountId: string,
  email: string,
  screenStatus: "imbox" | "feed" | "paper_trail" | "screened_out" | "pending" = "imbox",
  opts: { name?: string; bundled?: boolean } = {}
) {
  const db = testEnv().DB;
  const t = Date.now();
  await db
    .prepare(
      `INSERT INTO contacts (id, account_id, email, name, screen_status, screened_at, first_seen_at, last_seen_at, message_count, notes, avatar_url, bundled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?)`
    )
    .bind(crypto.randomUUID(), accountId, email.toLowerCase(), opts.name ?? "", screenStatus, t, t, t, opts.bundled ? 1 : 0)
    .run();
}

export async function seedDomain(
  userId: string,
  name: string,
  opts: { catchAllAccountId?: string | null } = {}
) {
  const db = testEnv().DB;
  const t = Date.now();
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO domains (id, user_id, name, zone_id, status, routing, sending, catch_all_account_id, error, dns_json, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'active', 'enabled', 'none', ?, NULL, '[]', ?, ?)`
    )
    .bind(id, userId, name.toLowerCase(), opts.catchAllAccountId ?? null, t, t)
    .run();
  return { id, name: name.toLowerCase() };
}
