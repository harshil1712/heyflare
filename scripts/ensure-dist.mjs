import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Vitest loads wrangler.jsonc assets from ./dist; an empty SPA stub is enough for ASSETS.
const dir = join(process.cwd(), "dist");
if (!existsSync(join(dir, "index.html"))) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><body></body></html>\n");
}
