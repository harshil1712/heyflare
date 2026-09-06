# heyflare mobile (Expo)

Native iOS/Android client using **Expo SDK 56**, **Expo Router**, and **Expo UI** (`@expo/ui` → SwiftUI / Jetpack Compose). Talks to your heyflare Worker over HTTPS — not a WKWebView wrapper.

## Status

Vertical slice:

1. Enter Worker URL  
2. Sign in (password + optional 2FA)  
3. Imbox list  
4. Open thread (plain text bodies)  
5. Settings / sign out  

Not yet: Feed / Screener / compose / assistant / APNs.

The older Tauri WKWebView shell remains in `apps/ios` until this app replaces it.

## Requirements

- Node 20+
- Xcode 15+ (iOS) and/or Android Studio
- A deployed heyflare Worker (this app needs the Worker that returns `session_token` for `X-Heyflare-Client: mobile`)

## Run

```sh
cd apps/mobile
npm install
npm run ios      # or: npm start
```

Point the app at your Worker URL (e.g. `https://your-worker.workers.dev`). Sign in with the same owner account as the web app.

## Auth

Native clients send `X-Heyflare-Client: mobile` on login. The Worker returns a `session_token` stored in **Secure Store** and sent as `Authorization: Bearer …` on `/api/*` (same session table as cookies).

## Layout

```
src/app/(auth)/   server, login, mfa
src/app/(app)/    imbox, settings
src/app/thread/   thread detail
src/lib/          api, session, auth
```
