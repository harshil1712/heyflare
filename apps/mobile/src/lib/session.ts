import * as SecureStore from "expo-secure-store";

const SERVER_KEY = "heyflare.server";
const TOKEN_KEY = "heyflare.session";

export async function getServerUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(SERVER_KEY);
}

export async function setServerUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(SERVER_KEY, url.replace(/\/$/, ""));
}

export async function clearServerUrl(): Promise<void> {
  await SecureStore.deleteItemAsync(SERVER_KEY);
}

export async function getSessionToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setSessionToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearSessionToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export function normalizeServerUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Enter your heyflare URL.");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const u = new URL(withScheme);
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
    throw new Error("Use https:// for your server.");
  }
  return `${u.protocol}//${u.host}`;
}
