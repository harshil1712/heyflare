import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { ErrorText, Field, Muted, PrimaryButton, Screen } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { defaultServerUrl } from "@/lib/push";

export default function ServerScreen() {
  const { setServer, serverUrl } = useAuth();
  const [url, setUrl] = useState(serverUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (serverUrl) return;
    const def = defaultServerUrl();
    if (def) setUrl(def);
  }, [serverUrl]);

  const onContinue = async () => {
    setBusy(true);
    setError(null);
    try {
      await setServer(url);
      router.replace("/(auth)/login");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Your server" inset="auth">
      <Muted>Enter the URL of your heyflare Worker (for example https://mail.example.com).</Muted>
      <Field
        value={url}
        onChangeText={setUrl}
        placeholder="https://mail.example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        autoComplete="url"
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <View style={{ height: 8 }} />
      <PrimaryButton label={busy ? "Saving…" : "Continue"} onPress={onContinue} disabled={busy || !url.trim()} />
    </Screen>
  );
}
