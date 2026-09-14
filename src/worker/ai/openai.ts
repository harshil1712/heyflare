/** Errors from OpenAI-compatible HTTP clients (legacy openai.ts path / describeApiError). */
export class OpenAiApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function describeOpenAiError(e: unknown): string {
  if (e instanceof OpenAiApiError) {
    if (e.status === 401 || e.status === 403) return "The API key was rejected. Check it in Settings → AI.";
    if (e.status === 429) return "Rate limited by the provider. Try again in a moment.";
    if (e.status === 0) return e.message;
    return `Provider error ${e.status}: ${e.message.slice(0, 200)}`;
  }
  return String((e as Error)?.message ?? e).slice(0, 300);
}
