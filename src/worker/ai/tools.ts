// Tools the assistant can call. Every tool is scoped to the signed-in user's accounts.
import { searchThreads } from "../fts";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import type { AccountRow, ContactRow, ThreadRow, MessageRow } from "../db";
import { uid, now, inClause, ownedRow, accountForThread, threadsWithLabels, attachAvatars, toContact, safeJson } from "../db";
import { loadThreadDetail, applyAction, type ActionBody, type MailOps } from "../routes/mail";
import { applyScreenDecision } from "../routes/screener";
import { sendMail } from "../send";
import { htmlToText } from "../sanitize";
import { addMemory, deleteMemory, listMemory, type MemoryKind } from "./memory";
import { textToHtml } from "./chat";
import type { Address, ThreadSummary } from "@shared/types";

export interface ToolContext {
  env: Env;
  user: { id: string; email: string; name: string };
  accounts: AccountRow[];
  autoSend: boolean;
  waitUntil?: (p: Promise<unknown>) => void;
}

function mailOps(ctx: ToolContext): MailOps {
  return {
    env: ctx.env,
    userId: ctx.user.id,
    accountIds: ctx.accounts.map((a) => a.id),
    waitUntil: ctx.waitUntil,
  };
}

const BUCKETS = ["imbox", "feed", "paper_trail", "screener", "screened_out", "trash", "reply_later", "set_aside", "bubble_up", "sent", "everything", "previously_seen"] as const;
const MAX_BODY = 6000;
const MAX_MESSAGES = 20;

