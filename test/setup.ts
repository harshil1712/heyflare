import { beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { resetMigrationCache, runMigrations } from "../src/worker/migrations";

beforeEach(async () => {
  resetMigrationCache();
  await runMigrations(env as any);
});
