import { Host, Column, Text, TextInput, Button, Spacer, useNativeState } from "@expo/ui";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";

const ink = "#111111";
const muted = "#5c5c5c";
const danger = "#b91c1c";

export default function LoginScreen() {
  const { login, serverUrl } = useAuth();
  const email = useNativeState("");
  const password = useNativeState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const onLogin = async () => {
    const emailValue = email.value.trim();
    const passwordValue = password.value;
    if (!emailValue || !passwordValue) return;
    setBusy(true);
    setError(null);
    try {
      const res = await login(emailValue, passwordValue);
      if (res?.mfa) {
        router.push({ pathname: "/(auth)/mfa", params: { ticket: res.mfa } });
        return;
      }
      router.replace("/(app)/imbox");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Host style={{ flex: 1 }} matchContents={false} colorScheme="light">
      <Column spacing={12} style={{ padding: 20 }}>
        <Text textStyle={{ fontSize: 28, fontWeight: "600", color: ink }}>Sign in</Text>
        <Text textStyle={{ color: muted }}>{serverUrl ?? ""}</Text>
        <TextInput
          value={email}
          placeholder="Email"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="email"
          style={{ height: 44 }}
        />
        <TextInput
          value={password}
          placeholder="Password"
          secureTextEntry
          autoComplete="password"
          style={{ height: 44 }}
        />
        {error ? <Text textStyle={{ color: danger }}>{error}</Text> : null}
        <Spacer />
        <Button label={busy ? "Signing in…" : "Sign in"} onPress={onLogin} disabled={busy} />
        <Button label="Change server" variant="outlined" onPress={() => router.replace("/(auth)/server")} />
      </Column>
    </Host>
  );
}
