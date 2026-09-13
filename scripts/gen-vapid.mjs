#!/usr/bin/env node
/**
 * Generate VAPID keys for heyflare Web Push.
 * Public: base64url uncompressed P-256 point (applicationServerKey).
 * Private: JWK `d` (base64url) — required by @block65/webcrypto-web-push.
 */
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });

function b64urlToBuf(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from((s + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

const uncompressed = Buffer.concat([Buffer.from([0x04]), b64urlToBuf(jwk.x), b64urlToBuf(jwk.y)]);
const publicKey = uncompressed.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const privateKeyD = jwk.d;

console.log("VAPID_PUBLIC_KEY=" + publicKey);
console.log("VAPID_PRIVATE_KEY=" + privateKeyD);
console.log("VAPID_SUBJECT=mailto:you@example.com");
console.log("");
console.log("# Set on the Worker (example):");
console.log("#   printf %s \"$VAPID_PUBLIC_KEY\" | npx wrangler secret put VAPID_PUBLIC_KEY -c wrangler.local.jsonc");
console.log("#   printf %s \"$VAPID_PRIVATE_KEY\" | npx wrangler secret put VAPID_PRIVATE_KEY -c wrangler.local.jsonc");
console.log("#   printf %s 'mailto:you@example.com' | npx wrangler secret put VAPID_SUBJECT -c wrangler.local.jsonc");
