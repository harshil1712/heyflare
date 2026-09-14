import type { QueryClient } from "@tanstack/react-query";
import type * as T from "@shared/types";
import { clearSessionToken, getScope, getServerUrl, getSessionToken } from "./session";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const keys = {
  me: ["me"] as const,
  counts: ["counts"] as const,
  imbox: ["imbox"] as const,
  threads: (bucket: string, q?: string) => ["threads", bucket, q ?? ""] as const,
  feed: (show: string) => ["feed", show] as const,
  thread: (id: string) => ["thread", id] as const,
  screener: ["screener"] as const,
  search: (q: string) => ["search", q] as const,
  drafts: ["drafts"] as const,
  aiConversations: ["ai", "conversations"] as const,
  aiConversation: (id: string) => ["ai", "conversation", id] as const,
  calEvents: (from: string, to: string) => ["cal", "events", from, to] as const,
};

export function invalidateMail(qc: QueryClient) {
  for (const k of [["imbox"], ["threads"], ["feed"], ["thread"], ["counts"], ["screener"], ["search"]]) {
    qc.invalidateQueries({ queryKey: k });
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const base = await getServerUrl();
  if (!base) throw new ApiError(0, "Configure your server URL first.");
  const token = await getSessionToken();
  const scope = await getScope();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Heyflare-Client": "mobile",
    "X-Account-Id": scope || "all",
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
    const raw = (data as { error?: string } | null)?.error || res.statusText || "Request failed";
    const map: Record<string, string> = {
      no_account: "Connect a Gmail account first.",
      invalid_credentials: "Wrong email or password.",
      unauthorized: "Please log in.",
    };
    throw new ApiError(res.status, map[raw] || raw.replace(/_/g, " "));
  }
  return data as T;
}

export const api = {
  get: <R>(path: string) => request<R>("GET", path),
  post: <R>(path: string, body?: unknown) => request<R>("POST", path, body ?? {}),
  patch: <R>(path: string, body?: unknown) => request<R>("PATCH", path, body ?? {}),
  delete: <R>(path: string, body?: unknown) => request<R>("DELETE", path, body),
};

export type ThreadAction =
  | { action: "mark_unread" | "mark_read" | "seen" | "delete" }
  | { action: "reply_later"; on: boolean }
  | { action: "set_aside"; on: boolean }
  | { action: "bubble_up"; at: number | null }
  | { action: "move"; bucket: T.Bucket }
  | { action: "rename"; subject: string | null }
  | { action: "note"; note: string }
  | { action: "bundle"; on: boolean };

export interface DraftBody {
  account_id?: string;
  thread_id?: string | null;
  reply_to_message_id?: string | null;
  to: T.Address[];
  cc: T.Address[];
  bcc: T.Address[];
  subject: string;
  body_html: string;
  send_at?: number | null;
}

export interface SendPayload extends DraftBody {
  draft_id?: string;
  attachments?: { filename: string; mime_type: string; data_base64: string }[];
}

export interface SendResult {
  ok: boolean;
  account_id?: string;
  thread_id?: string;
  message_id?: string;
  scheduled?: boolean;
  draft_id?: string;
}

export interface ThreadsPage {
  threads: T.ThreadSummary[];
  bundles?: T.Bundle[];
  next_page: number | null;
}

export interface FeedPage {
  threads: (T.ThreadSummary & { latest_message: T.Message })[];
  next_page: number | null;
}

export interface ScreenerSender {
  account_id: string;
  contact: T.Contact;
  threads: T.ThreadSummary[];
  suggestion: "imbox" | "feed" | "paper_trail";
}

export interface MeResponse {
  user: T.User | null;
  accounts: T.Account[];
  setup_required: boolean;
  google_configured?: boolean;
}

export async function threadAction(id: string, a: ThreadAction) {
  return api.post<T.ThreadDetail>(`/api/threads/${id}/actions`, a);
}

export async function bulkAction(thread_ids: string[], a: ThreadAction) {
  return api.post<{ ok: boolean }>("/api/threads/bulk", { thread_ids, ...a });
}

export async function sendMail(payload: SendPayload) {
  return api.post<SendResult>("/api/send", payload);
}

export async function connectGmailLink() {
  return api.post<{ url: string }>("/api/accounts/connect-link", {});
}

/** Native Expo assistant used SSE; chat now runs via Think on the PWA. */
export async function streamAssistantChat(
  _body: { conversation_id?: string | null; message: string },
  _onEvent: (ev: { type: string; [k: string]: unknown }) => void,
  _signal?: AbortSignal
): Promise<void> {
  throw new ApiError(410, "Assistant chat moved to the web app (Think agent). Use the PWA for chat.");
}
