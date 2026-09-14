import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowUp, Check, Loader2, Paperclip, PenSquare, Plus, Send, Sparkles, Square, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { useAgent } from "agents/react";
import { getToolPartState, getToolOutput, useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { AiDraftCard } from "@shared/types";
import { api, useAiMutations, useAiSettings } from "../api";
import { useCompose } from "../context/ComposeContext";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ContextChip } from "../lib/assistantStore";
import { focus } from "../lib/focusStore";
import { draftSentThread, markDraftSent, subscribeSentDrafts } from "../lib/sentDrafts";

/* ---------- rendering helpers ---------- */

function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.trim().split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
}

/** Tiny markdown: paragraphs, "- " bullets, **bold**, `code`. */
export function Prose({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => text.replace(/\r/g, "").split(/\n{2,}/).filter((b) => b.trim()), [text]);
  const inline = (s: string) => {
    const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((p, i) => (p.startsWith("**") ? <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong> : p.startsWith("`") ? <code key={i} className="font-mono text-[12px] bg-muted rounded px-1">{p.slice(1, -1)}</code> : <span key={i}>{p}</span>));
  };
  return (
    <div className={cn("text-[14px] leading-6 space-y-2", className)}>
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={i} className="space-y-1 pl-4 list-disc marker:text-muted-foreground">
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ""))}</li>)}
            </ul>
          );
        }
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
          return (
            <ol key={i} className="space-y-1 pl-5 list-decimal marker:text-muted-foreground">
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>)}
            </ol>
          );
        }
        return <p key={i}>{lines.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l)}</span>)}</p>;
      })}
    </div>
  );
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 h-6" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-1.5 rounded-full bg-muted-foreground/60 animate-pulse" style={{ animationDelay: `${i * 160}ms` }} />
      ))}
    </div>
  );
}

function ToolLine({ status, summary }: { status: "running" | "done" | "error"; summary: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted-foreground py-0.5">
      {status === "running" ? <Loader2 className="size-3 animate-spin" /> : status === "error" ? <TriangleAlert className="size-3" /> : <Check className="size-3" />}
      <span className="truncate">{summary}</span>
    </div>
  );
}

