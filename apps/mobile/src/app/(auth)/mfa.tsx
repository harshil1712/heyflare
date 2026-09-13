import { useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ErrorText, Field, Muted, PrimaryButton, Screen } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";

export default function MfaScreen() {
  const params = useLocalSearchParams<{ ticket?: string | string[] }>();
  const ticket = Array.isArray(params.ticket) ? params.ticket[0] : params.ticket;
  const { completeMfa } = useAuth();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const onVerify = async () => {
    if (!ticket) return;
    setBusy(true);
    setError(null);
    try {
      await completeMfa(ticket, code.trim());
      router.replace("/(app)/imbox");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Two-factor" inset="auth">
      <Muted>Enter the code from your authenticator app, or a recovery code.</Muted>
      <Field value={code} onChangeText={setCode} placeholder="123456" keyboardType="number-pad" autoFocus />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <View style={{ height: 8 }} />
      <PrimaryButton label={busy ? "Verifying…" : "Verify"} onPress={onVerify} disabled={busy || !code.trim()} />
    </Screen>
  );
}
