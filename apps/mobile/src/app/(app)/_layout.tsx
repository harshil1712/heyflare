import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useQuery } from "@tanstack/react-query";
import { api, keys } from "@/lib/api";
import type { Counts } from "@shared/types";
import { useAuth } from "@/lib/auth";

export const unstable_settings = {
  initialRouteName: "imbox",
};

function badge(n: number | undefined) {
  if (!n || n <= 0) return undefined;
  return n > 99 ? "99+" : String(n);
}

export default function AppTabs() {
  const { accounts } = useAuth();
  const counts = useQuery({
    queryKey: keys.counts,
    queryFn: () => api.get<Counts>("/api/counts"),
    refetchInterval: 30_000,
    enabled: accounts.length > 0,
  });
  const c = counts.data;
  const imboxBadge = badge(c?.imbox_new);
  const screenerBadge = badge(c?.screener);

  return (
    <NativeTabs disableTransparentOnScrollEdge minimizeBehavior="never">
      <NativeTabs.Trigger name="imbox">
        <NativeTabs.Trigger.Icon
          sf={{ default: "tray", selected: "tray.fill" }}
          md={{ default: "inbox", selected: "inbox" }}
        />
        <NativeTabs.Trigger.Label>Imbox</NativeTabs.Trigger.Label>
        {imboxBadge ? <NativeTabs.Trigger.Badge>{imboxBadge}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="feed">
        <NativeTabs.Trigger.Icon
          sf={{ default: "dot.radiowaves.up.forward", selected: "dot.radiowaves.up.forward" }}
          md="rss_feed"
        />
        <NativeTabs.Trigger.Label>Feed</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="calendar">
        <NativeTabs.Trigger.Icon
          sf={{ default: "calendar", selected: "calendar" }}
          md="calendar_month"
        />
        <NativeTabs.Trigger.Label>Calendar</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="screener">
        <NativeTabs.Trigger.Icon
          sf={{ default: "shield", selected: "shield.fill" }}
          md="shield"
        />
        <NativeTabs.Trigger.Label>Screener</NativeTabs.Trigger.Label>
        {screenerBadge ? <NativeTabs.Trigger.Badge>{screenerBadge}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="more">
        <NativeTabs.Trigger.Icon
          sf={{ default: "line.3.horizontal", selected: "line.3.horizontal" }}
          md="menu"
        />
        <NativeTabs.Trigger.Label>More</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
