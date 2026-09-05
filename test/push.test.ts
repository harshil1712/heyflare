import { describe, it, expect } from "vitest";
import { filterNotifyCooldown, threadsToNotify, upsertPushSubscription, deletePushSubscription, notifyNewMail } from "../src/worker/push";
import { seedUser, testEnv } from "./helpers";

describe("Web Push gating", () => {
  it("threadsToNotify only keeps unseen imbox / reply_later", () => {
    const ids = threadsToNotify([
      { id: "a", bucket: "imbox", seen: 0, reply_later: 0, is_sent_only: 0 },
      { id: "b", bucket: "imbox", seen: 1, reply_later: 0, is_sent_only: 0 },
      { id: "c", bucket: "feed", seen: 0, reply_later: 0, is_sent_only: 0 },
      { id: "d", bucket: "paper_trail", seen: 0, reply_later: 1, is_sent_only: 0 },
      { id: "e", bucket: "imbox", seen: 0, reply_later: 0, is_sent_only: 1 },
    ]);
    expect(ids.sort()).toEqual(["a", "d"]);
  });

  it("subscription CRUD + cooldown", async () => {
    const env = testEnv();
    const user = await seedUser();
    const sub = await upsertPushSubscription(env, user.id, {
      endpoint: `https://push.example/${crypto.randomUUID()}`,
      keys: { p256dh: "p256", auth: "auth" },
    });
    expect(sub.id).toBeTruthy();

    const due = await filterNotifyCooldown(env, user.id, ["t1", "t2"]);
    expect(due).toEqual(["t1", "t2"]);

    // No VAPID → notify skips send but still records cooldown when… actually notifyNewMail only writes log if subs exist; attempted stays 0 without VAPID.
    const r = await notifyNewMail(env, user.id, [{ id: "t1", bucket: "imbox", seen: 0, reply_later: 0, is_sent_only: 0 }]);
    expect(r.notified_threads).toBe(1);
    expect(r.attempted).toBe(0);

    const again = await filterNotifyCooldown(env, user.id, ["t1", "t2"]);
    expect(again).toEqual(["t2"]);

    expect(await deletePushSubscription(env, user.id, sub.endpoint)).toBe(true);
  });
});
