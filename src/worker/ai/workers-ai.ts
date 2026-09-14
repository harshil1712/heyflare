// Workers AI binding helpers + default model ids.
import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "../env";

export const WORKERS_AI_DEFAULT_MODEL = "@cf/zai-org/glm-5.3";

export const WORKERS_AI_MODELS = [
  "@cf/zai-org/glm-5.3",
  "@cf/zai-org/glm-5.2",
  "@cf/zai-org/glm-4.7-flash",
] as const;

/** `createWorkersAI` bound to `env.AI` — no API keys. */
export function workersAI(env: Env) {
  if (!env.AI) throw new Error("ai_not_configured");
  return createWorkersAI({ binding: env.AI });
}

export function workersAiModel(env: Env, model = WORKERS_AI_DEFAULT_MODEL) {
  const w = workersAI(env);
  return w((model || WORKERS_AI_DEFAULT_MODEL) as Parameters<typeof w>[0]);
}

export function describeWorkersAiError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not available|paid|upgrade|billing|Workers Paid/i.test(msg)) {
    return "This Workers AI model needs a Workers Paid plan (or AI Gateway credits).";
  }
  if (/model.*(not found|unknown)|404/i.test(msg)) return `Workers AI model not found: ${msg.slice(0, 160)}`;
  return `Workers AI error: ${msg.slice(0, 240)}`;
}
