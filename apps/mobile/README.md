# heyflare mobile (Expo)

Native iOS/Android client using **Expo SDK 56**, **Expo Router**, and React Native. Talks to your heyflare Worker over HTTPS — not a WKWebView wrapper.

## Status

Daily-driver mail surface for TestFlight / production builds:

- **Tabs:** Imbox · Feed · Calendar · Screener · More (SF Symbol / Material icons + count badges)
- **Mail:** compose/reply, trays, search, screener, bundles, power-through, assistant (SSE)
- **Auth:** server URL, login, MFA, Bearer `session_token` in Secure Store
- **Gmail:** Connect via system auth session → Worker handoff → `heyflare://oauth-complete`
- **Push:** Expo Push → APNs/FCM; device tokens registered at `POST /api/push/devices`

Still thinner than the web app: contacts/clips/collections/files library UIs, full calendar day editor, deep Settings (2FA enroll / AI keys / domains).

## Requirements

- Node 20+
- Apple Developer account (TestFlight) and/or Google Play
- Expo account (`npx eas-cli login`)
- A **deployed** heyflare Worker (with migration `0022_device_tokens.sql`) that returns `session_token` for `X-Heyflare-Client: mobile`
- Google OAuth redirect still `https://YOUR_HOST/auth/google/callback` (same as web)

## Local (Expo Go / simulator)

```sh
cd apps/mobile
npm install
npm run ios
```

Point the app at your Worker URL and sign in. Push notifications **do not** work in Expo Go / simulators — use an EAS build on a physical device.

### Optional default server

```sh
EXPO_PUBLIC_DEFAULT_SERVER=https://mail.example.com npm run ios
```

## TestFlight / production (EAS)

### 1. One-time project setup

```sh
cd apps/mobile
npx eas-cli login
npx eas-cli init          # writes extra.eas.projectId — set EAS_PROJECT_ID in CI or paste into app.config.ts env
npx eas-cli build:configure
```

After `eas init`, either export `EAS_PROJECT_ID=<uuid>` when building, or put the id in your shell profile / EAS secrets so `app.config.ts` picks it up.

### 2. Apple credentials + push

```sh
npx eas-cli credentials   # create/select App Store distribution + Push Key for app.heyflare.mobile
```

Confirm App ID `app.heyflare.mobile` has **Push Notifications** enabled in the Apple Developer portal.

### 3. Build & submit

```sh
# Internal TestFlight-ready store build
npm run build:ios

# Or production channel
npm run build:ios:prod

# Submit the latest build to App Store Connect / TestFlight
npm run submit:ios
```

In App Store Connect: create the app if needed, complete the privacy questionnaire (mail / user content), then add testers under TestFlight.

### 4. Worker deploy

Deploy the Worker so migration `0022` and `/api/push/devices` are live. Optional secret for higher Expo Push rate limits:

```sh
npx wrangler secret put EXPO_ACCESS_TOKEN
```

(Create a token in [expo.dev](https://expo.dev) → Access tokens.)

## Auth

Native clients send `X-Heyflare-Client: mobile` on login. The Worker returns a `session_token` stored in **Secure Store** and sent as `Authorization: Bearer …` on `/api/*`. Account scope is sent as `X-Account-Id` (`all` or a specific account id).

## Push flow

1. App requests notification permission and obtains an **Expo push token**.
2. App `POST /api/push/devices` with `{ token, platform, device_name }`.
3. On new Imbox / Reply Later mail, the Worker calls Expo’s push API (alongside existing Web Push).
4. Tapping a notification opens `/thread/:id`.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm start` / `ios` / `android` | Dev |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build:ios` | EAS preview (store) build |
| `npm run build:ios:prod` | EAS production build |
| `npm run submit:ios` | Submit latest iOS build to ASC |
