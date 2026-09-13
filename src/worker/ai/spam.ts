// Domain-mailbox spam triage via Workers AI (Gemma 4). Gmail keeps its own SPAM filter.
import type { Env } from "../env";
import type { AccountRow, ContactRow } from "../db";
import { uid, now } from "../db";
import type { ParsedMessage } from "../mime";
import type { UserSettings } from "@shared/types";

export const SPAM_MODEL = "@cf/google/gemma-4-26b-a4b-it";

export type SpamVerdict = "spam" | "ham" | "unsure";

type Classifiable = Pick<ParsedMessage, "from" | "subject" | "snippet" | "text" | "listUnsubscribe" | "precedence">;

function parseSettings(raw: string | null | undefined): UserSettings {
  try {
    return raw ? (JSON.parse(raw) as UserSettings) : {};
  } catch {
    return {};
  }
}

/** Opt-in by default when the AI binding exists; set `aiSpamScreen: false` to disable. */
export function aiSpamScreenEnabled(settings: UserSettings): boolean {
  return settings.aiSpamScreen !== false;
}

function extractJson(text: string): { verdict?: string } | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/\{[\s\S]*\}/);
  if (!fence) return null;
  try {
    return JSON.parse(fence[0]) as { verdict?: string };
  } catch {
    return null;
  }
}

export function normalizeVerdict(raw: string | undefined | null): SpamVerdict {
  const v = (raw ?? "").toLowerCase().trim();
  if (v === "spam") return "spam";
  if (v === "ham" || v === "legit" || v === "ok") return "ham";
  return "unsure";
}

/** Ask Gemma 4; returns unsure on any failure so mail still reaches the Screener. */
export async function classifySpam(env: Env, msg: Classifiable): Promise<SpamVerdict> {
  if (!env.AI) return "unsure";
  const body = (msg.text || msg.snippet || "").replace(/\s+/g, " ").trim().slice(0, 500);
  const prompt = [
    "Classify this inbound email for a personal mailbox.",
    'Reply with ONLY JSON: {"verdict":"spam"|"ham"|"unsure"}',
    "- spam: unsolicited bulk, phishing, scams, malware lures, fake invoices",
    "- ham: real person or legitimate transactional mail the owner may want",
    "- unsure: not clear — prefer this over false spam",
    "",
    `From: ${msg.from.name ? `${msg.from.name} <${msg.from.email}>` : msg.from.email}`,
    `Subject: ${msg.subject || "(none)"}`,
    msg.listUnsubscribe ? "Has List-Unsubscribe: yes" : "Has List-Unsubscribe: no",
    msg.precedence ? `Precedence: ${msg.precedence}` : "",
    `Snippet: ${body || "(empty)"}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = (await env.AI.run(SPAM_MODEL, {
      messages: [
        { role: "system", content: "You are an email spam classifier. Output JSON only." },
        { role: "user", content: prompt },
      ],
      max_tokens: 40,
      temperature: 0,
    })) as { response?: string; result?: string } | string;

    const text = typeof res === "string" ? res : res.response ?? res.result ?? JSON.stringify(res);
    const parsed = extractJson(text);
    return normalizeVerdict(parsed?.verdict ?? text);
  } catch {
    return "unsure";
  }
}

/**
 * For custom-domain mailboxes: if Gemma 4 says spam and the sender is still pending,
 * mark them screened_out before ingest so the thread never hits the Screener.
 */
export async function maybeAutoScreenSpam(
  env: Env,
  account: AccountRow,
  msg: Classifiable
): Promise<SpamVerdict | "skipped"> {
  if (account.provider !== "domain") return "skipped";
  if (!env.AI) return "skipped";
  const from = msg.from.email?.toLowerCase().trim();
  if (!from) return "skipped";

  const user = await env.DB.prepare(`SELECT settings_json FROM users WHERE id = ?`).bind(account.user_id).first<{ settings_json: string }>();
  if (!user || !aiSpamScreenEnabled(parseSettings(user.settings_json))) return "skipped";

  const existing = await env.DB.prepare(`SELECT * FROM contacts WHERE account_id = ? AND email = ?`)
    .bind(account.id, from)
    .first<ContactRow>();
  if (existing && existing.screen_status !== "pending") return "skipped";

  const verdict = await classifySpam(env, msg);
  if (verdict !== "spam") return verdict;

  const t = now();
  if (existing) {
    await env.DB.prepare(`UPDATE contacts SET screen_status = 'screened_out', screened_at = ?, last_seen_at = ? WHERE id = ?`)
      .bind(t, t, existing.id)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO contacts (id, account_id, email, name, screen_status, screened_at, first_seen_at, last_seen_at, message_count, notes, avatar_url, bundled)
       VALUES (?, ?, ?, ?, 'screened_out', ?, ?, ?, 0, '', '', 0)`
    )
      .bind(uid(), account.id, from, msg.from.name || "", t, t, t)
      .run();
  }
  return "spam";
}
