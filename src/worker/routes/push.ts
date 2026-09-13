import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
  deleteDeviceToken,
  deletePushSubscription,
  listDeviceTokens,
  listPushSubscriptions,
  upsertDeviceToken,
  upsertPushSubscription,
} from "../push";

const push = new Hono<AppEnv>();

push.get("/vapid-public-key", (c) => {
  const key = c.env.VAPID_PUBLIC_KEY;
  if (!key) return c.json({ configured: false, publicKey: null });
  return c.json({ configured: true, publicKey: key });
});

push.get("/subscriptions", async (c) => {
  const rows = await listPushSubscriptions(c.env, c.get("user").id);
  return c.json({
    subscriptions: rows.map((r) => ({ id: r.id, endpoint: r.endpoint, created_at: r.created_at, last_seen_at: r.last_seen_at })),
  });
});

push.post("/subscriptions", async (c) => {
  const body = await c.req.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>().catch(() => ({}) as any);
  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) return c.json({ error: "invalid_subscription" }, 400);
  const row = await upsertPushSubscription(c.env, c.get("user").id, { endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } }, c.req.header("user-agent"));
  return c.json({ ok: true, id: row.id });
});

push.delete("/subscriptions", async (c) => {
  const body = await c.req.json<{ endpoint?: string }>().catch(() => ({}) as any);
  if (!body.endpoint) return c.json({ error: "endpoint_required" }, 400);
  const ok = await deletePushSubscription(c.env, c.get("user").id, body.endpoint);
  return c.json({ ok });
});

/** Native Expo Push tokens (APNs/FCM via Expo). */
push.get("/devices", async (c) => {
  const rows = await listDeviceTokens(c.env, c.get("user").id);
  return c.json({
    devices: rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      device_name: r.device_name,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
    })),
  });
});

push.post("/devices", async (c) => {
  const body = await c
    .req.json<{ token?: string; platform?: string; device_name?: string }>()
    .catch(() => ({}) as { token?: string; platform?: string; device_name?: string });
  const token = body.token?.trim();
  if (!token || token.length < 20) return c.json({ error: "invalid_token" }, 400);
  const row = await upsertDeviceToken(c.env, c.get("user").id, token, body.platform, body.device_name);
  return c.json({ ok: true, id: row.id });
});

push.delete("/devices", async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string });
  if (!body.token) return c.json({ error: "token_required" }, 400);
  const ok = await deleteDeviceToken(c.env, c.get("user").id, body.token);
  return c.json({ ok });
});

export default push;
