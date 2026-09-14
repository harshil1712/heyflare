import { describe, it, expect } from "vitest";
import {
  filterNotifyCooldown,
  threadsToNotify,
  pushCopyForThreads,
  upsertPushSubscription,
  deletePushSubscription,
  notifyNewMail,
} from "../src/worker/push";
import { seedUser, testEnv } from "./helpers";

describe("Web Push gating", () => {
  it("threadsToNotify keeps unseen imbox / reply_later / screener", () => {
    const ids = threadsToNotify([
      { id: "a", bucket: "imbox", seen: 0, reply_later: 0, is_sent_only: 0 },
      { id: "b", bucket: "imbox", seen: 1, reply_later: 0, is_sent_only: 0 },
      { id: "c", bucket: "feed", seen: 0, reply_later: 0, is_sent_only: 0 },
      { id: "d", bucket: "paper_trail", seen: 0, reply_later: 1, is_sent_only: 0 },
      { id: "e", bucket: "imbox", seen: 0, reply_later: 0, is_sent_only: 1 },
      { id: "f", bucket: "screener", seen: 0, reply_later: 0, is_sent_only: 0 },
      { id: "g", bucket: "screener", seen: 1, reply_later: 0, is_sent_only: 0 },
    ]);
    expect(ids.sort()).toEqual(["a", "d", "f"]);
  });

  it("pushCopyForThreads distinguishes imbox vs screener", () => {
    expect(
      pushCopyForThreads([
        {
          id: "t1",
          bucket: "screener",
          seen: 0,
          reply_later: 0,
          is_sent_only: 0,
          last_from_email: "ada@example.com",
          last_from_name: "Ada",
        },
      ])
    ).toEqual({
      title: "New sender",
      body: "Ada is waiting in the Screener.",
      url: "/screener",
    });

    expect(
      pushCopyForThreads([
        {
          id: "t1",
          bucket: "screener",
          seen: 0,
          reply_later: 0,
          is_sent_only: 0,
          last_from_email: "a@x.com",
          last_from_name: "A",
        },
        {
          id: "t2",
          bucket: "screener",
          seen: 0,
          reply_later: 0,
          is_sent_only: 0,
          last_from_email: "a@x.com",
          last_from_name: "A",
        },
        {
          id: "t3",
          bucket: "screener",
          seen: 0,
          reply_later: 0,
          is_sent_only: 0,
          last_from_email: "b@x.com",
          last_from_name: "",
        },
      ])
    ).toEqual({
      title: "2 new senders",
      body: "Open heyflare to decide who gets in.",
      url: "/screener",
    });

    expect(
      pushCopyForThreads([
        {
          id: "im1",
          bucket: "imbox",
          seen: 0,
          reply_later: 0,
          is_sent_only: 0,
          last_from_email: "x@y.com",
          last_from_name: "X",
        },
        {
          id: "sc1",
          bucket: "screener",
          seen: 0,
          reply_later: 0,
          is_sent_only: 0,
          last_from_email: "new@z.com",
          last_from_name: "New",
        },
      ])
    ).toEqual({
      title: "New mail",
      body: "1 in Imbox, 1 in Screener.",
      url: "/t/im1",
    });
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
    const r = await notifyNewMail(env, user.id, [
      {
        id: "t1",
        bucket: "imbox",
        seen: 0,
        reply_later: 0,
        is_sent_only: 0,
        last_from_email: "a@b.com",
        last_from_name: "A",
      },
    ]);
    expect(r.notified_threads).toBe(1);
    expect(r.attempted).toBe(0);

    const again = await filterNotifyCooldown(env, user.id, ["t1", "t2"]);
    expect(again).toEqual(["t2"]);

    expect(await deletePushSubscription(env, user.id, sub.endpoint)).toBe(true);
  });
});
