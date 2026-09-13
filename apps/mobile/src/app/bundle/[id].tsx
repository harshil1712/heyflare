import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Text, View } from "react-native";
import type { BundleDetail } from "@shared/types";
import { ThreadRow } from "@/components/ThreadRow";
import { ErrorText, Loading, Muted, PrimaryButton, Screen } from "@/components/ui";
import { api, invalidateMail } from "@/lib/api";
import { ink, muted } from "@/lib/theme";

export default function BundleScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["bundle", id],
    enabled: !!id,
    queryFn: () => api.get<BundleDetail>(`/api/bundles/${id}`),
  });
  const seen = useMutation({
    mutationFn: () => api.post(`/api/bundles/${id}/seen`),
    onSuccess: () => {
      invalidateMail(qc);
      void q.refetch();
    },
  });
  const dissolve = useMutation({
    mutationFn: () => api.delete(`/api/bundles/${id}`),
    onSuccess: () => {
      invalidateMail(qc);
      router.back();
    },
  });

  const b = q.data?.bundle;

  return (
    <>
      <Stack.Screen options={{ title: b?.name || b?.email || "Bundle", headerShown: true }} />
      <Screen inset="stack" refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
        {q.isLoading ? <Loading /> : null}
        {q.error ? <ErrorText>{(q.error as Error).message}</ErrorText> : null}
        {b ? (
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 18, fontWeight: "700", color: ink }}>{b.name || b.email}</Text>
            <Text style={{ color: muted }}>
              {b.thread_count} threads · {b.message_count} messages
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <PrimaryButton label="Mark seen" onPress={() => seen.mutate()} />
              <PrimaryButton label="Dissolve" variant="outlined" onPress={() => dissolve.mutate()} />
            </View>
          </View>
        ) : null}
        {(q.data?.threads ?? []).map((t) => (
          <ThreadRow key={t.id} thread={t} onPress={() => router.push(`/thread/${t.id}`)} />
        ))}
        {!q.isLoading && q.data && !q.data.threads.length ? <Muted>No threads in this bundle.</Muted> : null}
      </Screen>
    </>
  );
}
