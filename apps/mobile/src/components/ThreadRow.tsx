import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ThreadSummary } from "@shared/types";
import { border, ink, muted } from "@/lib/theme";
import { formatWhen, fromLabel } from "@/lib/theme";

export function ThreadRow({
  thread,
  onPress,
  onLongPress,
  trailing,
}: {
  thread: ThreadSummary;
  onPress: () => void;
  onLongPress?: () => void;
  trailing?: string;
}) {
  const sender = fromLabel(thread.last_from.name, thread.last_from.email);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.left}>
        {thread.unread ? <View style={styles.dot} /> : <View style={styles.dotSpacer} />}
      </View>
      <View style={styles.mid}>
        <View style={styles.line1}>
          <Text style={[styles.sender, thread.unread && styles.unread]} numberOfLines={1}>
            {sender}
            {thread.message_count > 1 ? ` · ${thread.message_count}` : ""}
          </Text>
          <Text style={styles.time}>{trailing ?? formatWhen(thread.last_message_at)}</Text>
        </View>
        <Text style={styles.subject} numberOfLines={1}>
          {thread.subject || "(no subject)"}
        </Text>
        <Text style={styles.snippet} numberOfLines={1}>
          {thread.snippet || " "}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: border,
    gap: 8,
    minHeight: 64,
  },
  left: { width: 10, paddingTop: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: ink },
  dotSpacer: { width: 6, height: 6 },
  mid: { flex: 1, gap: 2 },
  line1: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  sender: { flex: 1, fontSize: 15, fontWeight: "500", color: ink },
  unread: { fontWeight: "700" },
  time: { fontSize: 12, color: muted, fontVariant: ["tabular-nums"] },
  subject: { fontSize: 14, color: ink },
  snippet: { fontSize: 13, color: muted },
});
