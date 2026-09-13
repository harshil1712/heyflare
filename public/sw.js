/* heyflare service worker — installable PWA + Web Push (desktop, Android, iOS Home Screen). */
const SW_VERSION = "heyflare-sw-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let title = "New mail";
      let body = "Something new landed in your Imbox";
      let data = { url: "/" };
      try {
        if (event.data) {
          const raw = event.data.json();
          if (raw && typeof raw === "object") {
            if (typeof raw.title === "string" && raw.title) title = raw.title;
            if (typeof raw.body === "string" && raw.body) body = raw.body;
            if (raw.data && typeof raw.data === "object") data = { ...data, ...raw.data };
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
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) {
          c.navigate?.(url);
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// Keep the SW file referenced so bundlers/CDNs don't drop it; version bumps on deploy.
void SW_VERSION;
