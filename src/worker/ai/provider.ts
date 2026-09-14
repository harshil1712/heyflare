// AI settings / presets. Chat + complete use getLanguageModel (model.ts) + AI SDK.
import { getSessionSecret } from "../secrets";
import type { Env } from "../env";
import { decryptSecret } from "./crypto";
import { WORKERS_AI_DEFAULT_MODEL, describeWorkersAiError } from "./workers-ai";

/* ---------- presets ---------- */

export type ProviderKind = "anthropic" | "openai_compatible" | "workers_ai";
export interface Preset {
  id: "workers_ai" | "anthropic" | "openai" | "xai" | "openrouter" | "gemini" | "custom";
  label: string;
  kind: ProviderKind;
  base_url: string;
  default_model: string;
  models: string[];
  key_placeholder: string;
  key_url?: string;
}

export const PRESETS: Preset[] = [
  {
    id: "workers_ai",
    label: "Workers AI (Cloudflare)",
    kind: "workers_ai",
    base_url: "",
    default_model: "@cf/zai-org/glm-5.3",
    models: ["@cf/zai-org/glm-5.3", "@cf/zai-org/glm-5.2", "@cf/zai-org/glm-4.7-flash"],
    key_placeholder: "Not needed — uses the AI binding",
  },
  { id: "anthropic", label: "Anthropic", kind: "anthropic", base_url: "https://api.anthropic.com", default_model: "claude-opus-5", models: ["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5"], key_placeholder: "sk-ant-api03-…", key_url: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI", kind: "openai_compatible", base_url: "https://api.openai.com/v1", default_model: "gpt-5", models: ["gpt-5", "gpt-5-mini", "gpt-4.1", "o3"], key_placeholder: "sk-…", key_url: "https://platform.openai.com/api-keys" },
  { id: "xai", label: "xAI (Grok)", kind: "openai_compatible", base_url: "https://api.x.ai/v1", default_model: "grok-4", models: ["grok-4", "grok-4-fast", "grok-3"], key_placeholder: "xai-…", key_url: "https://console.x.ai" },
  { id: "openrouter", label: "OpenRouter", kind: "openai_compatible", base_url: "https://openrouter.ai/api/v1", default_model: "anthropic/claude-sonnet-4.5", models: ["anthropic/claude-sonnet-4.5", "openai/gpt-5", "google/gemini-2.5-pro", "x-ai/grok-4", "meta-llama/llama-4-maverick"], key_placeholder: "sk-or-…", key_url: "https://openrouter.ai/keys" },
  { id: "gemini", label: "Google Gemini", kind: "openai_compatible", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", default_model: "gemini-2.5-pro", models: ["gemini-2.5-pro", "gemini-2.5-flash"], key_placeholder: "AIza…", key_url: "https://aistudio.google.com/apikey" },
  { id: "custom", label: "Custom (OpenAI-compatible)", kind: "openai_compatible", base_url: "", default_model: "", models: ["llama3.1", "mistral", "qwen2.5"], key_placeholder: "API key (optional for local servers)" },
];
export const DEFAULT_MODEL = WORKERS_AI_DEFAULT_MODEL;

export function presetById(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

/* ---------- config ---------- */

export interface AiSettingsRow {
  user_id: string;
  provider: ProviderKind;
  preset: string;
  base_url: string;
  api_key_enc: string;
  key_hint: string;
  model: string;
  learn: number;
  auto_send: number;
  updated_at: number;
}

export interface AiConfig {
  provider: ProviderKind;
  preset: Preset["id"];
  baseUrl: string;
  apiKey: string;
  model: string;
  learn: boolean;
  autoSend: boolean;
}

export async function loadAiSettings(env: Env, userId: string): Promise<AiSettingsRow | null> {
  return (await env.DB.prepare(`SELECT * FROM ai_settings WHERE user_id = ?`).bind(userId).first<AiSettingsRow>()) ?? null;
}

/** Decrypted config, or null when nothing usable is configured. */
export async function loadAiConfig(env: Env, userId: string): Promise<AiConfig | null> {
  const row = await loadAiSettings(env, userId);
  const fallbackWorkers = !!env.AI;

  if (!row) {
    if (!fallbackWorkers) return null;
    return {
      provider: "workers_ai",
      preset: "workers_ai",
      baseUrl: "",
      apiKey: "",
      model: DEFAULT_MODEL,
      learn: true,
      autoSend: false,
    };
  }

  const preset = presetById(row.preset || (row.provider === "anthropic" ? "anthropic" : row.provider === "workers_ai" ? "workers_ai" : "custom"));
  // Legacy rows may still say "mock" — fall back to Workers AI when available.
  if ((row.preset === "mock" || (row.provider as string) === "mock") && fallbackWorkers) {
    return {
      provider: "workers_ai",
      preset: "workers_ai",
      baseUrl: "",
      apiKey: "",
      model: DEFAULT_MODEL,
      learn: !!row.learn,
      autoSend: !!row.auto_send,
    };
  }
  if (preset.kind === "workers_ai") {
    if (!env.AI) return null;
    return {
      provider: "workers_ai",
      preset: "workers_ai",
      baseUrl: "",
      apiKey: "",
      model: row.model || preset.default_model,
      learn: !!row.learn,
      autoSend: !!row.auto_send,
    };
  }
  const apiKey = row.api_key_enc ? await decryptSecret(await getSessionSecret(env), row.api_key_enc) : "";
  const baseUrl = preset.id === "custom" ? row.base_url.replace(/\/+$/, "") : preset.base_url;
  if (preset.kind === "anthropic" && !apiKey) {
    if (fallbackWorkers) {
      return {
        provider: "workers_ai",
        preset: "workers_ai",
        baseUrl: "",
        apiKey: "",
        model: DEFAULT_MODEL,
        learn: !!row.learn,
        autoSend: !!row.auto_send,
      };
    }
    return null;
  }
  if (preset.kind === "openai_compatible" && !baseUrl) return null;
  if (preset.kind === "openai_compatible" && preset.id !== "custom" && !apiKey) {
    if (fallbackWorkers) {
      return {
        provider: "workers_ai",
        preset: "workers_ai",
        baseUrl: "",
        apiKey: "",
        model: DEFAULT_MODEL,
        learn: !!row.learn,
        autoSend: !!row.auto_send,
      };
    }
    return null;
  }
  return { provider: preset.kind, preset: preset.id, baseUrl, apiKey, model: row.model || preset.default_model, learn: !!row.learn, autoSend: !!row.auto_send };
}

export class AiNotConfigured extends Error {
  constructor() {
    super("ai_not_configured");
  }
}

/** Friendly message for API failures shown in the UI. */
export function describeApiError(e: unknown): string {
  if (e instanceof AiNotConfigured) return "AI isn't available — bind Workers AI (env.AI) or set a provider in Settings → AI.";
  const msg = (e as Error)?.message ?? String(e);
  if (/Workers AI|workers-ai|@cf\//i.test(msg) || /Workers Paid/i.test(msg)) return describeWorkersAiError(e);
  if (/authentication|invalid.?api.?key|unauthorized|401/i.test(msg)) return "The API key was rejected. Check it in Settings → AI.";
  if (/permission|403|forbidden/i.test(msg)) return "This key isn't allowed to use that model.";
  if (/rate.?limit|429/i.test(msg)) return "Rate limited by the provider. Try again in a moment.";
  if (msg === "session_secret_missing") return "SESSION_SECRET is not set on the server, so keys can't be decrypted.";
  return msg.slice(0, 300);
}
