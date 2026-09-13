import { api } from "../api";

const SW_URL = "/sw.js";

export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

export function webPushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** iOS Safari only grants Web Push inside an installed Home Screen PWA. */
export function webPushNeedsInstall(): boolean {
  if (!webPushSupported()) return false;
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && !isStandaloneDisplay();
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function toB64Url(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type WebPushUiState =
  | "unsupported"
  | "needs_install"
  | "unconfigured"
  | "denied"
  | "off"
  | "on"
  | "loading";

export async function getWebPushState(): Promise<WebPushUiState> {
  if (!webPushSupported()) return "unsupported";
  if (webPushNeedsInstall()) return "needs_install";
  if (Notification.permission === "denied") return "denied";

  const cfg = await api.get<{ configured: boolean; publicKey: string | null }>("/api/push/vapid-public-key").catch(() => null);
  if (!cfg?.configured || !cfg.publicKey) return "unconfigured";

  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const sub = await reg?.pushManager.getSubscription();
  if (sub) return "on";
  return "off";
}

/** Enable notifications: permission → subscribe → store on Worker. */
export async function enableWebPush(): Promise<void> {
  if (!webPushSupported()) throw new Error("This browser doesn't support Web Push.");
  if (webPushNeedsInstall()) throw new Error("Add heyflare to your Home Screen first, then open it from there.");

  const cfg = await api.get<{ configured: boolean; publicKey: string | null }>("/api/push/vapid-public-key");
  if (!cfg.configured || !cfg.publicKey) throw new Error("Notifications aren't configured on this server yet.");

  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notification permission was not granted.");

  await registerServiceWorker();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(cfg.publicKey) as BufferSource,
    });
  }

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("Could not create a push subscription.");
  await api.post("/api/push/subscriptions", {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

export async function disableWebPush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    try {
      await api.del("/api/push/subscriptions", { endpoint: sub.endpoint });
    } catch {
      /* still unsubscribe locally */
    }
    await sub.unsubscribe();
  }
}

/** Exported for tests / debugging. */
export { toB64Url, urlBase64ToUint8Array };
