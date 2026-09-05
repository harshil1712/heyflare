import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          AI_MOCK: "1",
          SESSION_SECRET: "test-session-secret-phase0",
          PUBSUB_VERIFICATION_TOKEN: "test-pubsub-token",
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "@shared": path.join(root, "src/shared"),
    },
  },
  test: {
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
  },
});
