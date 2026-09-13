import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ErrorText, PrimaryButton, Screen } from "@/components/ui";
import { ApiError, keys, streamAssistantChat, api } from "@/lib/api";
import { border, ink, bg } from "@/lib/theme";

type Msg = { role: "user" | "assistant" | "system"; content: string };

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
          return (block as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export default function AssistantChatScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const idParam = Array.isArray(params.id) ? params.id[0] : params.id;
  const isNew = !idParam || idParam === "new";
  const [conversationId, setConversationId] = useState<string | null>(isNew ? null : idParam);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const qc = useQueryClient();
  const scrollRef = useRef<ScrollView>(null);

  const existing = useQuery({
    queryKey: keys.aiConversation(conversationId || ""),
    enabled: !!conversationId,
    queryFn: () =>
      api.get<{ conversation: { id: string; title: string }; messages: { role: string; content: unknown }[] }>(
        `/api/ai/conversations/${conversationId}`
      ),
  });

  useEffect(() => {
    if (!existing.data?.messages) return;
    setMessages(
      existing.data.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: extractText(m.content) }))
        .filter((m) => m.content.trim())
    );
  }, [existing.data]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: text }]);
    setStreaming("");
    let assistant = "";
    try {
      await streamAssistantChat({ conversation_id: conversationId, message: text }, (ev) => {
        if (ev.type === "start" && typeof ev.conversation_id === "string") {
          setConversationId(ev.conversation_id);
          if (isNew) router.setParams({ id: ev.conversation_id });
        }
        if (ev.type === "text" && typeof ev.text === "string") {
          assistant += ev.text;
          setStreaming(assistant);
        }
        if (ev.type === "error" && typeof ev.message === "string") {
          setError(ev.message);
        }
        if (ev.type === "done") {
          if (assistant) setMessages((m) => [...m, { role: "assistant", content: assistant }]);
          setStreaming("");
          void qc.invalidateQueries({ queryKey: keys.aiConversations });
        }
      });
      if (assistant && !messages.some((m) => m.content === assistant && m.role === "assistant")) {
        // ensure final flush if done event missed
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (assistant) {
        setMessages((m) => {
          const last = m[m.length - 1];
          if (last?.role === "assistant" && last.content === assistant) return m;
          // If done already appended, skip
          if (m.some((x) => x.role === "assistant" && x.content === assistant)) return m;
          return [...m, { role: "assistant", content: assistant }];
        });
      }
      setStreaming("");
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: "Chat", headerShown: true }} />
      <Screen inset="stack" scroll={false} style={{ paddingHorizontal: 0, flex: 1, paddingBottom: 0 }}>
        <ScrollView ref={scrollRef} contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 24 }}>
          {messages.map((m, i) => (
            <View
              key={`${i}-${m.role}`}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                backgroundColor: m.role === "user" ? ink : bg,
                padding: 12,
                borderRadius: 12,
                maxWidth: "92%",
              }}
            >
              <Text style={{ color: m.role === "user" ? "#fff" : ink, lineHeight: 20 }}>{m.content}</Text>
            </View>
          ))}
          {streaming ? (
            <View style={{ alignSelf: "flex-start", backgroundColor: bg, padding: 12, borderRadius: 12, maxWidth: "92%" }}>
              <Text style={{ color: ink, lineHeight: 20 }}>{streaming}</Text>
            </View>
          ) : null}
          {error ? <ErrorText>{error}</ErrorText> : null}
        </ScrollView>
        <View style={{ flexDirection: "row", gap: 8, padding: 12, borderTopWidth: 0.5, borderTopColor: border }}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Ask about your mail…"
            style={{
              flex: 1,
              borderWidth: 1,
              borderColor: border,
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 10,
              color: ink,
            }}
            editable={!busy}
            onSubmitEditing={() => void send()}
          />
          <PrimaryButton label={busy ? "…" : "Send"} onPress={() => void send()} disabled={busy || !input.trim()} />
        </View>
      </Screen>
    </>
  );
}
