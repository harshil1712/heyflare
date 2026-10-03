import { beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { resetMigrationCache, runMigrations } from "../src/worker/migrations";
import type { Env } from "../src/worker/env";

beforeEach(async () => {
  (env as unknown as Env).AI = undefined;
  resetMigrationCache();
  await runMigrations(env as any);
});
