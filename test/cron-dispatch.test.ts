import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { runCron, shouldRunMinute, cronSubsystems } from "../src/worker/index";
import type { CronSubsystems } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { testEnv } from "./helpers";

const MINUTE = "* * * * *";
const QUARTER_HOUR = "*/15 * * * *";

// runCron only reads env.DB and hands it to the subsystems, all of which are stubbed here.
const fakeEnv = { DB: {} } as unknown as Env;

function stubSystems(): CronSubsystems {
  return {
    bubbleUps: vi.fn(async () => 0),
    scheduledSends: vi.fn(async () => 0),
    learning: vi.fn(async () => undefined),
    calendarSync: vi.fn(async () => undefined),
    watchSweep: vi.fn(async () => ({ renewed: 0, woke: 0 })),
    retention: vi.fn(async () => ({ deletedThreads: 0 })),
  };
}

describe("cron dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs only the time-precision set on the minute pattern", async () => {
    const systems = stubSystems();
    await runCron(fakeEnv, MINUTE, systems);
    expect(systems.bubbleUps).toHaveBeenCalledTimes(1);
    expect(systems.scheduledSends).toHaveBeenCalledTimes(1);
    expect(systems.watchSweep).toHaveBeenCalledTimes(1);
    expect(systems.learning).not.toHaveBeenCalled();
    expect(systems.calendarSync).not.toHaveBeenCalled();
    expect(systems.retention).not.toHaveBeenCalled();
  });

  it("runs only the slow set on the quarter-hour pattern", async () => {
    const systems = stubSystems();
    await runCron(fakeEnv, QUARTER_HOUR, systems);
    expect(systems.learning).toHaveBeenCalledTimes(1);
    expect(systems.calendarSync).toHaveBeenCalledTimes(1);
    expect(systems.retention).toHaveBeenCalledTimes(1);
    expect(systems.bubbleUps).not.toHaveBeenCalled();
    expect(systems.scheduledSends).not.toHaveBeenCalled();
    expect(systems.watchSweep).not.toHaveBeenCalled();
  });

  it("defaults unknown patterns to the minute set", async () => {
    const systems = stubSystems();
    await runCron(fakeEnv, "0 12 * * 1", systems);
    expect(systems.bubbleUps).toHaveBeenCalledTimes(1);
    expect(systems.scheduledSends).toHaveBeenCalledTimes(1);
    expect(systems.watchSweep).toHaveBeenCalledTimes(1);
    expect(systems.learning).not.toHaveBeenCalled();
    expect(systems.calendarSync).not.toHaveBeenCalled();
    expect(systems.retention).not.toHaveBeenCalled();
  });

  it("a failing subsystem does not block its siblings", async () => {
    const systems = stubSystems();
    systems.bubbleUps = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(runCron(fakeEnv, MINUTE, systems)).resolves.toBeUndefined();
    expect(systems.scheduledSends).toHaveBeenCalledTimes(1);
    expect(systems.watchSweep).toHaveBeenCalledTimes(1);
  });

  it("shouldRunMinute classifies cron patterns", () => {
    expect(shouldRunMinute(MINUTE)).toBe(true);
    expect(shouldRunMinute(QUARTER_HOUR)).toBe(false);
    expect(shouldRunMinute("  */15 * * * *  ")).toBe(false);
    expect(shouldRunMinute("0 12 * * 1")).toBe(true);
  });

  it("the scheduled handler forwards event.cron into the dispatch", async () => {
    const waited: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
      },
    } as unknown as ExecutionContext;

    // Spying on the live cronSubsystems object intercepts runCron's default wiring,
    // so the real subsystems never run; the real ensureMigrations does (harmless, cached).
    const bubbleUps = vi.spyOn(cronSubsystems, "bubbleUps").mockResolvedValue(0);
    const scheduledSends = vi.spyOn(cronSubsystems, "scheduledSends").mockResolvedValue(0);
    const watchSweep = vi.spyOn(cronSubsystems, "watchSweep").mockResolvedValue({ renewed: 0, woke: 0 });
    const learning = vi.spyOn(cronSubsystems, "learning").mockResolvedValue(undefined);
    const calendarSync = vi.spyOn(cronSubsystems, "calendarSync").mockResolvedValue(undefined);
    const retention = vi.spyOn(cronSubsystems, "retention").mockResolvedValue({ deletedThreads: 0 });

    worker.scheduled({ cron: QUARTER_HOUR } as ScheduledEvent, testEnv(), ctx);
    await Promise.all(waited);

    expect(learning).toHaveBeenCalledTimes(1);
    expect(calendarSync).toHaveBeenCalledTimes(1);
    expect(retention).toHaveBeenCalledTimes(1);
    expect(bubbleUps).not.toHaveBeenCalled();
    expect(scheduledSends).not.toHaveBeenCalled();
    expect(watchSweep).not.toHaveBeenCalled();
  });
});
