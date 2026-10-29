import { Hono } from "hono";
import type { AppEnv, Env } from "./env";
import { requireUser, requireAccount, getSessionUser } from "./auth";
import { processBubbleUps } from "./sync";
import { processScheduledSends } from "./send";
import authRoutes from "./routes/auth";
import meRoutes from "./routes/me";
import accountRoutes from "./routes/accounts";
import mailRoutes from "./routes/mail";
import screenerRoutes from "./routes/screener";
import contactRoutes from "./routes/contacts";
import labelRoutes from "./routes/labels";
import composeRoutes from "./routes/compose";
import bundleRoutes from "./routes/bundles";
import domainRoutes from "./routes/domains";
import { handleInboundEmail } from "./inbound";
import { ensureMigrations } from "./migrations";
import { VERSION, COMMIT, BUILT_AT } from "@shared/version";
import pubsubRoutes from "./routes/pubsub";
import { sweepGmailWatches } from "./pubsub";
import tokensRoutes from "./routes/tokens";
import pushRoutes from "./routes/push";
import { handleMcpRequest } from "./mcp";

export { SyncActor } from "./sync-actor";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  console.error("Unhandled error", err);
  return c.json({ error: "internal_error", message: (err as Error).message?.slice(0, 300) }, 500);
});

app.route("/auth", authRoutes);
app.route("/pubsub", pubsubRoutes);

// MCP (bearer tokens) — mounted before /api so it stays session-cookie-free.
app.all("/mcp", async (c) => {
  await ensureMigrations(c.env);
  return handleMcpRequest(c.env, c.req.raw);
});
app.all("/mcp/*", async (c) => {
  await ensureMigrations(c.env);
  return handleMcpRequest(c.env, c.req.raw);
});

const api = new Hono<AppEnv>();
// Anonymous GET /api/me -> { user: null, registration_open } (used by the register page)
api.get("/me", async (c, next) => {
  const user = await getSessionUser(c);
  if (user) return next();
  const n = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  return c.json({ user: null, accounts: [], setup_required: (n?.n ?? 0) === 0, google_configured: !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET) });
});
// What this deployment is running (used by the update check).
api.get("/version", (c) => c.json({ version: VERSION, commit: COMMIT, built_at: BUILT_AT, latest: null }));
api.use("*", requireUser);
api.route("/me", meRoutes);
api.route("/accounts", accountRoutes);
api.route("/domains", domainRoutes);
api.route("/tokens", tokensRoutes);
api.route("/push", pushRoutes);


const scoped = new Hono<AppEnv>();
for (const p of ["/counts", "/imbox", "/threads", "/threads/*", "/feed", "/search", "/messages/*", "/files", "/screener", "/screener/*", "/contacts", "/contacts/*", "/labels", "/labels/*", "/drafts", "/drafts/*", "/send", "/send/*", "/bundles", "/bundles/*", "/power-through", "/power-through/*"]) {
  scoped.use(p, requireAccount);
}
scoped.route("/", mailRoutes); // counts, imbox, threads, feed, search, messages/*/attachments, files
scoped.route("/screener", screenerRoutes);
scoped.route("/contacts", contactRoutes);
scoped.route("/labels", labelRoutes);
scoped.route("/bundles", bundleRoutes);
scoped.route("/", composeRoutes); // drafts, send
api.route("/", scoped);

api.notFound((c) => c.json({ error: "not_found" }, 404));
app.route("/api", api);

app.all("*", async (c) => {
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/auth/")) return c.json({ error: "not_found" }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

// ── Cron dispatch ─────────────────────────────────────────────────────────────────────────────
// Two registered triggers (see wrangler.jsonc): "* * * * *" and "*/15 * * * *". The minute tick runs
// only time-precision work; everything tolerant of a coarser cadence runs every 15 minutes. This cuts
// the idle D1 query baseline roughly in half without touching any subsystem's own logic.

const QUARTER_HOUR_CRON = "*/15 * * * *";

/**
 * True when a cron event should run the minute-precision set. Only the exact quarter-hour pattern
 * gets the slow cadence; unknown patterns default to the minute set (safe side).
 */
export function shouldRunMinute(cron: string): boolean {
  return cron.trim() !== QUARTER_HOUR_CRON;
}

/** The cron subsystems, injectable so tests can spy on the dispatch. */
export interface CronSubsystems {
  bubbleUps: (db: Env["DB"]) => Promise<unknown>;
  scheduledSends: (env: Env) => Promise<unknown>;
  watchSweep: (env: Env) => Promise<unknown>;
  retention: (env: Env) => Promise<unknown>;
}

export const cronSubsystems: CronSubsystems = {
  bubbleUps: (db) => processBubbleUps(db),
  scheduledSends: (env) => processScheduledSends(env),
  watchSweep: (env) => sweepGmailWatches(env),
  // Lazy-loaded as before — the retention code only lands in the isolate when a tick needs it.
  retention: (env) => import("./blobs").then((m) => m.sweepRetention(env)),
};

export async function runCron(env: Env, cron: string, systems: CronSubsystems = cronSubsystems) {
  const db = env.DB;
  if (shouldRunMinute(cron)) {
    try {
      await systems.bubbleUps(db);
    } catch (e) {
      console.error("bubble up failed", e);
    }
    try {
      await systems.scheduledSends(env);
    } catch (e) {
      console.error("scheduled sends failed", e);
    }
    // Pub/Sub is the primary ingest path; cron only renews watches and catches missed pushes.
    try {
      await systems.watchSweep(env);
    } catch (e) {
      console.error("gmail watch sweep failed", e);
    }
    return;
  }
  try {
    await systems.retention(env);
  } catch (e) {
    console.error("retention sweep failed", e);
  }
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const { pathname } = new URL(request.url);
    // Static assets never need the database; everything else gets a migrated schema first (cached after the first call).
    if (pathname.startsWith("/api/") || pathname.startsWith("/auth/") || pathname.startsWith("/pubsub/") || pathname.startsWith("/mcp")) {
      try {
        await ensureMigrations(env);
      } catch (e) {
        return Response.json({ error: "migration_failed", message: (e as Error).message?.slice(0, 300) }, { status: 500 });
      }
    }
    return app.fetch(request, env, ctx);
  },
  scheduled: (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(ensureMigrations(env).then(() => runCron(env, event.cron)));
  },
  // Cloudflare Email Routing → custom-domain mailboxes.
  email: async (message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext) => {
    await ensureMigrations(env);
    return handleInboundEmail(message, env);
  },
};
