/* heyflare service worker — Web Push (Android / desktop PWA). iOS WKWebView is not supported. */
self.addEventListener("push", (event) => {
  const title = "New mail";
  const options = {
    body: "Something new landed in your Imbox",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    data: { url: "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
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
