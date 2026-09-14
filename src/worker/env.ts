import type { UserRow, AccountRow } from "./db";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Public origin, e.g. https://mail.example.com. Optional: falls back to the request origin. */
  APP_URL?: string;
  APP_NAME: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  /** Cloudflare API token (Zone:Read, Email Routing Settings:Edit, Email Routing Rules:Edit) for automatic domain setup. */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /** Name of this Worker script (target of the Email Routing catch-all rule). */
  WORKER_NAME?: string;
  /** Resend API key: outbound fallback for custom-domain mailboxes. */
  RESEND_API_KEY?: string;
  /** Cloudflare Email Sending binding (`send_email`), when enabled on the account. */
  EMAIL?: { send(msg: any): Promise<any> };
  /** Workers AI binding — spam triage + assistant (via workers-ai-provider). */
  AI?: Ai;
  /** Per-account sync coordinator (Phase 2). */
  SYNC_ACTOR?: DurableObjectNamespace<import("./sync-actor").SyncActor>;
  /** Think-based email assistant (one DO instance per conversation). */
  AssistantAgent?: DurableObjectNamespace<import("./ai/assistant-agent").AssistantAgent>;
  /** Shared secret for Pub/Sub push verification (`?token=` or Bearer). */
  PUBSUB_VERIFICATION_TOKEN?: string;
  /** Gmail users.watch topic, e.g. `projects/my-proj/topics/heyflare-mail`. */
  GMAIL_PUBSUB_TOPIC?: string;
  /** Web Push VAPID keys. Public = base64url uncompressed P-256; private = JWK `d` (scripts/gen-vapid.mjs). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Large domain-mail attachment blobs (Phase 6). */
  ATTACHMENTS?: R2Bucket;
}

export type Variables = {
  user: UserRow;
  /** Primary account: the specific one when `X-Account-Id` names one, else the user's first account. Null only when the user has no accounts (routes then 400). */
  account: AccountRow | null;
  /** Account ids in scope for list/count queries: `[id]` for a specific account, all of the user's ids for unified scope. */
  accountIds: string[];
  /** Every account id the user owns, regardless of the requested scope (ownership checks for cross-account labels/collections). */
  allAccountIds: string[];
};

export type AppEnv = { Bindings: Env; Variables: Variables };
