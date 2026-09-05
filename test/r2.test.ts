import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  R2_THRESHOLD,
  putAttachmentBlob,
  loadAttachmentBytes,
  sweepRetention,
  attachmentR2Key,
} from "../src/worker/blobs";
import { ingestParsed } from "../src/worker/sync";
import { seedAccount, seedUser, makeParsed, addr, testEnv } from "./helpers";
import type { AttachmentRow } from "../src/worker/db";

describe("R2 attachment tiering", () => {
  it("stores large domain blobs in R2 and serves via loadAttachmentBytes", async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id, { provider: "domain", email: "you@example.com" });
    const big = new Uint8Array(R2_THRESHOLD + 1024);
    big.fill(7);

    const placed = await putAttachmentBlob(testEnv(), account.id, "att-big", big);
    expect(placed.r2Key).toBe(attachmentR2Key(account.id, "att-big"));
    expect(placed.storeInD1).toBe(false);
    expect(env.ATTACHMENTS).toBeTruthy();
    const obj = await env.ATTACHMENTS!.get(placed.r2Key!);
    expect(obj).toBeTruthy();
    expect((await obj!.arrayBuffer()).byteLength).toBe(big.byteLength);

    const t = Date.now();
    await env.DB.prepare(
      `INSERT INTO threads (id, account_id, gmail_thread_id, subject, custom_subject, snippet, bucket, seen, unread, reply_later, reply_later_at, set_aside, set_aside_at, bubble_up_at, bubbled, merged_into, note, has_attachments, trackers_blocked, participants_json, last_from_email, last_from_name, message_count, first_message_at, last_message_at, is_sent_only, created_at, updated_at)
       VALUES ('th1', ?, 'th1', 'Big', NULL, '', 'imbox', 1, 0, 0, NULL, 0, NULL, NULL, 0, NULL, '', 1, 0, '[]', 'a@gmail.com', '', 1, ?, ?, 0, ?, ?)`
    )
      .bind(account.id, t, t, t, t)
      .run();
    await env.DB.prepare(
      `INSERT INTO messages (id, account_id, thread_id, gmail_message_id, from_email, from_name, to_json, cc_json, bcc_json, reply_to, subject, date, snippet, text_body, html_body, is_from_me, unread, message_id_header, in_reply_to, references_header, list_unsubscribe, gmail_labels_json, has_attachments, trackers_json, size_estimate, created_at)
       VALUES ('m1', ?, 'th1', 'gm1', 'a@gmail.com', '', '[]', '[]', '[]', '', 'Big', ?, '', '', '', 0, 0, '<x@y>', '', '', '', '[]', 1, '[]', ?, ?)`
    )
      .bind(account.id, t, big.byteLength, t)
      .run();
    await env.DB.prepare(
      `INSERT INTO attachments (id, account_id, message_id, thread_id, gmail_attachment_id, filename, mime_type, size, content_id, is_inline, created_at, r2_key)
       VALUES ('att-big', ?, 'm1', 'th1', 'local', 'big.bin', 'application/octet-stream', ?, '', 0, ?, ?)`
    )
      .bind(account.id, big.byteLength, t, placed.r2Key)
      .run();

    const att = (await env.DB.prepare(`SELECT * FROM attachments WHERE id = ?`).bind("att-big").first<AttachmentRow>())!;
    const loaded = await loadAttachmentBytes(testEnv(), att);
    expect(loaded?.byteLength).toBe(big.byteLength);
  });

  it("lazy-migrates large D1 blobs to R2 on read", async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id, { provider: "domain" });
    const big = new Uint8Array(R2_THRESHOLD + 64);
    big.fill(9);
    const t = Date.now();
    await env.DB.prepare(
      `INSERT INTO threads (id, account_id, gmail_thread_id, subject, custom_subject, snippet, bucket, seen, unread, reply_later, reply_later_at, set_aside, set_aside_at, bubble_up_at, bubbled, merged_into, note, has_attachments, trackers_blocked, participants_json, last_from_email, last_from_name, message_count, first_message_at, last_message_at, is_sent_only, created_at, updated_at)
       VALUES ('th2', ?, 'th2', 'Old', NULL, '', 'imbox', 1, 0, 0, NULL, 0, NULL, NULL, 0, NULL, '', 1, 0, '[]', 'a@gmail.com', '', 1, ?, ?, 0, ?, ?)`
    )
      .bind(account.id, t, t, t, t)
      .run();
    await env.DB.prepare(
      `INSERT INTO messages (id, account_id, thread_id, gmail_message_id, from_email, from_name, to_json, cc_json, bcc_json, reply_to, subject, date, snippet, text_body, html_body, is_from_me, unread, message_id_header, in_reply_to, references_header, list_unsubscribe, gmail_labels_json, has_attachments, trackers_json, size_estimate, created_at)
       VALUES ('m2', ?, 'th2', 'gm2', 'a@gmail.com', '', '[]', '[]', '[]', '', 'Old', ?, '', '', '', 0, 0, '<x2@y>', '', '', '', '[]', 1, '[]', ?, ?)`
    )
      .bind(account.id, t, big.byteLength, t)
      .run();
    await env.DB.prepare(
      `INSERT INTO attachments (id, account_id, message_id, thread_id, gmail_attachment_id, filename, mime_type, size, content_id, is_inline, created_at, r2_key)
       VALUES ('att-old', ?, 'm2', 'th2', 'local', 'old.bin', 'application/octet-stream', ?, '', 0, ?, NULL)`
    )
      .bind(account.id, big.byteLength, t)
      .run();
    await env.DB.prepare(`INSERT INTO attachment_blobs (attachment_id, data, created_at) VALUES (?, ?, ?)`).bind("att-old", big, t).run();

    const att = (await env.DB.prepare(`SELECT * FROM attachments WHERE id = ?`).bind("att-old").first<AttachmentRow>())!;
    const loaded = await loadAttachmentBytes(testEnv(), att);
    expect(loaded?.byteLength).toBe(big.byteLength);
    const after = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE id = ?`).bind("att-old").first<{ r2_key: string }>();
    expect(after?.r2_key).toBeTruthy();
    const d1 = await env.DB.prepare(`SELECT 1 AS n FROM attachment_blobs WHERE attachment_id = ?`).bind("att-old").first();
    expect(d1).toBeNull();
  });

  it("ingestParsed tiers large attachments for domain accounts", async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id, { provider: "domain", email: "box@example.com" });
    const big = new Uint8Array(R2_THRESHOLD + 8);
    big.fill(3);
    const parsed = makeParsed({
      gmailId: `dom-${crypto.randomUUID()}`,
      threadId: `th-${crypto.randomUUID()}`,
      from: addr("friend@gmail.com", "Friend"),
      to: [addr(account.email)],
      subject: "Has big file",
      attachments: [
        {
          attachmentId: "part-1",
          filename: "huge.bin",
          mimeType: "application/octet-stream",
          size: big.byteLength,
          contentId: "",
          isInline: false,
          blob: big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength) as ArrayBuffer,
        },
      ],
    });
    const r = await ingestParsed(testEnv(), account, [parsed]);
    expect(r.added).toBe(1);
    const att = await env.DB.prepare(`SELECT * FROM attachments WHERE account_id = ?`).bind(account.id).first<AttachmentRow>();
    expect(att?.r2_key).toBeTruthy();
    const blob = await env.DB.prepare(`SELECT 1 AS n FROM attachment_blobs WHERE attachment_id = ?`).bind(att!.id).first();
    expect(blob).toBeNull();
  });

  it("retention sweep deletes aged trash threads", async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id, { provider: "domain" });
    const old = Date.now() - 40 * 86_400_000;
    await env.DB.prepare(`UPDATE users SET settings_json = ? WHERE id = ?`)
      .bind(JSON.stringify({ trashRetentionDays: 30 }), user.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO threads (id, account_id, gmail_thread_id, subject, custom_subject, snippet, bucket, seen, unread, reply_later, reply_later_at, set_aside, set_aside_at, bubble_up_at, bubbled, merged_into, note, has_attachments, trackers_blocked, participants_json, last_from_email, last_from_name, message_count, first_message_at, last_message_at, is_sent_only, created_at, updated_at)
       VALUES ('th-trash', ?, 'gt', 'Gone', NULL, '', 'trash', 1, 0, 0, NULL, 0, NULL, NULL, 0, NULL, '', 0, 0, '[]', 'a@gmail.com', '', 1, ?, ?, 0, ?, ?)`
    )
      .bind(account.id, old, old, old, old)
      .run();
    const r = await sweepRetention(testEnv());
    expect(r.deletedThreads).toBeGreaterThanOrEqual(1);
    const left = await env.DB.prepare(`SELECT id FROM threads WHERE id = 'th-trash'`).first();
    expect(left).toBeNull();
  });
});
