// Shared AI helpers: system prompt + one-shot reply/summarize (completeAi). Chat lives in Think (AssistantAgent).
import { z } from "zod";
import type { Env } from "../env";
import type { AccountRow, UserRow } from "../db";
import { listMemory, memoryText } from "./memory";
import { type AiConfig } from "./provider";
import { completeAi } from "./model";
import { htmlToText } from "../sanitize";

export { completeAi } from "./model";

export interface ChatDeps {
  env: Env;
  user: UserRow;
  accounts: AccountRow[];
  cfg: AiConfig;
}

export async function buildSystemPrompt(d: ChatDeps): Promise<string> {
  const memory = memoryText(await listMemory(d.env, d.user.id));
  const accounts = d.accounts.map((a) => `- ${a.email} (${a.provider === "gmail" ? "Gmail" : "domain mailbox"}, id ${a.id})`).join("\n") || "- none connected yet";
  return [
    `You are the assistant inside heyflare, a HEY-style email client. You help ${d.user.name || d.user.email} read, triage, organise, and write email.`,
    ``,
    `Connected accounts:`,
    accounts,
    ``,
    `What you remember about the user:`,
    memory,
    ``,
    `House rules:`,
    `- Use tools to look things up instead of guessing. Read a thread before summarising or replying to it.`,
    `- Draft mail with create_draft, written in the user's own voice (see memory: tone). ${d.cfg.autoSend ? "You may send with send_draft when the user clearly asked you to send." : "Never send: the user reviews every draft and presses Send themselves. Say that the draft is ready."}`,
    `- Screener decisions are reversible; act when asked, otherwise recommend.`,
    `- Be brief and concrete. Plain prose, short lists when listing mail. Refer to threads by subject and sender, never by id.`,
    `- When you learn something durable about the user (a preference, a fact, how they like to write), store it with remember. Don't store secrets or one-off details.`,
    `- Today is ${new Date().toISOString().slice(0, 10)} (UTC).`,
  ].join("\n");
}

const ReplySchema = z.object({
  subject: z.string().nullable().describe("Only if the subject should change; null otherwise"),
  body_text: z.string().describe("The reply text: greeting, body paragraphs separated by blank lines, sign-off. No subject line, no quoted history."),
});

export type ReplyTone = "match" | "formal" | "friendly" | "brief";

export async function generateReply(
  d: ChatDeps,
  threadText: string,
  brief: string,
  tone: ReplyTone,
  extra: { subject: string; to: string; myEmail: string }
): Promise<{ subject: string | null; body_text: string; body_html: string }> {
  const memory = memoryText(await listMemory(d.env, d.user.id));
  const toneLine =
    tone === "formal"
      ? "Write formally and precisely."
      : tone === "friendly"
        ? "Write warmly and casually."
        : tone === "brief"
          ? "Keep it to a few sentences."
          : "Match the user's own voice from the memory notes (greeting, sign-off, length, phrasing).";
  const res = await completeAi(d.env, d.cfg, {
    maxTokens: 4000,
    schema: { name: "email_reply", zod: ReplySchema },
    system: `You write email replies on behalf of ${d.user.name || d.user.email} (${extra.myEmail}). ${toneLine}\n\nWhat you know about them:\n${memory}\n\nRules: reply to the latest message, answer what was asked, don't invent facts or commitments the user didn't state, no placeholders like [name], no quoted history, sign off the way they usually do.`,
    messages: [
      {
        role: "user",
        content: `Thread (oldest first):\n${threadText}\n\nReplying to: ${extra.to}\nSubject: ${extra.subject}\n\nWhat the user wants to say: ${brief}`,
      },
    ],
  });
  if (res.refused) throw new Error("The model declined to write this reply.");
  const p = res.json ?? (res.text ? { subject: null, body_text: res.text } : null);
  if (!p) throw new Error("The model returned nothing usable.");
  return { subject: p.subject ?? null, body_text: p.body_text, body_html: textToHtml(p.body_text) };
}

export async function summarizeThread(d: ChatDeps, threadText: string, subject: string): Promise<string> {
  const res = await completeAi(d.env, d.cfg, {
    maxTokens: 1200,
    messages: [
      {
        role: "user",
        content: `Summarise this email thread for ${d.user.name || d.user.email}. Use 3–6 short bullet points: what it's about, decisions, open questions, and anything they need to do (with dates). Plain text bullets starting with "- ".\n\nSubject: ${subject}\n\n${threadText}`,
      },
    ],
  });
  if (res.refused) throw new Error("The model declined to summarise this thread.");
  return res.text.trim();
}

export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Render a thread as plain text for the model, newest last, bodies trimmed. */
export function threadToText(
  messages: { from: { name: string; email: string }; date: number; text_body: string; html_body: string; is_from_me: boolean }[],
  maxPer = 6000,
  maxMessages = 20
): string {
  const slice = messages.slice(Math.max(0, messages.length - maxMessages));
  return slice
    .map((m) => {
      let text = (m.text_body || htmlToText(m.html_body || "")).trim();
      if (text.length > maxPer) text = text.slice(0, maxPer) + " …[truncated]";
      return `From: ${m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email}${m.is_from_me ? " (the user)" : ""}\nDate: ${new Date(m.date).toISOString()}\n\n${text}`;
    })
    .join("\n\n-----\n\n");
}
