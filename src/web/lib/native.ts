// Browser helpers. Native Tauri/Expo shells were removed — PWA only.
export const isNative = false;
export const isMac = false;
export const nativePlatform: "macos" | "ios" | null = null;

export function openExternalUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

export const native = {
  setBadge: (_count: number) => {},
  notify: (_title: string, _body: string, _url?: string) => {},
  takePendingUrl: async () => null as string | null,
  openExternal: (url: string) => openExternalUrl(url),
  checkUpdate: async () => undefined as { available: boolean; version?: string; notes?: string } | undefined,
  updateApp: async (_onProgress?: (fraction: number) => void): Promise<string | null> =>
    "Self-update isn't available in the browser. Redeploy the Worker instead.",
};

export function onMenu(_handler: (id: string) => void): () => void {
  return () => {};
}

export function installExternalLinkHandler(): () => void {
  return () => {};
}
