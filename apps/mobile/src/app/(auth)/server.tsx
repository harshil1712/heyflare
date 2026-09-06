import { Host, Column, Text, TextInput, Button, Spacer, useNativeState } from "@expo/ui";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useAuth } from "@/lib/auth";

const ink = "#111111";
const muted = "#5c5c5c";
const danger = "#b91c1c";

export default function ServerScreen() {
  const { setServer, serverUrl } = useAuth();
  const url = useNativeState(serverUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const onContinue = async () => {
    const value = url.value.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await setServer(value);
      router.replace("/(auth)/login");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Host style={{ flex: 1 }} matchContents={false} colorScheme="light">
      <Column spacing={12} style={{ padding: 20 }}>
        <Text textStyle={{ fontSize: 28, fontWeight: "600", color: ink }}>Your server</Text>
        <Text textStyle={{ color: muted }}>
          Enter the URL of your heyflare Worker (for example https://mail.example.com).
        </Text>
        <TextInput
          value={url}
          placeholder="https://…"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          autoComplete="url"
          style={{ height: 44 }}
        />
        {error ? <Text textStyle={{ color: danger }}>{error}</Text> : null}
        <Spacer />
        <Button label={busy ? "Saving…" : "Continue"} onPress={onContinue} disabled={busy} />
      </Column>
    </Host>
  );
}
