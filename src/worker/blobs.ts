// Domain-mail attachment blobs: small ones stay in D1; >900 KB go to R2 with a D1 pointer.
// Lazy copy-on-read migrates old large D1 blobs. Retention sweep deletes aged Paper Trail / Trash.
import type { Env } from "./env";
import type { AttachmentRow } from "./db";
import { now, placeholders } from "./db";

/** Bytes above this size are stored in R2 (when the ATTACHMENTS binding exists). */
export const R2_THRESHOLD = 900 * 1024;

export function attachmentR2Key(accountId: string, attachmentId: string): string {
  return `att/${accountId}/${attachmentId}`;
}

export function normalizeBlob(raw: unknown): Uint8Array | null {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  return null;
}

/** Decide where to put a new domain-mail blob. Caller inserts the attachment row with `r2_key` when set. */
export async function putAttachmentBlob(
  env: Env,
  accountId: string,
  attachmentId: string,
  data: Uint8Array | ArrayBuffer
): Promise<{ r2Key: string | null; storeInD1: boolean }> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength > R2_THRESHOLD && env.ATTACHMENTS) {
    const key = attachmentR2Key(accountId, attachmentId);
    await env.ATTACHMENTS.put(key, bytes);
    return { r2Key: key, storeInD1: false };
  }
  return { r2Key: null, storeInD1: true };
}

/**
 * Load attachment bytes for the serve path. If a large blob is still only in D1, copy it to R2
 * (when bound) and drop the D1 row — lazy migration for pre-tiered mail.
 */
export async function loadAttachmentBytes(env: Env, att: AttachmentRow & { r2_key?: string | null }): Promise<Uint8Array | null> {
  const db = env.DB;
  if (att.r2_key && env.ATTACHMENTS) {
    const obj = await env.ATTACHMENTS.get(att.r2_key);
    if (obj) return new Uint8Array(await obj.arrayBuffer());
  }

  const row = await db.prepare(`SELECT data FROM attachment_blobs WHERE attachment_id = ?`).bind(att.id).first<{ data: unknown }>();
  const bytes = normalizeBlob(row?.data);
  if (!bytes) return null;

  if (bytes.byteLength > R2_THRESHOLD && env.ATTACHMENTS) {
    const key = att.r2_key || attachmentR2Key(att.account_id, att.id);
    try {
      await env.ATTACHMENTS.put(key, bytes);
      await db.batch([
        db.prepare(`UPDATE attachments SET r2_key = ? WHERE id = ?`).bind(key, att.id),
        db.prepare(`DELETE FROM attachment_blobs WHERE attachment_id = ?`).bind(att.id),
      ]);
    } catch {
      // Still serve from D1 if migration fails.
    }
  }
  return bytes;
}

/** Best-effort R2 deletes for attachment keys (account wipe / retention). */
export async function deleteR2Keys(env: Env, keys: string[]): Promise<void> {
  if (!env.ATTACHMENTS || !keys.length) return;
  await Promise.all(keys.map((k) => env.ATTACHMENTS!.delete(k).catch(() => {})));
}

export type RetentionSettings = {
  paperTrailRetentionDays: number; // 0 = keep forever
  trashRetentionDays: number; // 0 = keep forever
};

export function retentionFromSettingsJson(json: string | null | undefined): RetentionSettings {
  let s: { paperTrailRetentionDays?: number; trashRetentionDays?: number } = {};
  try {
    s = JSON.parse(json || "{}") as typeof s;
  } catch {
    /* ignore */
  }
  return {
    paperTrailRetentionDays: Math.max(0, Math.min(3650, Number(s.paperTrailRetentionDays) || 0)),
    trashRetentionDays: Math.max(0, Math.min(3650, Number(s.trashRetentionDays) || 0)),
  };
}

/** Delete messages/attachments/threads for aged Paper Trail and Trash buckets. */
export async function sweepRetention(env: Env): Promise<{ deletedThreads: number }> {
  const db = env.DB;
  const users = await db.prepare(`SELECT id, settings_json FROM users`).all<{ id: string; settings_json: string }>();
  let deletedThreads = 0;
  const t = now();

  for (const u of users.results) {
    const ret = retentionFromSettingsJson(u.settings_json);
    const jobs: { bucket: "paper_trail" | "trash"; days: number }[] = [];
    if (ret.paperTrailRetentionDays > 0) jobs.push({ bucket: "paper_trail", days: ret.paperTrailRetentionDays });
    if (ret.trashRetentionDays > 0) jobs.push({ bucket: "trash", days: ret.trashRetentionDays });
    if (!jobs.length) continue;

    for (const job of jobs) {
      const cutoff = t - job.days * 86_400_000;
      const threads = await db
        .prepare(
          `SELECT t.id FROM threads t
           JOIN accounts a ON a.id = t.account_id
           WHERE a.user_id = ? AND t.bucket = ? AND t.last_message_at < ? AND t.merged_into IS NULL
           LIMIT 50`
        )
        .bind(u.id, job.bucket, cutoff)
        .all<{ id: string }>();
      if (!threads.results.length) continue;
      deletedThreads += await deleteThreadsCascade(env, threads.results.map((r) => r.id));
    }
  }
  return { deletedThreads };
}

export async function deleteThreadsCascade(env: Env, threadIds: string[]): Promise<number> {
  if (!threadIds.length) return 0;
  const db = env.DB;
  const ph = placeholders(threadIds.length);

  const atts = await db
    .prepare(`SELECT id, r2_key FROM attachments WHERE thread_id IN (${ph})`)
    .bind(...threadIds)
    .all<{ id: string; r2_key: string | null }>();
  const r2Keys = atts.results.map((a) => a.r2_key).filter((k): k is string => !!k);
  await deleteR2Keys(env, r2Keys);

  await db.batch([
    db.prepare(`DELETE FROM thread_labels WHERE thread_id IN (${ph})`).bind(...threadIds),
    db.prepare(`DELETE FROM collection_threads WHERE thread_id IN (${ph})`).bind(...threadIds),
    db.prepare(`DELETE FROM attachment_blobs WHERE attachment_id IN (SELECT id FROM attachments WHERE thread_id IN (${ph}))`).bind(...threadIds),
    db.prepare(`DELETE FROM attachments WHERE thread_id IN (${ph})`).bind(...threadIds),
    db.prepare(`DELETE FROM messages WHERE thread_id IN (${ph})`).bind(...threadIds),
    db.prepare(`DELETE FROM threads WHERE id IN (${ph})`).bind(...threadIds),
  ]);
  return threadIds.length;
}
