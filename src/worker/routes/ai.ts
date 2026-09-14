import { getSessionSecret } from "../secrets";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import type { AccountRow, ThreadRow } from "../db";
import { uid, now, accountForThread } from "../db";
import { encryptSecret } from "../ai/crypto";
import { PRESETS, presetById, loadAiSettings, loadAiConfig, describeApiError, AiNotConfigured } from "../ai/provider";
import { listMemory, addMemory, updateMemory, deleteMemory, clearMemory, learnFromMail, type MemoryKind } from "../ai/memory";
import { generateReply, summarizeThread, threadToText, type ChatDeps, type ReplyTone } from "../ai/chat";
import { completeAi } from "../ai/model";
import { loadThreadDetail } from "./mail";

const ai = new Hono<AppEnv>();

async function userAccounts(c: any): Promise<AccountRow[]> {
  const r = await c.env.DB.prepare(`SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at ASC`).bind(c.get("user").id).all();
  return r.results as AccountRow[];
}

async function deps(c: any): Promise<ChatDeps> {
  const user = c.get("user");
  const cfg = await loadAiConfig(c.env, user.id);
  if (!cfg) throw new AiNotConfigured();
  return { env: c.env, user, accounts: await userAccounts(c), cfg };
}

/* ---------- settings ---------- */

ai.get("/settings", async (c) => {
  const user = c.get("user");
  const row = await loadAiSettings(c.env, user.id);
  const state = await c.env.DB.prepare(`SELECT last_learned_at FROM ai_learning_state WHERE user_id = ?`).bind(user.id).first<{ last_learned_at: number | null }>();
  const workersOk = !!c.env.AI;
  const defaultPreset = workersOk ? "workers_ai" : "anthropic";
  const preset = presetById(row?.preset === "mock" ? "workers_ai" : row?.preset ?? defaultPreset);
  const configured =
    preset.kind === "workers_ai"
      ? workersOk
      : !!row && (preset.kind === "anthropic" ? !!row.api_key_enc : preset.id === "custom" ? !!row.base_url : !!row.api_key_enc);
  // If nothing configured but Workers AI is bound, treat as ready (zero-config).
  const effectivelyConfigured = configured || (workersOk && (!row || !row.api_key_enc));
  const presets = PRESETS.filter((p) => (p.id === "workers_ai" ? workersOk : true));
  return c.json({
    configured: effectivelyConfigured,
    provider: effectivelyConfigured && !configured && workersOk ? "workers_ai" : preset.kind,
    preset: effectivelyConfigured && !row ? "workers_ai" : preset.id,
    base_url: preset.id === "custom" ? row?.base_url ?? "" : preset.base_url,
    key_hint: row?.key_hint ?? "",
    model: row?.model || (workersOk ? "@cf/zai-org/glm-5.3" : preset.default_model),
    learn: row ? !!row.learn : true,
    auto_send: row ? !!row.auto_send : false,
    presets,
    last_learned_at: state?.last_learned_at ?? null,
    server_ready: true,
    workers_ai: workersOk,
  });
});

ai.put("/settings", async (c) => {
  const user = c.get("user");
  const b = await c.req.json<{ preset?: string; base_url?: string; api_key?: string | null; model?: string; learn?: boolean; auto_send?: boolean }>().catch(() => ({}) as any);
  const cur = await loadAiSettings(c.env, user.id);
  const wantedPreset = typeof b.preset === "string" ? b.preset : cur?.preset ?? (c.env.AI ? "workers_ai" : "anthropic");
  if (wantedPreset === "mock") return c.json({ error: "unknown_preset" }, 400);
  if (wantedPreset === "workers_ai" && !c.env.AI) return c.json({ error: "workers_ai_unavailable" }, 400);
  const preset = presetById(wantedPreset);
  let enc = cur?.api_key_enc ?? "";
  let hint = cur?.key_hint ?? "";
  if (preset.kind === "workers_ai") {
    enc = "";
    hint = "";
  } else if (typeof b.api_key === "string") {
    const key = b.api_key.trim();
    if (key) {
      if (key.length < 8) return c.json({ error: "invalid_key" }, 400);
      try {
        enc = await encryptSecret(await getSessionSecret(c.env), key);
      } catch (e) {
        return c.json({ error: (e as Error).message }, 500);
      }
      hint = key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "••••";
    }
  } else if (b.api_key === null) {
    enc = "";
    hint = "";
  }
  let baseUrl = cur?.base_url ?? "";
  if (typeof b.base_url === "string") {
    baseUrl = b.base_url.trim().replace(/\/+$/, "");
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return c.json({ error: "base_url_must_be_http" }, 400);
  }
  const model = (typeof b.model === "string" ? b.model.trim().slice(0, 120) : cur?.model) || preset.default_model;
  const learn = typeof b.learn === "boolean" ? (b.learn ? 1 : 0) : cur?.learn ?? 1;
  const autoSend = typeof b.auto_send === "boolean" ? (b.auto_send ? 1 : 0) : cur?.auto_send ?? 0;
  await c.env.DB.prepare(
    `INSERT INTO ai_settings (user_id, provider, preset, base_url, api_key_enc, key_hint, model, learn, auto_send, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider, preset = excluded.preset, base_url = excluded.base_url, api_key_enc = excluded.api_key_enc, key_hint = excluded.key_hint, model = excluded.model, learn = excluded.learn, auto_send = excluded.auto_send, updated_at = excluded.updated_at`
  )
    .bind(user.id, preset.kind, preset.id, baseUrl, enc, hint, model, learn, autoSend, now())
    .run();
  return c.json({ ok: true, provider: preset.kind, preset: preset.id, key_hint: hint, model, learn: !!learn, auto_send: !!autoSend });
});

