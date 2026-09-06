import { Host, Column, Text, ScrollView } from "@expo/ui";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, Stack } from "expo-router";
import { api } from "@/lib/api";

type Message = {
  id: string;
  from: { name: string; email: string };
  date: number;
  text_body: string;
  is_from_me: boolean;
};

type ThreadDetail = {
  id: string;
  subject: string;
  messages: Message[];
};

export default function ThreadScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const q = useQuery({
    queryKey: ["thread", id],
    enabled: !!id,
    queryFn: () => api.get<ThreadDetail>(`/api/threads/${id}`),
  });

  return (
    <>
      <Stack.Screen options={{ title: q.data?.subject || "Thread" }} />
      <Host style={{ flex: 1 }} matchContents={false} colorScheme="light">
        <ScrollView>
          <Column spacing={16} style={{ padding: 16 }}>
            {q.isLoading ? <Text textStyle={{ color: "#5c5c5c" }}>Loading…</Text> : null}
            {q.error ? <Text textStyle={{ color: "#b91c1c" }}>{(q.error as Error).message}</Text> : null}
            {(q.data?.messages ?? []).map((m) => (
              <Column key={m.id} spacing={4} style={{ paddingBottom: 12 }}>
                <Text textStyle={{ fontWeight: "600", color: "#111111" }}>
                  {m.is_from_me ? "You" : m.from.name || m.from.email}
                </Text>
                <Text textStyle={{ fontSize: 12, color: "#5c5c5c" }}>
                  {new Date(m.date).toLocaleString()}
                </Text>
                <Text textStyle={{ color: "#111111" }}>{m.text_body || "(no text body)"}</Text>
              </Column>
            ))}
          </Column>
        </ScrollView>
      </Host>
    </>
  );
}
