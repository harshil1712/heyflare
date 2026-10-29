import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { runCron, cronSubsystems } from "../src/worker/index";
import type { CronSubsystems } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { testEnv } from "./helpers";

// runCron only reads env.DB and hands it to the subsystems, all of which are stubbed here.
const fakeEnv = { DB: {} } as unknown as Env;

function stubSystems(): CronSubsystems {
  return {
    bubbleUps: vi.fn(async () => 0),
    scheduledSends: vi.fn(async () => 0),
    watchSweep: vi.fn(async () => ({ renewed: 0, woke: 0 })),
    retention: vi.fn(async () => ({ deletedThreads: 0 })),
  };
}

describe("cron dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs every subsystem once on the daily tick", async () => {
    const systems = stubSystems();
    await runCron(fakeEnv, systems);
    expect(systems.scheduledSends).toHaveBeenCalledTimes(1);
    expect(systems.bubbleUps).toHaveBeenCalledTimes(1);
    expect(systems.watchSweep).toHaveBeenCalledTimes(1);
    expect(systems.retention).toHaveBeenCalledTimes(1);
  });

  it("a failing subsystem does not block its siblings", async () => {
    const systems = stubSystems();
    systems.bubbleUps = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(runCron(fakeEnv, systems)).resolves.toBeUndefined();
    expect(systems.watchSweep).toHaveBeenCalledTimes(1);
    expect(systems.retention).toHaveBeenCalledTimes(1);
  });

  it("the scheduled handler forwards into the dispatch", async () => {
    const waited: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
      },
    } as unknown as ExecutionContext;

    // Spying on the live cronSubsystems object intercepts runCron's default wiring,
    // so the real subsystems never run; the real ensureMigrations does (harmless, cached).
    const scheduledSends = vi.spyOn(cronSubsystems, "scheduledSends").mockResolvedValue(0);
    const bubbleUps = vi.spyOn(cronSubsystems, "bubbleUps").mockResolvedValue(0);
    const watchSweep = vi.spyOn(cronSubsystems, "watchSweep").mockResolvedValue({ renewed: 0, woke: 0 });
    const retention = vi.spyOn(cronSubsystems, "retention").mockResolvedValue({ deletedThreads: 0 });

    worker.scheduled({ cron: "0 4 * * *" } as ScheduledEvent, testEnv(), ctx);
    await Promise.all(waited);

    expect(scheduledSends).toHaveBeenCalledTimes(1);
    expect(bubbleUps).toHaveBeenCalledTimes(1);
    expect(watchSweep).toHaveBeenCalledTimes(1);
    expect(retention).toHaveBeenCalledTimes(1);
  });
});
