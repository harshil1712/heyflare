import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import { View } from "react-native";
import { ThreadRow } from "@/components/ThreadRow";
import { ErrorText, Field, Loading, Muted, PrimaryButton, Screen } from "@/components/ui";
import { api, keys, qs, type ThreadsPage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function SearchScreen() {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const router = useRouter();
  const { scope, accounts } = useAuth();

  const search = useInfiniteQuery({
    queryKey: [...keys.search(submitted), scope],
    enabled: submitted.trim().length > 0 && accounts.length > 0,
    queryFn: ({ pageParam }) => api.get<ThreadsPage>(`/api/search${qs({ q: submitted, page: pageParam })}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_page ?? undefined,
  });

  const threads = search.data?.pages.flatMap((p) => p.threads) ?? [];

  return (
    <>
      <Stack.Screen options={{ title: "Search", headerShown: true, headerBackTitle: "Back" }} />
      <Screen inset="stack">
        <View style={{ flexDirection: "row", gap: 8, alignItems: "stretch" }}>
          <Field
            value={q}
            onChangeText={setQ}
            placeholder="Search mail"
            autoCapitalize="none"
            returnKeyType="search"
            onSubmitEditing={() => setSubmitted(q.trim())}
            style={{ flex: 1 }}
          />
          <PrimaryButton
            label="Go"
            disabled={!q.trim() || !accounts.length}
            onPress={() => setSubmitted(q.trim())}
          />
        </View>
        {!accounts.length ? (
          <View style={{ gap: 10 }}>
            <Muted>Connect Gmail to search mail.</Muted>
            <PrimaryButton label="Open settings" variant="outlined" onPress={() => router.push("/settings")} />
          </View>
        ) : null}
        {accounts.length > 0 && !submitted ? <Muted>Search subject, body, and people.</Muted> : null}
        {search.isLoading ? <Loading /> : null}
        {search.error ? <ErrorText>{(search.error as Error).message}</ErrorText> : null}
        {submitted && !search.isLoading && !threads.length ? <Muted>No results.</Muted> : null}
        {threads.map((t) => (
          <ThreadRow key={t.id} thread={t} onPress={() => router.push(`/thread/${t.id}`)} />
        ))}
        {search.hasNextPage ? (
          <PrimaryButton label="Load more" variant="outlined" onPress={() => void search.fetchNextPage()} />
        ) : null}
      </Screen>
    </>
  );
}
