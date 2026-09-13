import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import type { CalendarRange, CalEvent } from "@shared/types";
import { ErrorText, Loading, Muted, Screen, SectionLabel } from "@/components/ui";
import { api, keys, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { border, ink, muted } from "@/lib/theme";

function dayKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function CalendarScreen() {
  const { scope } = useAuth();
  const from = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return dayKey(d);
  }, []);
  const to = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 21);
    return dayKey(d);
  }, []);

  const q = useQuery({
    queryKey: [...keys.calEvents(from, to), scope],
    queryFn: () => api.get<CalendarRange>(`/api/calendar/events${qs({ from, to })}`),
  });

  const today = dayKey(new Date());
  const events = (q.data?.events ?? []).slice().sort((a, b) => a.starts_at - b.starts_at);
  const todayEvents = events.filter((e) => dayKey(new Date(e.starts_at)) === today);
  const upcoming = events.filter((e) => dayKey(new Date(e.starts_at)) > today).slice(0, 40);

  return (
    <Screen title="Calendar" refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      <Muted>{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</Muted>
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorText>{(q.error as Error).message}</ErrorText> : null}

      <SectionLabel>Today</SectionLabel>
      {!q.isLoading && !todayEvents.length ? <Muted>Nothing scheduled today.</Muted> : null}
      {todayEvents.map((e) => (
        <EventRow key={e.id} e={e} />
      ))}

      <SectionLabel>Upcoming</SectionLabel>
      {!q.isLoading && !upcoming.length ? <Muted>No upcoming events in the next three weeks.</Muted> : null}
      {upcoming.map((e) => (
        <EventRow key={e.id} e={e} />
      ))}
    </Screen>
  );
}

function EventRow({ e }: { e: CalEvent }) {
  const start = new Date(e.starts_at);
  return (
    <View style={{ paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: border, gap: 2 }}>
      <Text style={{ fontWeight: "600", color: ink }}>{e.title || "(untitled)"}</Text>
      <Text style={{ color: muted, fontSize: 13 }}>
        {e.all_day
          ? start.toLocaleDateString()
          : start.toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
        {e.location ? ` · ${e.location}` : ""}
      </Text>
    </View>
  );
}
