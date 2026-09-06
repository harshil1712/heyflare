import { Host, Column, Text, TextInput, Button, Spacer, useNativeState } from "@expo/ui";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";

const ink = "#111111";
const muted = "#5c5c5c";
const danger = "#b91c1c";

export default function MfaScreen() {
  const params = useLocalSearchParams<{ ticket?: string | string[] }>();
  const ticket = Array.isArray(params.ticket) ? params.ticket[0] : params.ticket;
  const { completeMfa } = useAuth();
  const code = useNativeState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const onVerify = async () => {
    if (!ticket) return;
    const codeValue = code.value.trim();
    if (!codeValue) return;
    setBusy(true);
    setError(null);
    try {
      await completeMfa(ticket, codeValue);
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
        <Text textStyle={{ fontSize: 28, fontWeight: "600", color: ink }}>Two-factor</Text>
        <Text textStyle={{ color: muted }}>Enter the code from your authenticator app, or a recovery code.</Text>
        <TextInput value={code} placeholder="123456" keyboardType="number-pad" autoFocus style={{ height: 44 }} />
        {error ? <Text textStyle={{ color: danger }}>{error}</Text> : null}
        <Spacer />
        <Button label={busy ? "Verifying…" : "Verify"} onPress={onVerify} disabled={busy} />
      </Column>
    </Host>
  );
}
