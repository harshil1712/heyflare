import { clearSessionToken, getServerUrl, getSessionToken } from "./session";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const base = await getServerUrl();
  if (!base) throw new ApiError(0, "Configure your server URL first.");
  const token = await getSessionToken();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Heyflare-Client": "mobile",
    "X-Account-Id": "all",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (res.status === 401) {
    await clearSessionToken();
    throw new ApiError(401, "Please log in");
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error || res.statusText || "Request failed";
    throw new ApiError(res.status, msg.replace(/_/g, " "));
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
