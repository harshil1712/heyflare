// Event-driven replacements for the every-minute cron: scheduled sends and bubble-ups each get a
// Workflow instance that sleeps until its moment. The daily cron stays as the backstop.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";
import { sendScheduledDraft } from "./send";
import { fireBubbleUp } from "./sync";

export type TimerParams =
  | { kind: "send"; draftId: string; at: number }
  | { kind: "bubble_up"; threadId: string; at: number };

export class TimerWorkflow extends WorkflowEntrypoint<Env, TimerParams> {
  async run(event: WorkflowEvent<TimerParams>, step: WorkflowStep) {
    const p = event.payload;
    await step.sleepUntil("wait", p.at);
    await step.do("fire", async () =>
      p.kind === "send" ? sendScheduledDraft(this.env, p.draftId, p.at) : fireBubbleUp(this.env.DB, p.threadId, p.at)
    );
  }
}

/** Instance id encodes `at`, so a reschedule creates a new instance; stale ones no-op when they fire. */
export async function scheduleTimer(env: Env, p: TimerParams): Promise<void> {
  if (!env.TIMERS) return; // no binding (tests/forks): the daily backstop still fires it
  const id = `${p.kind}-${p.kind === "send" ? p.draftId : p.threadId}-${Math.trunc(p.at)}`;
  try {
    await env.TIMERS.create({ id, params: p });
  } catch (e) {
    if (!/already exists/i.test(String((e as Error)?.message ?? e))) throw e;
  }
}