ai.post("/settings/test", async (c) => {
  try {
    const d = await deps(c);
    const r = await completeAi(d.env, d.cfg, { maxTokens: 20, messages: [{ role: "user", content: "Reply with the single word: ready" }] });
    return c.json({ ok: true, model: d.cfg.model, reply: r.text.trim().slice(0, 40) });
  } catch (e) {
    return c.json({ ok: false, error: describeApiError(e) }, 400);
  }
});

/* ---------- memory ---------- */

ai.get("/memory", async (c) => c.json(await listMemory(c.env, c.get("user").id)));
ai.post("/memory", async (c) => {
  const b = await c.req.json<{ kind?: MemoryKind; content?: string }>().catch(() => ({}) as any);
  if (!b.content?.trim()) return c.json({ error: "content_required" }, 400);
  return c.json(await addMemory(c.env, c.get("user").id, b.kind ?? "fact", b.content, "user"));
});
ai.patch("/memory/:id", async (c) => {
  const b = await c.req.json<{ kind?: MemoryKind; content?: string }>().catch(() => ({}) as any);
  const row = await updateMemory(c.env, c.get("user").id, c.req.param("id"), b);
  return row ? c.json(row) : c.json({ error: "not_found" }, 404);
});
ai.delete("/memory/:id", async (c) => c.json({ ok: await deleteMemory(c.env, c.get("user").id, c.req.param("id")) }));
ai.delete("/memory", async (c) => {
  await clearMemory(c.env, c.get("user").id);
  return c.json({ ok: true });
});
ai.post("/learn", async (c) => {
  try {
    const r = await learnFromMail(c.env, c.get("user"), { force: true });
    return c.json(r);
  } catch (e) {
    return c.json({ error: describeApiError(e) }, 400);
  }
});

/* ---------- conversations ---------- */

ai.get("/conversations", async (c) => {
  const r = await c.env.DB.prepare(`SELECT id, title, created_at, updated_at FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100`).bind(c.get("user").id).all();
  return c.json(r.results);
});
ai.post("/conversations", async (c) => {
  const id = uid();
  const t = now();
  await c.env.DB.prepare(`INSERT INTO ai_conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, '', ?, ?)`).bind(id, c.get("user").id, t, t).run();
  return c.json({ id, title: "", created_at: t, updated_at: t });
});
ai.get("/conversations/:id", async (c) => {
  const conv = await c.env.DB.prepare(`SELECT id, title, created_at, updated_at FROM ai_conversations WHERE id = ? AND user_id = ?`).bind(c.req.param("id"), c.get("user").id).first();
  if (!conv) return c.json({ error: "not_found" }, 404);
  // Transcript lives in the Think AssistantAgent DO — not D1.
  return c.json({ conversation: conv });
});
ai.patch("/conversations/:id", async (c) => {
  const b = await c.req.json<{ title?: string }>().catch(() => ({}) as any);
  await c.env.DB.prepare(`UPDATE ai_conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`).bind(String(b.title ?? "").slice(0, 120), now(), c.req.param("id"), c.get("user").id).run();
  return c.json({ ok: true });
});
ai.delete("/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("user").id;
  const own = await c.env.DB.prepare(`SELECT id FROM ai_conversations WHERE id = ? AND user_id = ?`).bind(id, userId).first();
  if (!own) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare(`DELETE FROM ai_conversations WHERE id = ? AND user_id = ?`).bind(id, userId).run();
  return c.json({ ok: true });
});

/* ---------- reply / summarize ---------- */

async function threadForAi(c: any, d: ChatDeps, threadId: string) {
  const acc = await accountForThread(c.env.DB, d.user.id, threadId);
  if (!acc) return null;
  const detail = await loadThreadDetail(c.env.DB, d.user.id, threadId);
  if (!detail) return null;
  return { acc, detail };
}

ai.post("/reply", async (c) => {
  const b = await c.req.json<{ thread_id?: string; brief?: string; tone?: ReplyTone }>().catch(() => ({}) as any);
  const brief = String(b.brief ?? "").trim().slice(0, 2000);
  if (!b.thread_id || !brief) return c.json({ error: "thread_id and brief are required" }, 400);
  try {
    const d = await deps(c);
    const t = await threadForAi(c, d, b.thread_id);
    if (!t) return c.json({ error: "not_found" }, 404);
    const last = [...t.detail.messages].reverse().find((m) => !m.is_from_me) ?? t.detail.messages[t.detail.messages.length - 1];
    const tone: ReplyTone = ["match", "formal", "friendly", "brief"].includes(String(b.tone)) ? (b.tone as ReplyTone) : "match";
    const r = await generateReply(d, threadToText(t.detail.messages), brief, tone, { subject: t.detail.subject, to: last ? `${last.from.name} <${last.from.email}>` : "", myEmail: t.acc.email });
    return c.json({ ...r, reply_to_message_id: last?.id ?? null });
  } catch (e) {
    return c.json({ error: describeApiError(e) }, e instanceof AiNotConfigured ? 400 : 502);
  }
});

ai.post("/summarize", async (c) => {
  const b = await c.req.json<{ thread_id?: string }>().catch(() => ({}) as any);
  if (!b.thread_id) return c.json({ error: "thread_id required" }, 400);
  try {
    const d = await deps(c);
    const t = await threadForAi(c, d, b.thread_id);
    if (!t) return c.json({ error: "not_found" }, 404);
    const summary = await summarizeThread(d, threadToText(t.detail.messages), t.detail.subject);
    return c.json({ summary });
  } catch (e) {
    return c.json({ error: describeApiError(e) }, e instanceof AiNotConfigured ? 400 : 502);
  }
});

export default ai;
export type { ThreadRow };
