import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Chip, ErrorText, HeaderAction, Loading, Muted, PrimaryButton, Screen } from "@/components/ui";
import { api, invalidateMail, keys, qs, threadAction, type FeedPage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { border, ink, muted } from "@/lib/theme";
import { fromLabel } from "@/lib/theme";

export default function FeedScreen() {
  const [show, setShow] = useState<"new" | "all">("new");
  const router = useRouter();
  const { scope, accounts } = useAuth();
  const qc = useQueryClient();
  const q = useInfiniteQuery({
    queryKey: [...keys.feed(show), scope],
    queryFn: ({ pageParam }) => api.get<FeedPage>(`/api/feed${qs({ page: pageParam, show })}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_page ?? undefined,
    enabled: accounts.length > 0,
  });
  const move = useMutation({
    mutationFn: ({ id, bucket }: { id: string; bucket: "imbox" | "paper_trail" }) =>
      threadAction(id, { action: "move", bucket }),
    onSuccess: () => invalidateMail(qc),
  });

  const threads = q.data?.pages.flatMap((p) => p.threads) ?? [];

  return (
    <Screen
      title="The Feed"
      refreshing={q.isRefetching}
      onRefresh={() => void q.refetch()}
      right={<HeaderAction label="Compose" onPress={() => router.push("/compose")} />}
    >
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Chip label="New" active={show === "new"} onPress={() => setShow("new")} />
        <Chip label="All" active={show === "all"} onPress={() => setShow("all")} />
      </View>
      {q.isLoading ? <Loading /> : null}
      {accounts.length > 0 && q.error ? <ErrorText>{(q.error as Error).message}</ErrorText> : null}
      {!accounts.length ? (
        <View style={{ gap: 10 }}>
          <Muted>Connect Gmail to fill the Feed.</Muted>
          <PrimaryButton label="Open settings" variant="outlined" onPress={() => router.push("/settings")} />
        </View>
      ) : null}
      {accounts.length > 0 && !q.isLoading && !threads.length ? <Muted>Feed is empty.</Muted> : null}
      {threads.map((t) => {
        const body = t.latest_message?.text_body || t.snippet || "";
        return (
          <View key={t.id} style={{ paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: border, gap: 8 }}>
            <Pressable onPress={() => router.push(`/thread/${t.id}`)}>
              <Text style={{ fontWeight: "700", color: ink, fontSize: 15 }}>
                {fromLabel(t.last_from.name, t.last_from.email)}
              </Text>
              <Text style={{ fontWeight: "600", color: ink, marginTop: 2 }}>{t.subject || "(no subject)"}</Text>
              <Text style={{ color: muted, marginTop: 6, lineHeight: 20 }} numberOfLines={8}>
                {body}
              </Text>
            </Pressable>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <PrimaryButton
                label="To Imbox"
                variant="ghost"
                onPress={() => move.mutate({ id: t.id, bucket: "imbox" })}
              />
              <PrimaryButton
                label="Paper Trail"
                variant="ghost"
                onPress={() => move.mutate({ id: t.id, bucket: "paper_trail" })}
              />
              <PrimaryButton label="Open" variant="outlined" onPress={() => router.push(`/thread/${t.id}`)} />
            </View>
          </View>
        );
      })}
      {q.hasNextPage ? (
        <PrimaryButton label="Load more" variant="outlined" onPress={() => void q.fetchNextPage()} />
      ) : null}
    </Screen>
  );
}
