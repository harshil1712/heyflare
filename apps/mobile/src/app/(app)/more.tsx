import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Muted, Screen, SectionLabel } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { border, ink } from "@/lib/theme";
import { BUCKET_LABELS } from "@/lib/theme";

type Link = { label: string; href: string };

const QUICK: Link[] = [
  { label: "Assistant", href: "/assistant" },
  { label: "Search", href: "/search" },
  { label: "Compose", href: "/compose" },
];

const TRAYS: Link[] = [
  { label: BUCKET_LABELS.reply_later, href: "/bucket/reply_later" },
  { label: BUCKET_LABELS.set_aside, href: "/bucket/set_aside" },
  { label: BUCKET_LABELS.bubble_up, href: "/bucket/bubble_up" },
];

const MAIL: Link[] = [
  { label: BUCKET_LABELS.paper_trail, href: "/bucket/paper_trail" },
  { label: BUCKET_LABELS.previously_seen, href: "/bucket/previously_seen" },
  { label: BUCKET_LABELS.sent, href: "/bucket/sent" },
  { label: BUCKET_LABELS.everything, href: "/bucket/everything" },
  { label: BUCKET_LABELS.trash, href: "/bucket/trash" },
  { label: BUCKET_LABELS.screened_out, href: "/bucket/screened_out" },
  { label: BUCKET_LABELS.drafts, href: "/bucket/drafts" },
  { label: BUCKET_LABELS.scheduled, href: "/bucket/scheduled" },
];

const APP: Link[] = [
  { label: "Settings", href: "/settings" },
  { label: "Power through", href: "/power-through" },
];

export default function MoreScreen() {
  const router = useRouter();
  const { user, serverUrl, accounts } = useAuth();

  return (
    <Screen title="More">
      <Muted>{user?.name || user?.email || ""}{accounts.length ? ` · ${accounts.length} account${accounts.length === 1 ? "" : "s"}` : ""}</Muted>
      <Muted>{serverUrl ?? ""}</Muted>
      {/* App (Settings) before long Mail list so it stays above the tab bar */}
      <Group title="Quick" links={QUICK} onPress={(h) => router.push(h as never)} />
      <Group title="App" links={APP} onPress={(h) => router.push(h as never)} />
      <Group title="Trays" links={TRAYS} onPress={(h) => router.push(h as never)} />
      <Group title="Mail" links={MAIL} onPress={(h) => router.push(h as never)} />
    </Screen>
  );
}

function Group({ title, links, onPress }: { title: string; links: Link[]; onPress: (href: string) => void }) {
  return (
    <View>
      <SectionLabel>{title}</SectionLabel>
      {links.map((l) => (
        <Pressable
          key={l.href}
          onPress={() => onPress(l.href)}
          style={{ paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: border }}
        >
          <Text style={{ fontSize: 16, color: ink, fontWeight: "500" }}>{l.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
