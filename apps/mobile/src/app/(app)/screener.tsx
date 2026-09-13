import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import type { ScreenStatus } from "@shared/types";
import { Chip, ErrorText, Loading, Muted, PrimaryButton, Screen } from "@/components/ui";
import { api, invalidateMail, keys, type ScreenerSender } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { border, ink, muted } from "@/lib/theme";
import { fromLabel } from "@/lib/theme";

export default function ScreenerScreen() {
  const router = useRouter();
  const { scope, accounts } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: [...keys.screener, scope],
    queryFn: () => api.get<{ senders: ScreenerSender[] }>("/api/screener"),
    enabled: accounts.length > 0,
  });
  const [dest, setDest] = useState<Record<string, Exclude<ScreenStatus, "pending" | "screened_out">>>({});

  const decide = useMutation({
    mutationFn: (p: { contact_id: string; decision: ScreenStatus }) => api.post("/api/screener/decide", p),
    onSuccess: () => {
      invalidateMail(qc);
      void q.refetch();
    },
  });

  const senders = q.data?.senders ?? [];

  return (
    <Screen title="Screener" refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      <Muted>Decide where mail from new senders should land.</Muted>
      {q.isLoading ? <Loading /> : null}
      {accounts.length > 0 && q.error ? <ErrorText>{(q.error as Error).message}</ErrorText> : null}
      {!accounts.length ? (
        <View style={{ gap: 10 }}>
          <Muted>Connect Gmail to use the Screener.</Muted>
          <PrimaryButton label="Open settings" variant="outlined" onPress={() => router.push("/settings")} />
        </View>
      ) : null}
      {accounts.length > 0 && !q.isLoading && !senders.length ? <Muted>Nothing waiting.</Muted> : null}
      {senders.map((s) => {
        const id = s.contact.id;
        const choice = dest[id] ?? s.suggestion;
        return (
          <View key={id} style={{ paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: border, gap: 10 }}>
            <Text style={{ fontSize: 16, fontWeight: "700", color: ink }}>
              {fromLabel(s.contact.name, s.contact.email)}
            </Text>
            <Text style={{ color: muted, fontSize: 13 }}>{s.contact.email}</Text>
            {s.threads[0] ? (
              <Text style={{ color: muted }} numberOfLines={2}>
                {s.threads[0].subject} — {s.threads[0].snippet}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {(["imbox", "feed", "paper_trail"] as const).map((d) => (
                <Chip key={d} label={d === "paper_trail" ? "Paper Trail" : d[0].toUpperCase() + d.slice(1)} active={choice === d} onPress={() => setDest((m) => ({ ...m, [id]: d }))} />
              ))}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <PrimaryButton
                label="Let them in"
                onPress={() => decide.mutate({ contact_id: id, decision: choice })}
              />
              <PrimaryButton
                label="Screen out"
                variant="outlined"
                onPress={() => decide.mutate({ contact_id: id, decision: "screened_out" })}
              />
              {s.threads[0] ? (
                <PrimaryButton
                  label="Peek"
                  variant="ghost"
                  onPress={() => router.push({ pathname: "/thread/[id]", params: { id: s.threads[0].id, peek: "1" } })}
                />
              ) : null}
            </View>
          </View>
        );
      })}
    </Screen>
  );
}
