import type { QueryClient } from "@tanstack/react-query";
import { keys } from "../api";
import { syncAppBadge } from "./push";

/** Message the service worker broadcasts when a mail push arrives. */
interface NewMailMessage {
  type: "heyflare:new-mail";
  badge?: number;
}

function isNewMailMessage(data: unknown): data is NewMailMessage {
  return typeof data === "object" && data !== null && (data as { type?: unknown }).type === "heyflare:new-mail";
}

/**
 * Push-driven live refresh: the service worker relays every incoming mail push to
 * open tabs, and a focused tab invalidates its core mail caches immediately instead
 * of waiting for the slow fallback polls. No-ops where service workers are missing.
 */
export function installSwMessageListener(queryClient: QueryClient): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    if (!isNewMailMessage(event.data)) return;
    // Core mail caches — the same prefixes the action mutations sweep.
    queryClient.invalidateQueries({ queryKey: keys.counts });
    queryClient.invalidateQueries({ queryKey: keys.imbox });
    queryClient.invalidateQueries({ queryKey: ["threads"] });
    queryClient.invalidateQueries({ queryKey: keys.feed });
    queryClient.invalidateQueries({ queryKey: keys.screener });
    // Cheap: keeps the OS badge honest on platforms where the page owns the badge.
    if (typeof event.data.badge === "number") void syncAppBadge(event.data.badge);
  });
}
