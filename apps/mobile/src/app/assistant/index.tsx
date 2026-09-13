import { useQuery } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import { Pressable, Text } from "react-native";
import type { AiConversation } from "@shared/types";
import { ErrorText, HeaderAction, Loading, Muted, PrimaryButton, Screen } from "@/components/ui";
import { api, keys } from "@/lib/api";
import { border, ink, muted } from "@/lib/theme";

export default function AssistantListScreen() {
  const router = useRouter();
  const q = useQuery({
    queryKey: keys.aiConversations,
    queryFn: () => api.get<AiConversation[]>("/api/ai/conversations"),
  });

  return (
    <>
      <Stack.Screen
        options={{
          title: "Assistant",
          headerShown: true,
          headerBackTitle: "Back",
          headerRight: () => <HeaderAction label="New" onPress={() => router.push("/assistant/new")} />,
        }}
      />
      <Screen inset="stack" refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
        <Muted>Ask heyflare about your mail. Requires AI settings configured on the server.</Muted>
        {q.isLoading ? <Loading /> : null}
        {q.error ? <ErrorText>{(q.error as Error).message}</ErrorText> : null}
        {(q.data ?? []).map((c) => (
          <Pressable
            key={c.id}
            onPress={() => router.push(`/assistant/${c.id}`)}
            style={{ paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: border }}
          >
            <Text style={{ fontWeight: "600", color: ink }}>{c.title || "Conversation"}</Text>
            <Text style={{ color: muted, fontSize: 12 }}>{new Date(c.updated_at).toLocaleString()}</Text>
          </Pressable>
        ))}
        {!q.isLoading && !(q.data?.length) ? (
          <PrimaryButton label="Start chatting" onPress={() => router.push("/assistant/new")} />
        ) : null}
      </Screen>
    </>
  );
}
