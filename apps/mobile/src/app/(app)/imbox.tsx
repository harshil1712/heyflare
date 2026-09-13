import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { ImboxResponse } from "@shared/types";
import { ThreadRow } from "@/components/ThreadRow";
import { Chip, ErrorText, HeaderAction, Loading, Muted, PrimaryButton, Screen, SectionLabel } from "@/components/ui";
import { api, keys } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ink, muted } from "@/lib/theme";

export default function ImboxScreen() {
  const router = useRouter();
  const { accounts, scope, setAccountScope } = useAuth();
  const q = useQuery({
    queryKey: [...keys.imbox, scope],
    queryFn: () => api.get<ImboxResponse>("/api/imbox"),
    enabled: accounts.length > 0,
  });

  const data = q.data;
  const fresh = data?.new_threads ?? [];
  const seen = data?.seen_threads ?? [];
  const bundles = data?.bundles ?? [];

  return (
    <Screen
      title="Imbox"
      refreshing={q.isRefetching}
      onRefresh={() => void q.refetch()}
      right={<HeaderAction label="Compose" onPress={() => router.push("/compose")} />}
    >
      {accounts.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Chip label="All" active={scope === "all"} onPress={() => void setAccountScope("all")} />
          {accounts.map((a) => (
            <Chip
              key={a.id}
              label={a.display_name || a.email}
              active={scope === a.id}
              onPress={() => void setAccountScope(a.id)}
            />
          ))}
        </View>
      ) : null}

      {!accounts.length ? (
        <View style={{ gap: 10, marginTop: 12 }}>
          <Muted>Connect Gmail on the web or in Settings to sync mail.</Muted>
          <PrimaryButton label="Open settings" variant="outlined" onPress={() => router.push("/settings")} />
        </View>
      ) : null}

      {!!data?.screener_count && (
        <Pressable
          onPress={() => router.push("/(app)/screener")}
          style={{ padding: 12, borderRadius: 10, backgroundColor: "#f0f0f0", marginTop: 4 }}
        >
          <Text style={{ fontWeight: "600", color: ink }}>
            {data.screener_count} waiting in Screener →
          </Text>
        </Pressable>
      )}

      {accounts.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
          {(data?.reply_later.length ?? 0) > 0 ? (
            <Chip
              label={`Reply Later ${data!.reply_later.length}`}
              onPress={() => router.push({ pathname: "/bucket/[name]", params: { name: "reply_later" } })}
            />
          ) : null}
          {(data?.set_aside.length ?? 0) > 0 ? (
            <Chip
              label={`Set Aside ${data!.set_aside.length}`}
              onPress={() => router.push({ pathname: "/bucket/[name]", params: { name: "set_aside" } })}
            />
          ) : null}
          <Chip label="Search" onPress={() => router.push("/search")} />
          <Chip label="Power through" onPress={() => router.push("/power-through")} />
        </View>
      ) : null}

      {q.isLoading ? <Loading /> : null}
      {accounts.length > 0 && q.error ? <ErrorText>{(q.error as Error).message}</ErrorText> : null}

      {bundles.length ? (
        <>
          <SectionLabel>Bundles</SectionLabel>
          {bundles.map((b) => (
            <Pressable
              key={b.id}
              onPress={() => router.push({ pathname: "/bundle/[id]", params: { id: b.id } })}
              style={{ paddingVertical: 12, borderBottomWidth: StyleSheetHairline }}
            >
              <Text style={{ fontWeight: "600", color: ink }}>{b.name || b.email}</Text>
              <Text style={{ color: muted, fontSize: 13 }}>
                {b.thread_count} threads · {b.latest.subject || "(no subject)"}
              </Text>
            </Pressable>
          ))}
        </>
      ) : null}

      {fresh.length ? (
        <>
          <SectionLabel>New for you</SectionLabel>
          {fresh.map((t) => (
            <ThreadRow key={t.id} thread={t} onPress={() => router.push(`/thread/${t.id}`)} />
          ))}
        </>
      ) : null}

      {seen.length ? (
        <>
          <SectionLabel>Previously seen</SectionLabel>
          {seen.map((t) => (
            <ThreadRow key={t.id} thread={t} onPress={() => router.push(`/thread/${t.id}`)} />
          ))}
        </>
      ) : null}

      {!q.isLoading && !fresh.length && !seen.length && !bundles.length && accounts.length > 0 ? (
        <Muted>Nothing new. Pull to refresh.</Muted>
      ) : null}
    </Screen>
  );
}

const StyleSheetHairline = 0.5;
