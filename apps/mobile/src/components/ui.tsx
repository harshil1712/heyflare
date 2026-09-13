import { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { bg, border, ink, muted, surface } from "@/lib/theme";

type ScreenInset = "tabs" | "stack" | "auth";

export function Screen({
  title,
  children,
  right,
  onRefresh,
  refreshing,
  style,
  scroll = true,
  inset = "tabs",
}: {
  title?: string;
  children: ReactNode;
  right?: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  style?: StyleProp<ViewStyle>;
  scroll?: boolean;
  /** tabs = large title + bottom tab padding; stack = under nav header; auth = under auth header */
  inset?: ScreenInset;
}) {
  const edges = inset === "stack" ? (["left", "right"] as const) : (["top", "left", "right"] as const);
  // NativeTabs floating pill + dimming overlay need extra clearance
  const padBottom = inset === "tabs" ? 140 : 28;

  const header =
    title || right ? (
      <View style={styles.titleRow}>
        {title ? <Text style={styles.title}>{title}</Text> : <View style={{ flex: 1 }} />}
        {right}
      </View>
    ) : null;

  const body = scroll ? (
    <ScrollView
      contentContainerStyle={[styles.pad, { paddingBottom: padBottom }, style]}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
    >
      {header}
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.pad, { flex: 1, paddingBottom: padBottom }, style]}>
      {header}
      {children}
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={[...edges]}>
      {body}
    </SafeAreaView>
  );
}

export function SectionLabel({ children }: { children: string }) {
  return <Text style={styles.section}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <Text style={styles.error}>{children}</Text>;
}

export function Loading() {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={ink} />
    </View>
  );
}

export function HeaderAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [{ opacity: pressed ? 0.5 : 1, paddingVertical: 6, paddingHorizontal: 4 }]}
    >
      <Text style={styles.headerAction}>{label}</Text>
    </Pressable>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  variant = "filled",
  compact,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "filled" | "outlined" | "ghost";
  compact?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        compact && styles.btnCompact,
        variant === "filled" && styles.btnFilled,
        variant === "outlined" && styles.btnOutlined,
        variant === "ghost" && styles.btnGhost,
        disabled && { opacity: 0.4 },
        pressed && !disabled && { opacity: 0.7 },
      ]}
    >
      <Text
        style={[
          styles.btnLabel,
          compact && { fontSize: 14 },
          variant === "filled" && { color: "#fff" },
          variant !== "filled" && { color: ink },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Chip({ label, onPress, active }: { label: string; onPress?: () => void; active?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps) {
  const { style, ...rest } = props;
  return <TextInput {...rest} placeholderTextColor="#9a9a9a" style={[styles.field, style]} />;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: surface },
  pad: { paddingHorizontal: 16, gap: 10 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4, gap: 12 },
  title: { fontSize: 28, fontWeight: "700", color: ink, letterSpacing: -0.4, flexShrink: 1 },
  headerAction: { fontSize: 16, fontWeight: "600", color: ink },
  section: {
    marginTop: 12,
    fontSize: 11,
    fontWeight: "600",
    color: muted,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  muted: { color: muted, fontSize: 14, lineHeight: 20 },
  error: { color: ink, fontSize: 14, fontWeight: "500" },
  center: { paddingVertical: 24, alignItems: "center" },
  btn: {
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  btnCompact: { paddingVertical: 8, paddingHorizontal: 12, minHeight: 36, alignSelf: "flex-start" },
  btnFilled: { backgroundColor: ink },
  btnOutlined: { borderWidth: 1, borderColor: border, backgroundColor: surface },
  btnGhost: { backgroundColor: bg },
  btnLabel: { fontSize: 15, fontWeight: "600" },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: bg,
    borderWidth: 1,
    borderColor: border,
  },
  chipActive: { backgroundColor: ink, borderColor: ink },
  chipText: { fontSize: 13, color: ink, fontWeight: "500" },
  chipTextActive: { color: "#fff" },
  field: {
    borderWidth: 1,
    borderColor: border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    lineHeight: 22,
    color: ink,
    backgroundColor: "#fff",
  },
});
