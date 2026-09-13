import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import { Text, View } from "react-native";
import type { Message, ThreadSummary } from "@shared/types";
import { ErrorText, Loading, Muted, PrimaryButton, Screen } from "@/components/ui";
import { api, invalidateMail, threadAction } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ink, muted } from "@/lib/theme";
import { fromLabel } from "@/lib/theme";

type Item = ThreadSummary & { latest_message: Message | null };

export default function PowerThroughScreen() {
  const router = useRouter();
  const { accounts } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["power-through"],
    queryFn: () => api.get<{ items: Item[] }>("/api/power-through"),
    enabled: accounts.length > 0,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const markSeen = useMutation({
    mutationFn: (thread_ids: string[]) => api.post("/api/power-through/seen", { thread_ids }),
    onSuccess: () => {
      invalidateMail(qc);
      void q.refetch();
    },
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: Parameters<typeof threadAction>[1] }) => threadAction(id, action),
    onSuccess: () => {
      invalidateMail(qc);
      void q.refetch();
    },
  });

  const items = q.data?.items ?? [];
  const current = items[0];
  const body = current?.latest_message?.text_body || current?.snippet || "";

  return (
    <>
      <Stack.Screen options={{ title: "Power through", headerShown: true }} />
      <Screen inset="stack" refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
        {q.isLoading ? <Loading /> : null}
        {q.error ? <ErrorText>{(q.error as Error).message}</ErrorText> : null}
        {!accounts.length ? <Muted>Connect Gmail to power through new mail.</Muted> : null}
        {accounts.length > 0 && !q.isLoading && !current ? <Muted>Queue clear. Nice.</Muted> : null}
        {current ? (
          <View style={{ gap: 12 }}>
            <Text style={{ color: muted, fontSize: 13 }}>{items.length} left</Text>
            <Text style={{ fontSize: 18, fontWeight: "700", color: ink }}>
              {fromLabel(current.last_from.name, current.last_from.email)}
            </Text>
            <Text style={{ fontSize: 16, fontWeight: "600", color: ink }}>{current.subject || "(no subject)"}</Text>
            <Text style={{ color: muted, lineHeight: 20 }} numberOfLines={12}>
              {body}
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <PrimaryButton label="Open" onPress={() => router.push(`/thread/${current.id}`)} />
              <PrimaryButton label="Seen" variant="outlined" onPress={() => markSeen.mutate([current.id])} />
              <PrimaryButton
                label="Reply Later"
                variant="ghost"
                onPress={() => act.mutate({ id: current.id, action: { action: "reply_later", on: true } })}
              />
              <PrimaryButton
                label="Set Aside"
                variant="ghost"
                onPress={() => act.mutate({ id: current.id, action: { action: "set_aside", on: true } })}
              />
              <PrimaryButton
                label="Trash"
                variant="ghost"
                onPress={() => act.mutate({ id: current.id, action: { action: "delete" } })}
              />
            </View>
            {items.length > 1 ? (
              <PrimaryButton
                label="Mark all seen"
                variant="outlined"
                onPress={() => markSeen.mutate(items.map((t) => t.id))}
              />
            ) : null}
          </View>
        ) : null}
      </Screen>
    </>
  );
}
