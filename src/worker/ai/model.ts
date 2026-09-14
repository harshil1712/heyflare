// Resolve a LanguageModel from Workers AI binding or BYOK presets (AI SDK providers).
import { createWorkersAI } from "workers-ai-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, type LanguageModel, type ModelMessage } from "ai";
import type { z } from "zod";
import type { Env } from "../env";
import type { AiConfig } from "./provider";
import { AiNotConfigured } from "./provider";
import { WORKERS_AI_DEFAULT_MODEL } from "./workers-ai";

export function getLanguageModel(env: Env, cfg: AiConfig): LanguageModel {
  if (cfg.provider === "workers_ai") {
    if (!env.AI) throw new AiNotConfigured();
    const w = createWorkersAI({ binding: env.AI });
    const id = cfg.model || WORKERS_AI_DEFAULT_MODEL;
    return w(id as Parameters<typeof w>[0]);
  }
  if (cfg.provider === "anthropic") {
    if (!cfg.apiKey) throw new AiNotConfigured();
    const anthropic = createAnthropic({ apiKey: cfg.apiKey });
    return anthropic(cfg.model || "claude-sonnet-4-5");
  }
  if (cfg.provider === "openai_compatible") {
    if (!cfg.baseUrl) throw new AiNotConfigured();
    const openai = createOpenAI({
      apiKey: cfg.apiKey || "not-needed",
      baseURL: cfg.baseUrl.endsWith("/v1") || cfg.baseUrl.includes("/v1/") ? cfg.baseUrl : `${cfg.baseUrl.replace(/\/+$/, "")}/v1`,
      ...(cfg.preset === "openrouter"
        ? { headers: { "HTTP-Referer": "https://github.com/doable-team/heyflare", "X-Title": "heyflare" } }
        : {}),
    });
    return openai.chat(cfg.model || "gpt-4.1");
  }
  if (cfg.provider === "mock") {
    throw new Error("mock_provider_not_for_language_model");
  }
  throw new AiNotConfigured();
}

/** One-shot generateText (reply / summarize / memory / settings test). */
export async function completeAi<T = unknown>(
  env: Env,
  cfg: AiConfig,
  p: {
    system?: string;
    messages: ModelMessage[];
    maxTokens: number;
    schema?: { name: string; zod: z.ZodType<T> };
  }
): Promise<{ text: string; json?: T; refused?: boolean }> {
  if (cfg.provider === "mock") {
    if (p.schema) {
      const guess = { subject: null, body_text: "Thanks — sounds good to me. Farhan", entries: [], summary: "Mock summary.", remove_ids: [] };
      const r = p.schema.zod.safeParse(guess);
      return { text: JSON.stringify(guess), json: r.success ? (r.data as T) : undefined };
    }
    return { text: "ready" };
  }
  const model = getLanguageModel(env, cfg);
  if (p.schema) {
    const r = await generateText({
      model,
      system: p.system,
      messages: p.messages,
      maxOutputTokens: p.maxTokens,
      output: Output.object({ schema: p.schema.zod, name: p.schema.name }),
    });
    const obj = (await r.output) as T;
    return { text: obj != null ? JSON.stringify(obj) : r.text ?? "", json: obj };
  }
  const r = await generateText({
    model,
    system: p.system,
    messages: p.messages,
    maxOutputTokens: p.maxTokens,
  });
  if (r.finishReason === "content-filter") return { text: "", refused: true };
  return { text: r.text ?? "" };
}
