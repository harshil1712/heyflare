import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ensureMigrations } from "../migrations";
import { handlePubSubPush, pubsubAuthorized, type PubSubPushBody } from "../pubsub";

const pubsub = new Hono<AppEnv>();

pubsub.post("/push", async (c) => {
  await ensureMigrations(c.env);
  if (!pubsubAuthorized(c.env, c.req.raw)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = (await c.req.json<PubSubPushBody>().catch(() => ({}))) as PubSubPushBody;
  const r = await handlePubSubPush(c.env, body);
  // Always 204 on handled payloads so Pub/Sub stops retrying; unauthorized already 401.
  if (!r.ok && r.status === "bad_payload") return c.json({ error: r.status }, 400);
  return c.body(null, 204);
});

export default pubsub;
