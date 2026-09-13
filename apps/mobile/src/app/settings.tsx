import { Text, View } from "react-native";
import { Muted, PrimaryButton, Screen, SectionLabel } from "@/components/ui";
import { connectGmailLink } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { oauthReturnUrl, registerForPush } from "@/lib/push";
import { ink } from "@/lib/theme";
import * as WebBrowser from "expo-web-browser";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";

WebBrowser.maybeCompleteAuthSession();

export default function SettingsScreen() {
  const { user, serverUrl, accounts, scope, setAccountScope, logout, clearServer, refreshMe, googleConfigured } =
    useAuth();
  const router = useRouter();
  const [pushStatus, setPushStatus] = useState<string | null>(null);

  return (
    <>
      <Stack.Screen options={{ title: "Settings", headerShown: true }} />
      <Screen inset="stack">
        <Text style={{ fontSize: 20, fontWeight: "700", color: ink }}>{user?.name || user?.email}</Text>
        <Muted>{user?.email ?? ""}</Muted>
        <Muted>{serverUrl ?? ""}</Muted>

        <SectionLabel>Account scope</SectionLabel>
        <View style={{ gap: 8 }}>
          <PrimaryButton
            label="All accounts"
            variant={scope === "all" ? "filled" : "outlined"}
            onPress={() => void setAccountScope("all")}
          />
          {accounts.map((a) => (
            <PrimaryButton
              key={a.id}
              label={`${a.display_name || a.email} · ${a.sync_status}`}
              variant={scope === a.id ? "filled" : "outlined"}
              onPress={() => void setAccountScope(a.id)}
            />
          ))}
        </View>

        <SectionLabel>Gmail</SectionLabel>
        {googleConfigured ? (
          <PrimaryButton
            label="Connect Gmail…"
            onPress={async () => {
              const { url } = await connectGmailLink();
              await WebBrowser.openAuthSessionAsync(url, oauthReturnUrl());
              await refreshMe();
            }}
          />
        ) : (
          <Muted>Google OAuth is not configured on this server.</Muted>
        )}

        <SectionLabel>Notifications</SectionLabel>
        <PrimaryButton
          label="Enable push notifications"
          variant="outlined"
          onPress={async () => {
            const r = await registerForPush();
            setPushStatus(
              r.ok
                ? "This device will get Imbox alerts."
                : r.reason === "simulator"
                  ? "Push needs a physical device and a TestFlight / EAS build."
                  : r.reason === "missing_eas_project"
                    ? "Run eas init and rebuild so the Expo project id is set."
                    : r.reason === "denied"
                      ? "Notifications are disabled in iOS Settings."
                      : r.reason || "Could not register."
            );
          }}
        />
        {pushStatus ? <Muted>{pushStatus}</Muted> : null}
        <Muted>
          Push uses Expo → APNs. Requires a production/preview EAS build (not Expo Go) and a deployed Worker with
          migration 0022.
        </Muted>

        <SectionLabel>Session</SectionLabel>
        <PrimaryButton
          label="Sign out"
          onPress={async () => {
            await logout();
            router.replace("/(auth)/login");
          }}
        />
        <PrimaryButton
          label="Change server"
          variant="outlined"
          onPress={async () => {
            await logout();
            await clearServer();
            router.replace("/(auth)/server");
          }}
        />
        <Muted>Use the web app for deeper Settings (security / 2FA enroll, AI keys, domains).</Muted>
      </Screen>
    </>
  );
}
