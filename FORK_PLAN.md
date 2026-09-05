# heyflare fork — full implementation plan (post–Phase 0)

**Repo:** `harshil1712/heyflare` (fork of `doable-team/heyflare`)  
**Remotes:** `origin` = your fork; `upstream` = `doable-team/heyflare`  
**Status:** Phase 0–1 complete. Start at **Phase 2**.

Work on `main` unless told otherwise. Commit and push to `origin` after each phase’s done-when is green. Prefer upstreamable shape for Phases 1–2; treat Phase 3+ as fork identity (cherry-pick upstream after that, don’t promise forever-rebase).

Do **not** ask which stack or which phase to do next — follow this order. Do **not** invent multi-tenancy, IMAP, agent-framework swaps, or per-email Durable Objects.

---

## North star

Self-hosted HEY-style mail on Cloudflare, fixed for daily use then opened to agents:

| Itch | Phase that addresses it |
|------|-------------------------|
| Search worse than Gmail | 1 — FTS5 |
| ≤60s mail latency | 2 — Gmail Pub/Sub + SyncActor |
| Agent locked in product UI | 3 — MCP |
| Phone can’t notify | 4 — Web Push |
| Agent quality | 5 — loop upgrades |
| DB / attachment growth | 6 — R2 + retention |

---

## Authoritative codebase map

Use these names (verify in-tree if anything drifted after Phase 0):

| Area | Location / symbols |
|------|-------------------|
| Ingest | `src/worker/sync.ts` — `ingestParsed`, `ingestMessages` |
| Inbound | `src/worker/inbound.ts` — `resolveMailbox`, `parseInbound`, `deliverInbound`, `handleInboundEmail` |
| Search (today) | FTS5 + LIKE fallback (Phase 1) |
| Bundles | `assignBundles` in `src/worker/db.ts` |
| AI | `src/worker/ai/` — `MockProvider`, `AI_MOCK=1`, `runChatTurn`, `runTool`, `TOOLS` |
| Tools | `search_mail`, `list_threads`, `read_thread`, `list_screener`, `screen_sender`, `create_draft`, `send_draft`, … |
| Auth | `/auth/*` — `src/worker/routes/auth.ts` |
| Migrations | `migrations/*.sql` + register in `src/worker/migrations.ts` (`MIGRATIONS`, `ensureMigrations`, `runMigrations`) |
| Env | `DB`, `ASSETS`, `APP_NAME`, `AI_MOCK`, `SESSION_SECRET`, … |
| Buckets | `screener \| imbox \| feed \| paper_trail \| screened_out \| trash` |
| Screen | `pending \| imbox \| feed \| paper_trail \| screened_out` |
| Tests | `test/` + `vitest.config.ts` — extend these; keep CI green |

Every new migration SQL file **must** be imported into `MIGRATIONS` in `migrations.ts`.

---

## Phase 1 — FTS5 search (done)

**Why first:** Biggest daily-value-per-day; upstreamable; safe with Phase 0 harness.

**Shipped:**

- Trigram tokenizer confirmed available in D1.
- Migration `0017_fts5.sql`: empty `threads_fts` / `messages_fts` virtual tables (`tokenize='trigram'`), SQLite triggers on `threads` / `messages` AFTER INSERT/UPDATE/DELETE.
- Batched FTS backfill (not a giant migration `INSERT … SELECT`) for lived-in DBs.
- Search routes + `search_mail`: `bm25()` ranking, `snippet()` highlights, **LIKE fallback** for very short / no-letter queries.
- Tests cover body-word hits, ranking, short-query fallback, and trigger sync.

### Upstream

Open/keep as PR-shaped commits against upstream style — FTS5 + tests are merge candidates.

---

## Phase 2 — Gmail Pub/Sub + per-account SyncActor

**Why:** Realtime Imbox; one DO per **account** (not per email).

### Implement

1. **Google:** Pub/Sub API on existing OAuth project; topic + push subscription → `https://<host>/pubsub/push` with bearer token. `users.watch` with existing `gmail.modify` (no new consent if scope already granted).
2. **Worker** `POST /pubsub/push`: verify token; decode `{ historyId, emailAddress }`; map to account; wake SyncActor.
3. **`SyncActor` DO** (`src/worker/sync-actor.ts` or similar):
   - One DO id per account id.
   - Serialize concurrent triggers (push + cron + sync-on-focus) — replace the race the ~10‑min flag-lock papers over.
   - Cache OAuth access token in memory (~55 min TTL); **cold wake must refresh** (assume eviction).
   - Alarm-based backoff on errors.
4. **History sync correctness (do not skip):**
   - Incremental `history.list` from stored `historyId`.
   - Invalid/expired `historyId` → full resync fallback path.
   - Push storms / duplicate notifications → still one logical sync (assert via `sync_log` or equivalent).
   - Watch renewal before 7-day expiry.
5. **Cron demoted to sweeper:** renew watches, catch missed pushes, heartbeat — not the primary ingest path.
6. **Tests:** concurrent double-trigger → single sync; invalid historyId recovery; token refresh on cold DO (mock Google where needed).

### Done when

- New mail appears in Imbox in seconds under push (document manual Google setup in README).
- Hammering two sync triggers → one sync in logs.
- Quiet-minute cron D1 reads near zero vs pre-change.
- Tests + check green; commit + push.

### Docs

README: Pub/Sub setup, push URL, secret, OAuth project steps.