export function DraftCard({ d, sentThreadId }: { d: AiDraftCard; sentThreadId?: string }) {
  const { openCompose } = useCompose();
  const qc = useQueryClient();
  const [state, setState] = useState<"idle" | "sending" | "sent">(sentThreadId ? "sent" : "idle");
  const [threadId, setThreadId] = useState<string | undefined>(sentThreadId);
  // A draft can also be sent from the composer this card opened, or by the assistant itself.
  useEffect(() => {
    const sync = () => {
      const t = draftSentThread(d.draft_id);
      if (t !== null) {
        setState("sent");
        setThreadId((prev) => prev ?? t);
      }
    };
    sync();
    return subscribeSentDrafts(sync);
  }, [d.draft_id]);
  useEffect(() => {
    if (sentThreadId) {
      setState("sent");
      setThreadId(sentThreadId);
    }
  }, [sentThreadId]);
  const send = async () => {
    setState("sending");
    try {
      await api.post("/api/send", { draft_id: d.draft_id, account_id: d.account_id, thread_id: d.thread_id, to: d.to, cc: d.cc, subject: d.subject, body_html: textToHtml(d.body_text) });
      setState("sent");
      toast("Sent");
      markDraftSent(d.draft_id);
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    } catch (e) {
      setState("idle");
      toast.error((e as Error).message);
    }
  };
  if (state === "sent") {
    // Collapsed: the mail is gone, so the card stops offering to send it.
    return (
      <div className="my-2 rounded-lg bg-muted/50 px-3 py-2 text-[13px] flex items-center gap-2 text-muted-foreground">
        <Check className="size-3.5 shrink-0" />
        <span className="truncate">
          Sent to {d.to.map((a) => a.name || a.email).join(", ")} · <span className="text-foreground/80">{d.subject}</span>
        </span>
        {threadId && (
          <Link className="ml-auto shrink-0 underline underline-offset-2 hover:text-foreground" to={`/t/${threadId}`}>
            Open
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg bg-muted/50 p-3 text-[13px]">
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        <PenSquare className="size-3.5" />
        <span className="truncate">Draft · from {d.from} · to {d.to.map((a) => a.name || a.email).join(", ")}{d.cc.length ? ` · cc ${d.cc.map((a) => a.email).join(", ")}` : ""}</span>
      </div>
      <div className="font-medium mb-1">{d.subject}</div>
      <Prose text={d.body_text} className="text-[13px] leading-5 text-foreground/90 max-h-56 overflow-y-auto" />
      <div className="flex items-center gap-2 mt-3">
        <Button size="sm" onClick={send} disabled={state === "sending"}>{state === "sending" ? <Loader2 className="animate-spin" /> : <Send />} Send</Button>
        <Button size="sm" variant="ghost" onClick={() => openCompose({ draft_id: d.draft_id, account_id: d.account_id, thread_id: d.thread_id, to: d.to, cc: d.cc, subject: d.subject, body_html: textToHtml(d.body_text) })}>Open in composer</Button>
      </div>
    </div>
  );
}

/* ---------- message model ---------- */

interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  context?: ContextChip[];
  tools: { id: string; status: "running" | "done" | "error"; summary: string }[];
  drafts: AiDraftCard[];
  sent: Record<string, string>;
  error?: string;
}

function toolLabel(name: string, input: any): string {
  switch (name) {
    case "search_mail": return `Searched mail for “${input?.query ?? ""}”`;
    case "list_threads": return `Listed ${String(input?.bucket ?? "").replace("_", " ")}`;
    case "read_thread": return "Read a thread";
    case "list_screener": return "Checked the Screener";
    case "screen_sender": return `Screened a sender → ${String(input?.decision ?? "").replace("_", " ")}`;
    case "thread_action": return `Organised · ${String(input?.action ?? "").replace("_", " ")}`;
    case "create_draft": return `Drafted “${input?.subject ?? "a message"}”`;
    case "send_draft": return "Sent a draft";
    case "remember": return `Remembered: ${input?.content ?? ""}`;
    case "forget": return "Forgot a memory entry";
    case "find_contact": return `Looked up “${input?.query ?? ""}”`;
    case "save_clip": return "Saved a clip";
    case "create_collection": return `Created collection “${input?.name ?? ""}”`;
    case "add_to_collection": return "Added to a collection";
    default: return name.replace(/_/g, " ");
  }
}

/* ---------- the chat ---------- */

export const SUGGESTIONS = ["What's new for me today?", "Anything waiting in the Screener?", "Summarise my unread mail", "Draft a reply to the latest email from …"];

/** Past this the box stops growing and scrolls instead, so the conversation never leaves the screen. */
const INPUT_MAX_PX = 160;

export function AssistantChat({
  conversationId,
  onConversationId,
  compact,
  context = [],
  onRemoveContext,
  onAddContext,
  autoFocus, onClose }: {
  conversationId?: string;
  onConversationId: (id: string) => void;
  compact?: boolean;
  context?: ContextChip[];
  onRemoveContext?: (id: string) => void;
  onAddContext?: () => void;
  autoFocus?: boolean; onClose?: () => void }) {
  const settings = useAiSettings();
  const m = useAiMutations();
  const qc = useQueryClient();
  const [input, setInput] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeId = conversationId || pendingId || undefined;
  const notConfigured = settings.data && !settings.data.configured;

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_PX)}px`;
  }, [input]);

  if (!activeId) {
    return (
      <AssistantShell
        compact={compact}
        notConfigured={!!notConfigured}
        input={input}
        setInput={setInput}
        inputRef={inputRef}
        autoFocus={autoFocus}
        onClose={onClose}
        onAddContext={onAddContext}
        context={context}
        onRemoveContext={onRemoveContext}
        busy={false}
        onStop={() => {}}
        onSend={async (text) => {
          const msg = text.trim();
          if (!msg || notConfigured) return;
          setInput("");
          try {
            const conv = await m.newConversation.mutateAsync();
            setPendingId(conv.id);
            onConversationId(conv.id);
            // Chat connects on next paint with this id; stash pending send.
            pendingSend.set(conv.id, { text: msg, context: context.slice(0, 3) });
            if (onRemoveContext) for (const c of context.slice(0, 3)) onRemoveContext(c.id);
          } catch (e) {
            toast.error((e as Error).message);
            setInput(msg);
          }
        }}
        messages={[]}
        isStreaming={false}
      />
    );
  }

  return (
    <AssistantAgentChat
      key={activeId}
      conversationId={activeId}
      compact={compact}
      notConfigured={!!notConfigured}
      input={input}
      setInput={setInput}
      inputRef={inputRef}
      bottomRef={bottomRef}
      autoFocus={autoFocus}
      onClose={onClose}
      onAddContext={onAddContext}
      context={context}
      onRemoveContext={onRemoveContext}
      onSent={() => {
        qc.invalidateQueries({ queryKey: ["ai", "conversations"] });
        qc.invalidateQueries({ predicate: (q) => ["imbox", "threads", "counts", "screener", "thread", "feed"].includes(String(q.queryKey[0])) });
      }}
    />
  );
}

/** First-message handoff before the WebSocket agent exists. */
const pendingSend = new Map<string, { text: string; context: ContextChip[] }>();

function AssistantAgentChat({
  conversationId,
  compact,
  notConfigured,
  input,
  setInput,
  inputRef,
  bottomRef,
  autoFocus,
  onClose,
  onAddContext,
  context,
  onRemoveContext,
  onSent,
}: {
  conversationId: string;
  compact?: boolean;
  notConfigured: boolean;
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  autoFocus?: boolean;
  onClose?: () => void;
  onAddContext?: () => void;
  context: ContextChip[];
  onRemoveContext?: (id: string) => void;
  onSent: () => void;
}) {
  const agent = useAgent({ agent: "AssistantAgent", name: conversationId });
  const contextRef = useRef(context);
  contextRef.current = context;
  const { messages, sendMessage, stop, status, isStreaming, error } = useAgentChat({
    agent,
    body: () => ({
      context_thread_ids: contextRef.current.slice(0, 3).map((c) => c.id),
    }),
  });

  useEffect(() => {
    const pending = pendingSend.get(conversationId);
    if (!pending) return;
    pendingSend.delete(conversationId);
    void sendMessage({ text: pending.text }).then(() => onSent());
  }, [conversationId, sendMessage, onSent]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, isStreaming, bottomRef]);

  const busy = isStreaming || status === "submitted";

  return (
    <AssistantShell
      compact={compact}
      notConfigured={notConfigured}
      input={input}
      setInput={setInput}
      inputRef={inputRef}
      autoFocus={autoFocus}
      onClose={onClose}
      onAddContext={onAddContext}
      context={context}
      onRemoveContext={onRemoveContext}
      busy={busy}
      onStop={() => stop()}
      onSend={async (text) => {
        const msg = text.trim();
        if (!msg || busy || notConfigured) return;
        setInput("");
        const ctx = context.slice(0, 3);
        try {
          await sendMessage({ text: msg });
          if (onRemoveContext) for (const c of ctx) onRemoveContext(c.id);
          onSent();
        } catch (e) {
          toast.error((e as Error).message);
          setInput(msg);
        }
      }}
      messages={messages}
      isStreaming={busy}
      error={error?.message}
    />
  );
}

function AssistantShell({
  compact,
  notConfigured,
  input,
  setInput,
  inputRef,
  autoFocus,
  onClose,
  onAddContext,
  context,
  onRemoveContext,
  busy,
  onStop,
  onSend,
  messages,
  isStreaming,
  error,
}: {
  compact?: boolean;
  notConfigured: boolean;
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  autoFocus?: boolean;
  onClose?: () => void;
  onAddContext?: () => void;
  context: ContextChip[];
  onRemoveContext?: (id: string) => void;
  busy: boolean;
  onStop: () => void;
  onSend: (text: string) => void | Promise<void>;
  messages: UIMessage[];
  isStreaming: boolean;
  error?: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, isStreaming]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className={cn("flex-1 min-h-0 overflow-y-auto", compact ? "px-4" : "px-2")}>
        {messages.length === 0 && (
          <div className={cn("pb-6 text-center", compact ? "pt-6" : "pt-10")}>
            <Sparkles className="size-6 mx-auto text-muted-foreground" />
            <div className="mt-3 text-[15px] font-medium">What can I do for you?</div>
            <div className="text-[13px] text-muted-foreground mt-1">I can read, search and organise your mail, screen senders, and write drafts for you to send.</div>
            {notConfigured && (
              <div className="mt-4 text-[13px]">
                <Link to="/settings#ai" className="underline underline-offset-2">Configure AI</Link> to get started.
              </div>
            )}
            {!notConfigured && (
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => { setInput(s); inputRef.current?.focus(); }} className="rounded-full bg-muted/60 hover:bg-muted px-3 h-8 text-[13px] text-foreground/80">{s}</button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="py-4 space-y-5">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {isStreaming && messages.at(-1)?.role !== "assistant" && <ThinkingDots />}
          {error && (
            <div className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-[13px]">
              <TriangleAlert className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
              <span>{error}</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <form
        className={cn("shrink-0 pt-2", compact ? "px-4 pb-3" : "px-2 pb-2")}
        onSubmit={(e) => {
          e.preventDefault();
          void onSend(input);
        }}
      >
        <div className="rounded-xl bg-muted/60 focus-within:bg-muted px-3 py-2">
          {context.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1.5">
              {context.map((c) => (
                <span key={c.id} className="inline-flex items-center gap-1 rounded-md bg-background border border-border pl-2 pr-1 h-6 text-[12px] max-w-[240px]">
                  <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{c.subject || "(no subject)"}</span>
                  <span className="truncate text-muted-foreground hidden sm:inline">· {c.from}</span>
                  {onRemoveContext && (
                    <button type="button" aria-label="Remove context" onClick={() => onRemoveContext(c.id)} className="size-4 rounded-sm flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted">
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            {onAddContext && (
              <Button type="button" size="icon-sm" variant="ghost" className="text-muted-foreground shrink-0" onClick={onAddContext} aria-label="Add a thread as context" disabled={!!notConfigured}>
                <Plus />
              </Button>
            )}
            <textarea
              ref={inputRef}
              data-assistant-input
              autoFocus={autoFocus}
              value={input}
              onChange={(e) => {
                const v = e.target.value;
                const startsWord = v.length === 1 || /\s$/.test(v.slice(0, -1));
                if (onAddContext && v.endsWith("@") && !input.endsWith("@") && startsWord) {
                  setInput(v);
                  onAddContext();
                  return;
                }
                setInput(v);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void onSend(input);
                  return;
                }
                if (e.key === "ArrowLeft" && !input) {
                  e.preventDefault();
                  (e.target as HTMLTextAreaElement).blur();
                  focus.toContent();
                  if (onClose) onClose();
                }
              }}
              placeholder={notConfigured ? "Configure AI in Settings…" : "Ask about your mail…"}
              disabled={!!notConfigured}
              rows={1}
              className="flex-1 min-w-0 resize-none bg-transparent outline-none text-[14px] leading-6 placeholder:text-muted-foreground max-h-[160px] overflow-y-auto py-1"
            />
            {busy ? (
              <Button type="button" size="icon-sm" variant="ghost" onClick={onStop} aria-label="Stop">
                <Square />
              </Button>
            ) : (
              <Button type="submit" size="icon-sm" disabled={!input.trim() || !!notConfigured} aria-label="Send">
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

function MessageBubble({ message }: { message: UIMessage }) {
  const text = message.parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("\n\n");
  const tools = message.parts.filter((p) => isToolUIPart(p));
  const drafts: AiDraftCard[] = [];
  for (const p of tools) {
    const name = getToolName(p as any);
    if (name !== "create_draft") continue;
    let out: unknown = getToolOutput(p as any);
    if (out && typeof out === "object" && "type" in (out as any) && (out as any).type === "text" && "value" in (out as any)) {
      out = (out as any).value;
    }
    const raw = typeof out === "string" ? safeParse(out) : out;
    const draft = (raw as any)?.draft || raw;
    if (draft?.draft_id && draft?.to) drafts.push(draft as AiDraftCard);
  }

  if (message.role === "user") {
    const ctx: ContextChip[] = [];
    const texts: string[] = [];
    for (const line of text.split("\n")) {
      const m2 = /^\[\[context thread=([^\]]+)\]\] Subject: (.*?) · From: (.*?)(?:\n|$)/.exec(line);
      if (m2) ctx.push({ id: m2[1], subject: m2[2], from: m2[3] });
      else if (!line.startsWith("[[context")) texts.push(line);
    }
    const display = texts.join("\n").trim() || text;
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]">
          {!!ctx.length && (
            <div className="flex flex-wrap justify-end gap-1 mb-1">
              {ctx.map((c) => (
                <Link key={c.id} to={`/t/${c.id}`} className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 h-6 text-[12px] text-muted-foreground max-w-[220px]">
                  <Paperclip className="size-3 shrink-0" />
                  <span className="truncate">{c.subject || "(no subject)"}</span>
                </Link>
              ))}
            </div>
          )}
          <div className="rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-[14px] leading-6 whitespace-pre-wrap">{display}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] min-w-0">
        {tools.length > 0 && (
          <div className="mb-1">
            {tools.map((p, i) => {
              const name = getToolName(p as any);
              const state = getToolPartState(p);
              const status = state === "complete" ? "done" : state === "error" ? "error" : "running";
              const input = (p as any).input;
              return <ToolLine key={(p as any).toolCallId || i} status={status as any} summary={toolLabel(name, input)} />;
            })}
          </div>
        )}
        {text ? <Prose text={text} /> : tools.length === 0 ? <ThinkingDots /> : null}
        {drafts.map((d) => <DraftCard key={d.draft_id} d={d} />)}
      </div>
    </div>
  );
}

function safeParse(s: string) {
  try { return JSON.parse(s); } catch { return null; }
}
