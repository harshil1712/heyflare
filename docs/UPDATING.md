# Updating heyflare

Updating replaces code, never your mail. This page covers what changes, how to update on each setup,
and how to go back if something looks wrong.

## What an update changes

**Replaced:** the Worker code (API, sync, AI, inbound mail) and the static assets of the web app.

**Never touched:** your D1 database — mail, threads, contacts, screener decisions, labels, collections,
clips, notes, drafts, bundles, settings, two-factor secrets, AI provider keys and AI memory. Your Worker
secrets (Google OAuth, `CF_API_TOKEN`, `RESEND_API_KEY`, the session secret) live in Cloudflare and
survive deploys too, so nobody gets logged out and no account needs reconnecting.

Database changes ship as migrations that run themselves on the first request after a deploy — there is no
manual `db:migrate` step. Migrations only add tables and columns, so existing rows are kept as they are.

## Update your server

### Cloned the repo

```sh
git pull && npm run deploy
```

### Forked it, with Cloudflare Workers Builds

Merge upstream and push; Cloudflare deploys the result.

```sh
git remote add upstream https://github.com/doable-team/heyflare   # first time only
git fetch upstream
git merge upstream/main
git push
```

## Which version am I running?

- The sidebar shows an **Update available** row when a newer release exists.
- `https://your-host/api/version` returns the version, the commit it was built from, and the build time.

## Rolling back

Cloudflare keeps previous deployments, so the fastest way back is:

```sh
npx wrangler rollback -c wrangler.local.jsonc
```

Or open the Worker in the Cloudflare dashboard, go to **Deployments**, and roll back to an earlier one.

To deploy a specific older version from source:

```sh
git checkout v0.1.0
npm run deploy
git checkout main
```

Rolling back the code does not roll back the database. Since migrations only add things, an older build
keeps working against a newer database.

## If something looks wrong

- **Old UI after updating** — the browser cached the assets. Hard-refresh with `⌘⇧R` (`Ctrl+Shift+R` on Windows/Linux).
- **Errors after a deploy** — check the live logs: `npx wrangler tail -c wrangler.local.jsonc`, or the
  Worker's **Logs** tab in the dashboard.
- **A deploy half-finished** — run the deploy command again. Deploys replace the whole Worker, so a repeat
  run is safe.
- **Gmail disconnected or AI key missing** — that is not the update. Secrets live in Worker secrets and D1
  and are untouched; reconnect from **Settings → Accounts** or re-enter the key in **Settings → AI**.
- **Still stuck** — roll back with the command above, then open an issue with what
  `/api/version` reports.
