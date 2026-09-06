import { Host, Column, Text, Button, Spacer } from "@expo/ui";
import { useRouter } from "expo-router";
import { useAuth } from "@/lib/auth";

export default function SettingsScreen() {
  const { user, serverUrl, logout, clearServer } = useAuth();
  const router = useRouter();

  return (
    <Host style={{ flex: 1 }} matchContents={false} colorScheme="light">
      <Column spacing={12} style={{ padding: 20 }}>
        <Text textStyle={{ fontSize: 28, fontWeight: "700", color: "#111111" }}>Settings</Text>
        <Text textStyle={{ fontWeight: "600", color: "#111111" }}>{user?.name || user?.email || ""}</Text>
        <Text textStyle={{ color: "#5c5c5c" }}>{user?.email ?? ""}</Text>
        <Text textStyle={{ color: "#5c5c5c" }}>{serverUrl ?? ""}</Text>
        <Spacer />
        <Button
          label="Sign out"
          onPress={async () => {
            await logout();
            router.replace("/(auth)/login");
          }}
        />
        <Button
          label="Change server"
          variant="outlined"
          onPress={async () => {
            await logout();
            await clearServer();
            router.replace("/(auth)/server");
          }}
        />
        <Text textStyle={{ fontSize: 12, color: "#5c5c5c" }}>
          Native Expo app (Expo UI). APNs push and more trays come next. The old Tauri WKWebView shell remains under apps/ios for now.
        </Text>
      </Column>
    </Host>
  );
}
