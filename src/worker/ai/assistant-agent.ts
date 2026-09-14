// In-app assistant as a Think agent (DO-backed chat + tools).
import { Think, type TurnContext } from "@cloudflare/think";
import type { Connection } from "agents";
import type { ModelMessage } from "ai";
import type { Env } from "../env";
import type { AccountRow, UserRow } from "../db";
import { accountForThread, now } from "../db";
import { loadThreadDetail } from "../routes/mail";
import { userFromRequest } from "../auth-request";
import { loadAiConfig, type AiConfig } from "./provider";
import { getLanguageModel } from "./model";
import { assistantTools, type ToolContext } from "./tools";
import { buildSystemPrompt, threadToText, type ChatDeps } from "./chat";
import { WORKERS_AI_DEFAULT_MODEL } from "./workers-ai";

type AgentState = {
  userId?: string;
  email?: string;
  name?: string;
};

export class AssistantAgent extends Think<Env, AgentState> {
  initialState: AgentState = {};
  workspaceBash = false;

  private accounts: AccountRow[] = [];
  private cfg: AiConfig | null = null;
  private systemPrompt = "You are the assistant inside heyflare, a HEY-style email client.";

  async onStart() {
    if (this.state.userId) await this.hydrateFromState();
  }

  async onConnect(connection: Connection, ctx: { request: Request }) {
    const user = await userFromRequest(this.env, ctx.request);
    if (!user || user.disabled) {
      connection.close(4401, "unauthorized");
      return;
    }
    const own = await this.env.DB.prepare(`SELECT id FROM ai_conversations WHERE id = ? AND user_id = ?`).bind(this.name, user.id).first();
    if (!own) {
      connection.close(4403, "forbidden");
      return;
    }
    await this.hydrateUser(user);
  }

  /** Think resolves `@cf/...` strings via the AI binding; BYOK returns a LanguageModel. */
  getModel() {
    if (this.cfg && this.cfg.provider !== "workers_ai" && this.cfg.provider !== "mock") {
      try {
        return getLanguageModel(this.env, this.cfg);
      } catch {
        /* fall through */
      }
    }
    return this.cfg?.model || WORKERS_AI_DEFAULT_MODEL;
  }

  getSystemPrompt() {
    return this.systemPrompt;
  }

  getTools() {
    return assistantTools(this.toolContext());
  }

  async beforeTurn(ctx: TurnContext) {
    await this.hydrateFromState();
    if (!this.cfg || !this.state.userId) {
      return { instructions: "AI isn't configured. Ask the user to open Settings → AI." };
    }

    const threadIds = Array.isArray(ctx.body?.context_thread_ids)
      ? (ctx.body!.context_thread_ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 3)
      : [];
    let messages = ctx.messages;
    if (threadIds.length) {
      const blocks = await this.contextBlocks(threadIds);
      if (blocks.length) messages = prependUserContext(messages, blocks);
    }
    void this.touchConversationTitle(messages);
    return { messages };
  }

  async onChatResponse() {
    await this.env.DB.prepare(`UPDATE ai_conversations SET updated_at = ? WHERE id = ?`).bind(now(), this.name).run();
  }

  private toolContext(): ToolContext {
    return {
      env: this.env,
      user: { id: this.state.userId || "", email: this.state.email || "", name: this.state.name || "" },
      accounts: this.accounts,
      autoSend: !!this.cfg?.autoSend,
      emit: () => {},
      waitUntil: (p) => this.ctx.waitUntil(p),
    };
  }

  private async hydrateUser(user: UserRow) {
    this.setState({ userId: user.id, email: user.email, name: user.name });
    this.accounts = (await this.env.DB.prepare(`SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at ASC`).bind(user.id).all<AccountRow>()).results;
    this.cfg = await loadAiConfig(this.env, user.id);
    if (this.cfg) {
      const deps: ChatDeps = { env: this.env, user, accounts: this.accounts, cfg: this.cfg };
      this.systemPrompt = await buildSystemPrompt(deps);
    }
  }

  private async hydrateFromState() {
    if (!this.state.userId) return;
    const user = (await this.env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(this.state.userId).first<UserRow>()) ?? null;
    if (user) await this.hydrateUser(user);
  }

  private async contextBlocks(threadIds: string[]): Promise<string[]> {
    const userId = this.state.userId;
    if (!userId) return [];
    const out: string[] = [];
    for (const tid of threadIds) {
      const acc = await accountForThread(this.env.DB, userId, tid);
      if (!acc) continue;
      const detail = await loadThreadDetail(this.env.DB, userId, tid);
      if (!detail) continue;
      const people = detail.participants.map((p: { name: string; email: string }) => (p.name ? `${p.name} <${p.email}>` : p.email)).join(", ");
      const lastFrom = detail.last_from.name || detail.last_from.email;
      const body = threadToText(detail.messages.slice(-3), 2000, 3);
      out.push(`[[context thread=${tid}]] Subject: ${detail.subject || "(no subject)"} · From: ${lastFrom}\nParticipants: ${people}\nAccount: ${acc.email}\n\n${body}`);
    }
    return out;
  }

  private async touchConversationTitle(messages: ModelMessage[]) {
    const firstUser = messages.find((m) => m.role === "user");
    if (!firstUser) return;
    const text =
      typeof firstUser.content === "string"
        ? firstUser.content
        : Array.isArray(firstUser.content)
          ? firstUser.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
          : "";
    const title = text.replace(/\[\[context[^\]]*\]\][^\n]*/g, "").trim().slice(0, 60);
    if (!title) return;
    await this.env.DB.prepare(`UPDATE ai_conversations SET title = CASE WHEN title = '' THEN ? ELSE title END, updated_at = ? WHERE id = ?`)
      .bind(title, now(), this.name)
      .run();
  }
}

function prependUserContext(messages: ModelMessage[], blocks: string[]): ModelMessage[] {
  if (!blocks.length) return messages;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "user") continue;
    const prefix = blocks.map((b) => ({ type: "text" as const, text: b }));
    if (typeof m.content === "string") {
      out[i] = { role: "user", content: [...prefix, { type: "text", text: m.content }] };
    } else if (Array.isArray(m.content)) {
      out[i] = { role: "user", content: [...prefix, ...(m.content as any[])] };
    }
    break;
  }
  return out;
}
