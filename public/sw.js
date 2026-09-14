/* heyflare service worker — installable PWA + Web Push (desktop, Android, iOS Home Screen). */
const SW_VERSION = "heyflare-sw-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

async function setBadge(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  try {
    if (n > 0 && self.navigator?.setAppBadge) await self.navigator.setAppBadge(n);
    else if (n <= 0 && self.navigator?.clearAppBadge) await self.navigator.clearAppBadge();
  } catch {
    /* Badging API unavailable or permission missing */
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let title = "New mail";
      let body = "Something new landed in your Imbox";
      let data = { url: "/" };
      let badge = 1;
      try {
        if (event.data) {
          const raw = event.data.json();
          if (raw && typeof raw === "object") {
            if (typeof raw.title === "string" && raw.title) title = raw.title;
            if (typeof raw.body === "string" && raw.body) body = raw.body;
            if (typeof raw.badge === "number") badge = raw.badge;
            else if (typeof raw.badge === "string" && raw.badge) badge = Number(raw.badge) || 1;
            if (raw.data && typeof raw.data === "object") {
              data = { ...data, ...raw.data };
              if (raw.data.badge != null && typeof raw.badge !== "number") {
                badge = Number(raw.data.badge) || badge;
              }
            }
          }
        }
      } catch {
        try {
          const text = event.data?.text?.();
          if (text) body = text;
        } catch {
          /* keep defaults */
        }
      }
      await setBadge(badge);
      await self.registration.showNotification(title, {
        body,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        data,
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      // Opening the app — leave the badge; the page will sync the real unread count.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clients) {
        if ("focus" in c) {
          c.navigate?.(url);
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })()
  );
});

void SW_VERSION;
