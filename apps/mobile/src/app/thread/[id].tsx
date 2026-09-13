import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import type { ThreadDetail } from "@shared/types";
import { ErrorText, Loading, Muted, PrimaryButton, Screen, SectionLabel } from "@/components/ui";
import { api, invalidateMail, keys, qs, threadAction } from "@/lib/api";
import { border, ink, muted } from "@/lib/theme";
import { formatWhen, fromLabel } from "@/lib/theme";

export default function ThreadScreen() {
  const params = useLocalSearchParams<{ id?: string | string[]; peek?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const peek = (Array.isArray(params.peek) ? params.peek[0] : params.peek) === "1";
  const router = useRouter();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const q = useQuery({
    queryKey: [...keys.thread(id ?? ""), peek],
    enabled: !!id,
    queryFn: () => api.get<ThreadDetail>(`/api/threads/${id}${qs({ peek: peek ? 1 : undefined })}`),
  });

  const act = useMutation({
    mutationFn: (a: Parameters<typeof threadAction>[1]) => threadAction(id!, a),
    onSuccess: (data) => {
      qc.setQueryData([...keys.thread(id!), peek], data);
      invalidateMail(qc);
    },
  });

  const thread = q.data;
  const lastInbound = useMemo(
    () => [...(thread?.messages ?? [])].reverse().find((m) => !m.is_from_me),
    [thread]
  );

  const run = (a: Parameters<typeof threadAction>[1], thenBack = false) => {
    act.mutate(a, {
      onSuccess: () => {
        if (thenBack) router.back();
      },
      onError: (e) => Alert.alert("Action failed", (e as Error).message),
    });
  };

  return (
    <>
      <Stack.Screen options={{ title: thread?.subject || "Thread", headerShown: true }} />
      <Screen inset="stack" refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
        {q.isLoading ? <Loading /> : null}
        {q.error ? <ErrorText>{(q.error as Error).message}</ErrorText> : null}

        {thread?.note ? (
          <View style={{ padding: 12, backgroundColor: "#f5f5f5", borderRadius: 10 }}>
            <Text style={{ color: ink }}>Note: {thread.note}</Text>
          </View>
        ) : null}

        {(thread?.messages ?? []).map((m) => {
          const open = expanded[m.id] ?? true;
          const html = m.html_body?.trim();
          return (
            <View key={m.id} style={{ paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: border, gap: 6 }}>
              <PrimaryButton
                label={`${m.is_from_me ? "You" : fromLabel(m.from.name, m.from.email)} · ${formatWhen(m.date)}`}
                variant="ghost"
                onPress={() => setExpanded((s) => ({ ...s, [m.id]: !open }))}
              />
              {open ? (
                html ? (
                  <View style={{ height: Math.min(420, 120 + Math.floor(html.length / 8)), borderWidth: 0.5, borderColor: border, borderRadius: 8, overflow: "hidden" }}>
                    <WebView
                      originWhitelist={["*"]}
                      source={{
                        html: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><style>body{font:15px -apple-system,sans-serif;color:#111;margin:12px;line-height:1.45}img{max-width:100%}</style></head><body>${html}</body></html>`,
                      }}
                    />
                  </View>
                ) : (
                  <Text style={{ color: ink, lineHeight: 22 }}>{m.text_body || "(no text body)"}</Text>
                )
              ) : (
                <Muted>{m.snippet || " "}</Muted>
              )}
              {m.attachments?.length ? (
                <Muted>
                  {`${m.attachments.length} attachment${m.attachments.length === 1 ? "" : "s"}: ${m.attachments.map((a) => a.filename).join(", ")}`}
                </Muted>
              ) : null}
            </View>
          );
        })}

        {!peek ? (
          <>
            <SectionLabel>Actions</SectionLabel>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <PrimaryButton
                label="Reply"
                onPress={() =>
                  router.push({
                    pathname: "/compose",
                    params: {
                      threadId: id,
                      replyTo: lastInbound?.id || thread?.messages.at(-1)?.id || "",
                      to: lastInbound?.from.email || "",
                      subject: thread?.subject?.startsWith("Re:") ? thread.subject : `Re: ${thread?.subject || ""}`,
                      accountId: thread?.account_id || "",
                    },
                  })
                }
              />
              <PrimaryButton
                label={thread?.reply_later ? "Clear Reply Later" : "Reply Later"}
                variant="outlined"
                onPress={() => run({ action: "reply_later", on: !thread?.reply_later }, true)}
              />
              <PrimaryButton
                label={thread?.set_aside ? "Clear Set Aside" : "Set Aside"}
                variant="outlined"
                onPress={() => run({ action: "set_aside", on: !thread?.set_aside }, true)}
              />
              <PrimaryButton
                label="To Feed"
                variant="ghost"
                onPress={() => run({ action: "move", bucket: "feed" }, true)}
              />
              <PrimaryButton
                label="Paper Trail"
                variant="ghost"
                onPress={() => run({ action: "move", bucket: "paper_trail" }, true)}
              />
              <PrimaryButton
                label="Trash"
                variant="ghost"
                onPress={() =>
                  Alert.alert("Trash thread?", undefined, [
                    { text: "Cancel", style: "cancel" },
                    { text: "Trash", style: "destructive", onPress: () => run({ action: "delete" }, true) },
                  ])
                }
              />
              <PrimaryButton
                label="Mark unread"
                variant="ghost"
                onPress={() => run({ action: "mark_unread" })}
              />
            </View>
          </>
        ) : (
          <Muted>Peek mode — decisions happen in Screener.</Muted>
        )}
      </Screen>
    </>
  );
}
