// Workers AI default model + error messages.
export const WORKERS_AI_DEFAULT_MODEL = "@cf/zai-org/glm-5.3";

export function describeWorkersAiError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not available|paid|upgrade|billing|Workers Paid/i.test(msg)) {
    return "This Workers AI model needs a Workers Paid plan (or AI Gateway credits).";
  }
  if (/model.*(not found|unknown)|404/i.test(msg)) return `Workers AI model not found: ${msg.slice(0, 160)}`;
  return `Workers AI error: ${msg.slice(0, 240)}`;
}