---

## Phase 3 — MCP server (fork identity)

**Why:** Mail as an MCP surface for agents. After this, prefer **cherry-pick from upstream**, not continuous rebase.

### Implement

1. **Streamable HTTP MCP** at `/mcp` on the same Hono app (new route module).
2. **Auth:** session cookies won’t work for agents.
   - `api_tokens` table (hash at rest, label, scopes, created/revoked).
   - Settings UI: mint / revoke tokens.
   - Bearer auth on `/mcp`.
3. **Tools:** default **read-only** set: `search_mail`, `list_threads`, `read_thread`, `list_screener`, `find_contact`, `list_memory` (match exact `TOOLS` names in-repo).
   - Settings flag opts into **write** tools (`screen_sender`, `create_draft`, `send_draft`, etc.).
   - Reuse `runTool(ctx, name, input)` — transport-independent.
4. **Scope:** token carries account scope (all vs one); reuse existing `X-Account-Id` / account scoping logic.
5. **Tests:** read-only token cannot call `screen_sender`; bearer required; happy-path tool list + one search via MCP handler unit/integration test.

### Done when

- An MCP client (Claude Desktop / `pi` / similar) can answer “what’s new for me today” against a seeded Imbox in tests or documented manual check.
- Read-only token denied on write tools.
- Tests + check green; commit + push.
- Note in README: fork diverges here; upstream tracking = selective cherry-pick.

---

## Phase 4 — Web Push notifications

### Implement

1. VAPID keypair as Worker secrets; `push_subscriptions` table; service worker under `public/` (or existing static asset path).
2. Fire from ingest path when a new thread lands in `imbox` (and `reply_later` if product-equivalent exists — match HEY trays in this app: imbox/ reply-later analogues).
3. Dedupe per thread + cooldown.
4. VAPID JWT via WebCrypto (or workers-compatible lib, keep dependency thin).
5. Unsubscribe honored.
6. **Honest limitation (document):** browser/PWA + Android. iOS Tauri/WKWebView ≠ Web Push; keep in-app polling or accept gap (no APNs unless explicitly scoped later).

### Done when

- New Imbox mail produces a notification within sync latency on Android/desktop PWA (manual or automated where feasible).
- Unsubscribe stops further pushes.
- Tests for subscription CRUD + “would notify” gating; check green; commit + push.

---

## Phase 5 — Agent loop upgrades

All in `src/worker/ai/chat.ts` + `provider.ts` (and tests with `MockProvider`):

1. **Parallel tool execution** for **read-only** tools only (`Promise.all`). Serialize writes (`create_draft`, `send_draft`, `screen_sender`, mutations). Explicit whitelist.
2. **Retry with backoff** on 429/5xx from the LLM provider.
3. **History compaction:** chars/4 token proxy; summarize oldest turns over threshold; keep last N verbatim.
4. Extend **cache_control** to the tools prefix where the Anthropic path supports it.
5. **Tests:** MockProvider covers parallel reads + compaction; no write tools run concurrently in the same turn.

### Done when

- Mock tests cover parallel + compaction.
- Long conversation doesn’t blow context in a documented manual check.
- Check + test green; commit + push.

---

## Phase 6 — R2 tiering + retention

1. `r2_buckets` binding; domain-mail attachment blobs **>900 KB** → R2 with D1 pointer; serve route streams from R2.
2. **Lazy migration:** copy-on-read for old large blobs still in D1.
3. Retention settings (Paper Trail / Trash age) + cron sweep.
4. Document: D1 doesn’t shrink after deletes; Time Travel = recovery; rebuild script = nuclear option.
5. Tests: pointer + R2 get path (miniflare R2); retention deletes eligible rows.

### Done when

- ~5 MB attachment on a domain mailbox is retrievable via the app path.
- Retention sweep covered by test.
- Check + test green; commit + push; README updated.

---

## Cross-cutting rules

1. **Always:** extend Vitest coverage for new money paths; keep CI green before calling a phase done.
2. **Migrations:** SQL file + `migrations.ts` registration + backfill strategy that won’t timeout D1.
3. **Secrets:** never commit VAPID private keys, Pub/Sub verification secrets, API tokens; use wrangler secrets + `.dev.vars.example` placeholders.
4. **Upstream:** Phases 1–2 aim PR-friendly. Phase 3+ = fork; cherry-pick upstream fixes.
5. **No scope creep:** no IMAP, no multi-tenant, no Agents SDK rewrite, no per-email DOs.
6. **Rename / branding:** only if the user asks; not required for Phases 1–6.

---

## Suggested local agent prompt (paste once)

```text
Read FORK_PLAN.md (or LOCAL_AGENT_PLAN.md) in the repo root.
Phase 0–1 are done. Implement the remaining phases in order (2→6).
After each phase: npm test && npm run check, commit, push to origin.
Do not skip Phase 2 history-recovery work. Do not parallelize write tools in Phase 5.
Stop after Phase 6 and summarize what shipped vs deferred.
```

---

## Quick status checklist

- [x] Phase 0 — harness, CI, login rate limit  
- [x] Phase 1 — FTS5  
- [ ] Phase 2 — Pub/Sub + SyncActor  
- [ ] Phase 3 — MCP + API tokens  
- [ ] Phase 4 — Web Push  
- [ ] Phase 5 — agent loop  
- [ ] Phase 6 — R2 + retention