async function result(ctx: ToolContext, name: string, input: unknown) {
  try {
    return (await runTool(ctx, name, input)).result;
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}

/** AI SDK tools for Think (`getTools`) and MCP. */
export function assistantTools(ctx: ToolContext): ToolSet {
  return {
    search_mail: tool({
      description: "Full-text search across the user's mail (subjects, senders, bodies, notes). Returns thread summaries.",
      inputSchema: z.object({
        query: z.string().describe("Search words"),
        limit: z.number().int().nullable().optional().describe("Max results (default 10, max 25)"),
      }),
      execute: async (input) => result(ctx, "search_mail", input),
    }),
    list_threads: tool({
      description: "List threads in a box. Buckets: imbox (new + previously seen), feed, paper_trail, screener, screened_out, trash, reply_later, set_aside, bubble_up, sent, everything, previously_seen.",
      inputSchema: z.object({
        bucket: z.enum(BUCKETS),
        limit: z.number().int().nullable().optional().describe("Max results (default 15, max 40)"),
        only_new: z.boolean().nullable().optional().describe("imbox only: return just the 'New for you' threads"),
      }),
      execute: async (input) => result(ctx, "list_threads", input),
    }),
    read_thread: tool({
      description: "Read a thread: participants and messages with plain-text bodies (trimmed). Use before summarising or replying.",
      inputSchema: z.object({
        thread_id: z.string().describe("Thread id"),
        max_messages: z.number().int().nullable().optional().describe("Max messages to return, newest first (default 20)"),
      }),
      execute: async (input) => result(ctx, "read_thread", input),
    }),
    list_screener: tool({
      description: "Senders waiting in the Screener with what they sent.",
      inputSchema: z.object({}),
      execute: async (input) => result(ctx, "list_screener", input),
    }),
    screen_sender: tool({
      description: "Decide a Screener sender: let them into imbox / feed / paper_trail, or screen them out. Reversible later.",
      inputSchema: z.object({
        contact_id: z.string().describe("Contact id from list_screener or find_contact"),
        decision: z.enum(["imbox", "feed", "paper_trail", "screened_out"]),
      }),
      execute: async (input) => result(ctx, "screen_sender", input),
    }),
    thread_action: tool({
      description:
        "Organise a thread. actions: reply_later, set_aside (toggle on/off with `on`), bubble_up (needs `at` epoch ms; null cancels), move (needs `bucket`: imbox|feed|paper_trail|trash), mark_read, mark_unread, label_add / label_remove (needs `label_id`), bundle (toggle sender bundling with `on`), unsubscribe_info (returns the unsubscribe link for newsletters).",
      inputSchema: z.object({
        thread_id: z.string().describe("Thread id"),
        action: z.enum(["reply_later", "set_aside", "bubble_up", "move", "mark_read", "mark_unread", "label_add", "label_remove", "bundle", "unsubscribe_info"]),
        on: z.boolean().nullable().optional().describe("For reply_later / set_aside / bundle (default true)"),
        bucket: z.enum(["imbox", "feed", "paper_trail", "trash"]).nullable().optional().describe("For move"),
        at: z.number().int().nullable().optional().describe("For bubble_up: epoch milliseconds when it should come back"),
        label_id: z.string().nullable().optional().describe("For label_add / label_remove"),
      }),
      execute: async (input) => result(ctx, "thread_action", input),
    }),
    list_labels: tool({
      description: "The user's labels (id, name).",
      inputSchema: z.object({}),
      execute: async (input) => result(ctx, "list_labels", input),
    }),
    list_collections: tool({
      description: "The user's collections (id, name, thread count).",
      inputSchema: z.object({}),
      execute: async (input) => result(ctx, "list_collections", input),
    }),
    create_collection: tool({
      description: "Create a collection (a named bundle of related threads).",
      inputSchema: z.object({
        name: z.string().describe("Collection name"),
        description: z.string().nullable().optional().describe("Optional one-line description"),
      }),
      execute: async (input) => result(ctx, "create_collection", input),
    }),
    add_to_collection: tool({
      description: "Add a thread to a collection.",
      inputSchema: z.object({
        thread_id: z.string().describe("Thread id"),
        collection_id: z.string().describe("Collection id"),
      }),
      execute: async (input) => result(ctx, "add_to_collection", input),
    }),
    save_clip: tool({
      description: "Save a short piece of text from a thread (a code, address, sentence) to the user's Clips.",
      inputSchema: z.object({
        thread_id: z.string().describe("Thread id"),
        text: z.string().describe("The exact text to clip (max 500 chars)"),
      }),
      execute: async (input) => result(ctx, "save_clip", input),
    }),
    find_contact: tool({
      description: "Find people by name or email among the user's contacts and address book.",
      inputSchema: z.object({
        query: z.string().describe("Name or email fragment"),
        limit: z.number().int().nullable().optional().describe("Max results (default 8)"),
      }),
      execute: async (input) => result(ctx, "find_contact", input),
    }),
    create_draft: tool({
      description:
        "Write an email as a draft for the user to review. mode: new (needs `to` + `subject`), reply (to the thread's last sender), reply_all, forward (needs `to`). Body is plain text; paragraphs separated by blank lines. The user decides whether to send. Returns a draft id.",
      inputSchema: z.object({
        mode: z.enum(["new", "reply", "reply_all", "forward"]),
        thread_id: z.string().nullable().optional().describe("Thread id for reply / reply_all / forward"),
        to: z.array(z.string()).nullable().optional().describe("Recipient emails (new / forward). Null for replies."),
        cc: z.array(z.string()).nullable().optional().describe("CC emails"),
        subject: z.string().nullable().optional().describe("Subject (new mail; replies/forwards derive it when null)"),
        body_text: z.string().describe("The email text, in the user's voice"),
        account_id: z.string().nullable().optional().describe("From account id (null = the thread's account or the default account)"),
      }),
      execute: async (input) => result(ctx, "create_draft", input),
    }),
    send_draft: tool({
      description: "Send a draft. Only works when the user allowed autonomous sending; otherwise the user must press Send themselves.",
      inputSchema: z.object({ draft_id: z.string().describe("Draft id from create_draft") }),
      execute: async (input) => result(ctx, "send_draft", input),
    }),
    list_memory: tool({
      description: "What you currently remember about the user (ids included).",
      inputSchema: z.object({}),
      execute: async (input) => result(ctx, "list_memory", input),
    }),
    remember: tool({
      description: "Store a durable fact, preference, tone note, or contact note about the user. Keep it to one concise sentence.",
      inputSchema: z.object({
        kind: z.enum(["profile", "tone", "fact", "preference", "contact"]),
        content: z.string().describe("One sentence"),
      }),
      execute: async (input) => result(ctx, "remember", input),
    }),
    forget: tool({
      description: "Delete a memory entry by id.",
      inputSchema: z.object({ id: z.string().describe("Memory id") }),
      execute: async (input) => result(ctx, "forget", input),
    }),
  };
}

/* ---------- helpers ---------- */

function summary(t: ThreadSummary) {
  return {
    thread_id: t.id,
    subject: t.subject,
    from: t.last_from.name ? `${t.last_from.name} <${t.last_from.email}>` : t.last_from.email,
    participants: t.participants.map((p) => p.email),
    snippet: t.snippet.slice(0, 160),
    bucket: t.bucket,
    unread: t.unread,
    new: !t.seen,
    reply_later: t.reply_later,
    set_aside: t.set_aside,
    messages: t.message_count,
    last_message_at: new Date(t.last_message_at).toISOString(),
    labels: t.labels.map((l) => l.name),
    account_id: t.account_id,
  };
}

async function ownedThreadRow(ctx: ToolContext, id: string): Promise<ThreadRow | null> {
  return ownedRow<ThreadRow>(ctx.env.DB, "threads", id, ctx.user.id);
}

function accountById(ctx: ToolContext, id: string): AccountRow | undefined {
  return ctx.accounts.find((a) => a.id === id);
}

function parseUnsubscribe(header: string): { url?: string; mailto?: string } {
  const out: { url?: string; mailto?: string } = {};
  for (const m of header.matchAll(/<([^>]+)>/g)) {
    const v = m[1].trim();
    if (/^https?:/i.test(v) && !out.url) out.url = v;
    if (/^mailto:/i.test(v) && !out.mailto) out.mailto = v.replace(/^mailto:/i, "").split("?")[0];
  }
  return out;
}

/* ---------- executor ---------- */

export async function runTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<{ result: string; summary: string; isError?: boolean }> {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, any>;
  const db = ctx.env.DB;
  const ids = ctx.accounts.map((a) => a.id);
  const sc = inClause(ids);
  const t = now();
  const VISIBLE = `t.merged_into IS NULL AND (t.bubble_up_at IS NULL OR t.bubble_up_at <= ?)`;
  const ok = (data: unknown, summaryText: string) => ({ result: JSON.stringify(data), summary: summaryText });
  const fail = (msg: string) => ({ result: JSON.stringify({ error: msg }), summary: msg, isError: true });
  if (!ids.length && !["list_memory", "remember", "forget"].includes(name)) return fail("No mail accounts are connected yet.");

  switch (name) {
    case "search_mail": {
      const q = String(input.query ?? "").trim();
      const limit = Math.min(25, Math.max(1, Number(input.limit) || 10));
      if (!q) return fail("query is required");
      const { hits, mode } = await searchThreads(db, ids, q, { limit });
      const list = await attachAvatars(db, await threadsWithLabels(db, hits.map((h) => h.thread)));
      return ok(
        {
          results: list.map((t, i) => ({
            ...summary(t),
            highlight: hits[i]?.highlight ?? null,
          })),
          mode,
        },
        `Searched mail for “${q}” · ${list.length} result${list.length === 1 ? "" : "s"}`
      );
    }
    case "list_threads": {
      const bucket = String(input.bucket ?? "imbox");
      const limit = Math.min(40, Math.max(1, Number(input.limit) || 15));
      const where: string[] = [`t.account_id IN ${sc.sql}`, bucket === "bubble_up" ? `t.merged_into IS NULL AND t.bubble_up_at IS NOT NULL AND t.bubble_up_at > ?` : VISIBLE];
      const params: unknown[] = [...sc.params, t];
      let order = "t.last_message_at DESC";
      switch (bucket) {
        case "imbox":
          where.push(`t.bucket = 'imbox' AND t.reply_later = 0 AND t.set_aside = 0`);
          if (input.only_new) where.push(`t.seen = 0`);
          break;
        case "previously_seen":
          where.push(`t.bucket = 'imbox' AND t.seen = 1`);
          break;
        case "feed":
        case "paper_trail":
        case "screener":
        case "screened_out":
        case "trash":
          where.push(`t.bucket = ?`);
          params.push(bucket);
          break;
        case "sent":
          where.push(`t.bucket <> 'trash' AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.is_from_me = 1)`);
          break;
        case "reply_later":
          where.push(`t.reply_later = 1 AND t.bucket <> 'trash'`);
          order = "t.reply_later_at DESC";
          break;
        case "set_aside":
          where.push(`t.set_aside = 1 AND t.bucket <> 'trash'`);
          order = "t.set_aside_at DESC";
          break;
        case "bubble_up":
          where.push(`t.bucket <> 'trash'`);
          order = "t.bubble_up_at ASC";
          break;
        default:
          where.push(`t.bucket <> 'trash' AND t.bucket <> 'screened_out'`);
      }
      const rows = await db.prepare(`SELECT t.* FROM threads t WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`).bind(...params, limit).all<ThreadRow>();
      const list = await threadsWithLabels(db, rows.results);
      return ok({ bucket, threads: list.map(summary) }, `Listed ${list.length} thread${list.length === 1 ? "" : "s"} in ${bucket.replace("_", " ")}`);
    }
    case "read_thread": {
      const id = String(input.thread_id ?? "");
      const acc = await accountForThread(db, ctx.user.id, id);
      if (!acc) return fail("Thread not found");
      const detail = await loadThreadDetail(db, ctx.user.id, id);
      if (!detail) return fail("Thread not found");
      const max = Math.min(MAX_MESSAGES, Math.max(1, Number(input.max_messages) || MAX_MESSAGES));
      const all = detail.messages;
      const slice = all.slice(Math.max(0, all.length - max));
      let truncated = slice.length < all.length;
      const messages = slice.map((m) => {
        let text = (m.text_body || htmlToText(m.html_body || "")).trim();
        if (text.length > MAX_BODY) {
          text = text.slice(0, MAX_BODY) + " …[truncated]";
          truncated = true;
        }
        return { message_id: m.id, from: m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email, to: m.to.map((a) => a.email), cc: m.cc.map((a) => a.email), date: new Date(m.date).toISOString(), from_me: m.is_from_me, text, attachments: m.attachments.map((a) => a.filename) };
      });
      return ok(
        { thread_id: detail.id, subject: detail.subject, bucket: detail.bucket, account_email: acc.email, participants: detail.participants, note: detail.note || null, message_count: all.length, truncated, messages },
        `Read “${detail.subject}” · ${messages.length} of ${all.length} message${all.length === 1 ? "" : "s"}${truncated ? " (trimmed)" : ""}`
      );
    }
    case "list_screener": {
      const rows = await db
        .prepare(`SELECT t.* FROM threads t WHERE t.account_id IN ${sc.sql} AND t.bucket = 'screener' AND ${VISIBLE} ORDER BY t.last_message_at DESC LIMIT 200`)
        .bind(...sc.params, t)
        .all<ThreadRow>();
      const bySender = new Map<string, { account_id: string; email: string; name: string; threads: { thread_id: string; subject: string; snippet: string }[] }>();
      for (const r of rows.results) {
        const key = `${r.account_id}|${r.last_from_email}`;
        const e = bySender.get(key) ?? { account_id: r.account_id, email: r.last_from_email, name: r.last_from_name, threads: [] };
        if (e.threads.length < 3) e.threads.push({ thread_id: r.id, subject: r.custom_subject || r.subject, snippet: r.snippet.slice(0, 120) });
        bySender.set(key, e);
      }
      const senders: unknown[] = [];
      for (const e of bySender.values()) {
        const contact = await db.prepare(`SELECT id FROM contacts WHERE account_id = ? AND email = ?`).bind(e.account_id, e.email).first<{ id: string }>();
        senders.push({ contact_id: contact?.id ?? null, name: e.name, email: e.email, account_email: accountById(ctx, e.account_id)?.email, threads: e.threads });
      }
      return ok({ senders }, `Checked the Screener · ${senders.length} waiting`);
    }
    case "screen_sender": {
      const contact = await ownedRow<ContactRow>(db, "contacts", String(input.contact_id ?? ""), ctx.user.id);
      if (!contact) return fail("Contact not found");
      const decision = String(input.decision);
      if (!["imbox", "feed", "paper_trail", "screened_out"].includes(decision)) return fail("Bad decision");
      await applyScreenDecision(db, contact.account_id, contact, decision as any);
      return ok({ ok: true, contact: toContact({ ...contact, screen_status: decision as any }) }, `${decision === "screened_out" ? "Screened out" : "Let in"} ${contact.name || contact.email}${decision !== "screened_out" ? ` → ${decision.replace("_", " ")}` : ""}`);
    }
    case "thread_action": {
      const id = String(input.thread_id ?? "");
      const row = await ownedThreadRow(ctx, id);
      if (!row) return fail("Thread not found");
      const acc = accountById(ctx, row.account_id) ?? null;
      const action = String(input.action);
      if (action === "unsubscribe_info") {
        const m = await db.prepare(`SELECT list_unsubscribe FROM messages WHERE thread_id = ? AND list_unsubscribe <> '' ORDER BY date DESC LIMIT 1`).bind(id).first<{ list_unsubscribe: string }>();
        const info = m ? parseUnsubscribe(m.list_unsubscribe) : {};
        return ok({ ...info, found: !!(info.url || info.mailto) }, info.url || info.mailto ? "Found the unsubscribe link" : "No unsubscribe link in this thread");
      }
      let body: ActionBody;
      let label = "";
      const on = input.on === null || input.on === undefined ? true : !!input.on;
      switch (action) {
        case "reply_later": body = { action: "reply_later", on } as any; label = on ? "Added to Reply Later" : "Removed from Reply Later"; break;
        case "set_aside": body = { action: "set_aside", on } as any; label = on ? "Set aside" : "Removed from Set Aside"; break;
        case "bubble_up": body = { action: "bubble_up", at: input.at ?? null } as any; label = input.at ? `Bubbles up ${new Date(Number(input.at)).toLocaleString()}` : "Bubble up cancelled"; break;
        case "move": {
          const bucket = String(input.bucket ?? "");
          if (!["imbox", "feed", "paper_trail", "trash"].includes(bucket)) return fail("bucket must be imbox, feed, paper_trail or trash");
          body = { action: "move", bucket } as any; label = `Moved to ${bucket === "paper_trail" ? "Paper Trail" : bucket === "trash" ? "Trash" : bucket === "feed" ? "The Feed" : "Imbox"}`; break;
        }
        case "mark_read": body = { action: "mark_read" } as any; label = "Marked read"; break;
        case "mark_unread": body = { action: "mark_unread" } as any; label = "Marked unread"; break;
        case "label_add": if (!input.label_id) return fail("label_id required"); body = { action: "labels", add: [String(input.label_id)] } as any; label = "Label added"; break;
        case "label_remove": if (!input.label_id) return fail("label_id required"); body = { action: "labels", remove: [String(input.label_id)] } as any; label = "Label removed"; break;
        case "bundle": body = { action: "bundle", on } as any; label = on ? "Sender bundled" : "Sender unbundled"; break;
        default: return fail("Unknown action");
      }
      const r = await applyAction(mailOps(ctx), id, body);
      if ("error" in r) return fail(r.error);
      return ok({ ok: true, thread_id: id, action }, `${label} · “${row.custom_subject || row.subject}”`);
    }
    case "list_labels": {
      const rows = await db.prepare(`SELECT id, name FROM labels WHERE account_id IN ${sc.sql} ORDER BY name`).bind(...sc.params).all<{ id: string; name: string }>();
      return ok({ labels: rows.results }, `Listed ${rows.results.length} labels`);
    }
    case "list_collections": {
      const rows = await db
        .prepare(`SELECT c.id, c.name, c.description, (SELECT COUNT(*) FROM collection_threads ct WHERE ct.collection_id = c.id) AS thread_count FROM collections c WHERE c.account_id IN ${sc.sql} ORDER BY c.updated_at DESC`)
        .bind(...sc.params)
        .all();
      return ok({ collections: rows.results }, `Listed ${rows.results.length} collections`);
    }
    case "create_collection": {
      const nm = String(input.name ?? "").trim().slice(0, 120);
      if (!nm) return fail("name required");
      const id = uid();
      await db.prepare(`INSERT INTO collections (id, account_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, ids[0], nm, String(input.description ?? "").slice(0, 500), t, t).run();
      return ok({ collection_id: id, name: nm }, `Created collection “${nm}”`);
    }
    case "add_to_collection": {
      const row = await ownedThreadRow(ctx, String(input.thread_id ?? ""));
      const coll = await ownedRow<{ id: string; name: string }>(db, "collections", String(input.collection_id ?? ""), ctx.user.id);
      if (!row || !coll) return fail("Thread or collection not found");
      await db.prepare(`INSERT OR IGNORE INTO collection_threads (collection_id, thread_id, added_at) VALUES (?, ?, ?)`).bind(coll.id, row.id, t).run();
      await db.prepare(`UPDATE collections SET updated_at = ? WHERE id = ?`).bind(t, coll.id).run();
      return ok({ ok: true }, `Added “${row.custom_subject || row.subject}” to ${coll.name}`);
    }
    case "save_clip": {
      const row = await ownedThreadRow(ctx, String(input.thread_id ?? ""));
      const text = String(input.text ?? "").trim().slice(0, 500);
      if (!row || !text) return fail("Thread not found or empty text");
      const id = uid();
      await db.prepare(`INSERT INTO clips (id, account_id, thread_id, message_id, text, created_at) VALUES (?, ?, ?, NULL, ?, ?)`).bind(id, row.account_id, row.id, text, t).run();
      return ok({ clip_id: id }, `Clipped “${text.slice(0, 40)}${text.length > 40 ? "…" : ""}”`);
    }
    case "find_contact": {
      const q = String(input.query ?? "").trim();
      const limit = Math.min(20, Math.max(1, Number(input.limit) || 8));
      if (!q) return fail("query required");
      const like = `%${q}%`;
      const rows = await db
        .prepare(`SELECT * FROM contacts WHERE account_id IN ${sc.sql} AND (email LIKE ? OR name LIKE ?) ORDER BY last_seen_at DESC LIMIT ?`)
        .bind(...sc.params, like, like, limit)
        .all<ContactRow>();
      const seen = new Set(rows.results.map((r) => r.email));
      const book = await db
        .prepare(`SELECT email, name FROM address_book WHERE account_id IN ${sc.sql} AND (email LIKE ? OR name LIKE ?) LIMIT ?`)
        .bind(...sc.params, like, like, limit)
        .all<{ email: string; name: string }>();
      const people = [
        ...rows.results.map((r) => ({ contact_id: r.id, name: r.name, email: r.email, screen_status: r.screen_status, bundled: !!(r as any).bundled, notes: r.notes || undefined })),
        ...book.results.filter((b) => !seen.has(b.email)).map((b) => ({ contact_id: null, name: b.name, email: b.email, screen_status: "unknown" })),
      ].slice(0, limit);
      return ok({ people }, `Looked up “${q}” · ${people.length} found`);
    }
    case "create_draft": {
      const mode = String(input.mode ?? "new");
      let acc: AccountRow | null = null;
      let threadId: string | null = null;
      let replyTo: MessageRow | null = null;
      let to: Address[] = [];
      let cc: Address[] = [];
      let subject = String(input.subject ?? "").trim();
      let quoted = "";
      const parseList = (v: unknown): Address[] => (Array.isArray(v) ? v.map((e) => String(e).trim().toLowerCase()).filter((e) => e.includes("@")).map((email) => ({ email, name: "" })) : []);
      if (mode !== "new") {
        threadId = String(input.thread_id ?? "");
        const row = await ownedThreadRow(ctx, threadId);
        if (!row) return fail("thread_id is required for replies and forwards");
        acc = accountById(ctx, row.account_id) ?? null;
        replyTo = await db.prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY date DESC LIMIT 1`).bind(threadId).first<MessageRow>();
        const me = (acc?.email ?? "").toLowerCase();
        const baseSubject = row.custom_subject || row.subject;
        if (mode === "forward") {
          to = parseList(input.to);
          if (!to.length) return fail("`to` is required for a forward");
          subject = subject || (/^fwd?:/i.test(baseSubject) ? baseSubject : `Fwd: ${baseSubject}`);
          const from = replyTo ? `${replyTo.from_name || replyTo.from_email} <${replyTo.from_email}>` : "";
          quoted = replyTo ? `<p>---------- Forwarded message ----------<br>From: ${from}<br>Date: ${new Date(replyTo.date).toUTCString()}<br>Subject: ${replyTo.subject}</p>${replyTo.html_body || textToHtml(replyTo.text_body)}` : "";
        } else {
          if (!replyTo) return fail("Nothing to reply to");
          const sender: Address = { email: replyTo.from_email, name: replyTo.from_name };
          const isMe = sender.email.toLowerCase() === me;
          to = isMe ? safeJson<Address[]>(replyTo.to_json, []) : [sender];
          if (mode === "reply_all") {
            const others = [...safeJson<Address[]>(replyTo.to_json, []), ...safeJson<Address[]>(replyTo.cc_json, [])].filter((a) => a.email.toLowerCase() !== me && !to.some((x) => x.email === a.email));
            cc = others;
          }
          subject = subject || (/^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`);
        }
      } else {
        to = parseList(input.to);
        cc = parseList(input.cc);
        if (!to.length) return fail("`to` is required for a new message");
        if (!subject) return fail("`subject` is required for a new message");
        acc = (input.account_id && accountById(ctx, String(input.account_id))) || ctx.accounts[0] || null;
      }
      if (!acc) return fail("No account to send from");
      const bodyText = String(input.body_text ?? "").trim();
      if (!bodyText) return fail("body_text is required");
      const html = textToHtml(bodyText) + (acc.signature ? `<p>${acc.signature}</p>` : "") + quoted;
      const id = uid();
      await db
        .prepare(`INSERT INTO drafts (id, account_id, thread_id, reply_to_message_id, to_json, cc_json, bcc_json, subject, body_html, send_at, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, NULL, 'draft', NULL, ?, ?)`)
        .bind(id, acc.id, threadId, replyTo?.id ?? null, JSON.stringify(to), JSON.stringify(cc), subject.slice(0, 500), html.slice(0, 500_000), t, t)
        .run();
      const draft = { draft_id: id, account_id: acc.id, from: acc.email, thread_id: threadId, to, cc, subject, body_text: bodyText };
      return ok({ ...draft, note: ctx.autoSend ? "You may call send_draft." : "The user will review and press Send." }, `Drafted “${subject}” to ${to.map((a) => a.email).join(", ")}`);
    }
    case "send_draft": {
      const id = String(input.draft_id ?? "");
      const row = await ownedRow<any>(db, "drafts", id, ctx.user.id);
      if (!row) return fail("Draft not found");
      if (!ctx.autoSend) return ok({ needs_confirmation: true, draft_id: id }, "Waiting for the user to press Send");
      const acc = accountById(ctx, row.account_id);
      if (!acc) return fail("Account not found");
      const r = await sendMail(ctx.env, acc, { thread_id: row.thread_id, reply_to_message_id: row.reply_to_message_id, to: safeJson(row.to_json, []), cc: safeJson(row.cc_json, []), bcc: safeJson(row.bcc_json, []), subject: row.subject, body_html: row.body_html });
      await db.prepare(`DELETE FROM drafts WHERE id = ?`).bind(id).run();
      return ok({ ok: true, thread_id: r.thread_id }, `Sent “${row.subject}”`);
    }
    case "list_memory": {
      const rows = await listMemory(ctx.env, ctx.user.id);
      return ok({ memory: rows.map((r) => ({ id: r.id, kind: r.kind, content: r.content, source: r.source })) }, `Recalled ${rows.length} memory entries`);
    }
    case "remember": {
      const kind = String(input.kind ?? "fact") as MemoryKind;
      const content = String(input.content ?? "").trim();
      if (!content) return fail("content required");
      const row = await addMemory(ctx.env, ctx.user.id, kind, content, "assistant");
      return ok({ id: row.id }, `Remembered: ${content.slice(0, 60)}${content.length > 60 ? "…" : ""}`);
    }
    case "forget": {
      const done = await deleteMemory(ctx.env, ctx.user.id, String(input.id ?? ""));
      return done ? ok({ ok: true }, "Forgot that") : fail("Memory entry not found");
    }
    default:
      return fail(`Unknown tool ${name}`);
  }
}
