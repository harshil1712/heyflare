import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { Draft } from "@shared/types";
import { ThreadRow } from "@/components/ThreadRow";
import { ErrorText, Loading, Muted, PrimaryButton, Screen } from "@/components/ui";
import { api, keys, qs, type ThreadsPage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { BUCKET_LABELS } from "@/lib/theme";

export default function BucketScreen() {
  const params = useLocalSearchParams<{ name?: string | string[] }>();
  const name = Array.isArray(params.name) ? params.name[0] : params.name;
  const title = (name && BUCKET_LABELS[name]) || name || "Mail";
  const router = useRouter();
  const { scope, accounts } = useAuth();
  const isDrafts = name === "drafts" || name === "scheduled";

  const drafts = useQuery({
    queryKey: [...keys.drafts, name, scope],
    enabled: isDrafts && accounts.length > 0,
    queryFn: () => api.get<Draft[]>("/api/drafts"),
  });

  const threads = useInfiniteQuery({
    queryKey: [...keys.threads(name || "everything"), scope],
    enabled: !!name && !isDrafts && accounts.length > 0,
    queryFn: ({ pageParam }) =>
      api.get<ThreadsPage>(`/api/threads${qs({ bucket: name, page: pageParam })}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next_page ?? undefined,
  });

  const list = threads.data?.pages.flatMap((p) => p.threads) ?? [];
  const draftList = (drafts.data ?? []).filter((d) =>
    name === "scheduled" ? d.status === "scheduled" : d.status === "draft"
  );

  return (
    <>
      <Stack.Screen options={{ title, headerShown: true }} />
      <Screen
        inset="stack"
        refreshing={isDrafts ? drafts.isRefetching : threads.isRefetching}
        onRefresh={() => void (isDrafts ? drafts.refetch() : threads.refetch())}
      >
        {(isDrafts ? drafts.isLoading : threads.isLoading) ? <Loading /> : null}
        {accounts.length > 0 && (isDrafts ? drafts.error : threads.error) ? (
          <ErrorText>{((isDrafts ? drafts.error : threads.error) as Error).message}</ErrorText>
        ) : null}

        {isDrafts ? (
          <>
            {!accounts.length ? <Muted>Connect Gmail to fill this tray.</Muted> : null}
            {isDrafts && accounts.length > 0 && !drafts.isLoading && !draftList.length ? (
              <Muted>{`No ${name}.`}</Muted>
            ) : null}
            {draftList.map((d) => (
              <PrimaryButton
                key={d.id}
                label={`${d.subject || "(no subject)"} → ${d.to.map((t) => t.email).join(", ") || "no recipients"}`}
                variant="ghost"
                onPress={() =>
                  router.push({
                    pathname: "/compose",
                    params: {
                      draftId: d.id,
                      to: d.to.map((t) => t.email).join(","),
                      subject: d.subject,
                      body: d.body_html.replace(/<[^>]+>/g, " "),
                      accountId: d.account_id,
                      threadId: d.thread_id || "",
                    },
                  })
                }
              />
            ))}
          </>
        ) : (
          <>
            {!accounts.length ? <Muted>Connect Gmail to fill this tray.</Muted> : null}
            {accounts.length > 0 && !threads.isLoading && !list.length ? <Muted>Empty.</Muted> : null}
            {list.map((t) => (
              <ThreadRow key={t.id} thread={t} onPress={() => router.push(`/thread/${t.id}`)} />
            ))}
            {threads.hasNextPage ? (
              <PrimaryButton label="Load more" variant="outlined" onPress={() => void threads.fetchNextPage()} />
            ) : null}
          </>
        )}
      </Screen>
    </>
  );
}
