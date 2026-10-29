import { describe, it, expect } from "vitest";
import { isSchemaCurrent, runMigrations, MIGRATIONS } from "../src/worker/migrations";
import { maybeBackfillFts } from "../src/worker/fts";
import { ingestParsed } from "../src/worker/sync";
import { addr, makeParsed, seedAccount, seedUser, testEnv } from "./helpers";

describe("migrations", () => {
  it("an up-to-date database costs exactly one query", async () => {
    const env = testEnv();
    const sql: string[] = [];
    const proxy = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            sql.push(query);
            return (target.prepare as (q: string) => unknown).call(target, query);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await runMigrations({ ...env, DB: proxy });
    expect(sql).toEqual(["SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1"]);
  });

  it("re-applies a missing latest migration", async () => {
    const env = testEnv();
    const latest = MIGRATIONS[MIGRATIONS.length - 1]!.name;
    await env.DB.prepare(`DELETE FROM d1_migrations WHERE name = ?`).bind(latest).run();

    expect(await isSchemaCurrent(env.DB)).toBe(false);
    await runMigrations(env);

    const row = await env.DB.prepare(`SELECT name FROM d1_migrations WHERE name = ?`).bind(latest).first();
    expect(row).not.toBeNull();
    expect(await isSchemaCurrent(env.DB)).toBe(true);
  });

  it("fresh database (no d1_migrations) is not current", async () => {
    const fake = {
      prepare: () => ({
        first: () => Promise.reject(new Error("D1_ERROR: no such table: d1_migrations")),
      }),
    } as unknown as D1Database;
    expect(await isSchemaCurrent(fake)).toBe(false);
  });

  it("maybeBackfillFts fills an empty index when mail exists", async () => {
    const env = testEnv();
    const user = await seedUser();
    const account = await seedAccount(user.id);

    await ingestParsed(env, account, [
      makeParsed({
        gmailId: "mbf-1",
        threadId: "t-mbf",
        from: addr("f@gmail.com"),
        to: [addr(account.email)],
        subject: "Backfill me",
        text: "quokka-maybe-backfill token",
      }),
    ]);
    await env.DB.prepare(`INSERT INTO threads_fts(threads_fts) VALUES('delete-all')`).run();
    await env.DB.prepare(`INSERT INTO messages_fts(messages_fts) VALUES('delete-all')`).run();

    await maybeBackfillFts(env.DB);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM threads_fts`).first<{ n: number }>();
    expect(n?.n).toBeGreaterThanOrEqual(1);

    // Already-populated index is a no-op.
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages_fts`).first<{ n: number }>();
    await expect(maybeBackfillFts(env.DB)).resolves.toBeUndefined();
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages_fts`).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});
