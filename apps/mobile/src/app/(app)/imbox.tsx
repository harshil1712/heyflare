import { Host, Column, Text, List, ListItem, ScrollView } from "@expo/ui";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { api } from "@/lib/api";

type ThreadSummary = {
  id: string;
  subject: string;
  snippet: string;
  last_from: { name: string; email: string };
  last_message_at: number;
  unread: boolean;
};

type ImboxResponse = {
  new_threads: ThreadSummary[];
  seen_threads: ThreadSummary[];
};

function fromLabel(t: ThreadSummary) {
  return t.last_from.name || t.last_from.email || "Unknown";
}

function ThreadRow({ t }: { t: ThreadSummary }) {
  const router = useRouter();
  return (
    <ListItem
      onPress={() => router.push(`/thread/${t.id}`)}
      supportingText={`${t.subject || "(no subject)"}\n${t.snippet}`}
    >
      <Text textStyle={{ fontWeight: t.unread ? "700" : "500", color: "#111111" }}>{fromLabel(t)}</Text>
    </ListItem>
  );
}

export default function ImboxScreen() {
  const q = useQuery({
    queryKey: ["imbox"],
    queryFn: () => api.get<ImboxResponse>("/api/imbox"),
  });

  const fresh = q.data?.new_threads ?? [];
  const seen = q.data?.seen_threads ?? [];

  return (
    <Host style={{ flex: 1 }} matchContents={false} colorScheme="light">
      <ScrollView>
        <Column spacing={8} style={{ padding: 16 }}>
          <Text textStyle={{ fontSize: 28, fontWeight: "700", color: "#111111" }}>Imbox</Text>
          {q.isLoading ? <Text textStyle={{ color: "#5c5c5c" }}>Loading…</Text> : null}
          {q.error ? <Text textStyle={{ color: "#b91c1c" }}>{(q.error as Error).message}</Text> : null}
          {!q.isLoading && !fresh.length && !seen.length ? (
            <Text textStyle={{ color: "#5c5c5c" }}>Nothing new. Connect Gmail on the web if this is empty.</Text>
          ) : null}
          {fresh.length ? (
            <>
              <Text textStyle={{ fontWeight: "600", color: "#111111" }}>New for you</Text>
              <List>{fresh.map((t) => <ThreadRow key={t.id} t={t} />)}</List>
            </>
          ) : null}
          {seen.length ? (
            <>
              <Text textStyle={{ fontWeight: "600", color: "#111111" }}>Previously seen</Text>
              <List>{seen.map((t) => <ThreadRow key={t.id} t={t} />)}</List>
            </>
          ) : null}
        </Column>
      </ScrollView>
    </Host>
  );
}
