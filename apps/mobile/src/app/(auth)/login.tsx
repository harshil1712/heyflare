import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { ErrorText, Field, Muted, PrimaryButton, Screen } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";

export default function LoginScreen() {
  const { login, serverUrl } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const onLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await login(email.trim(), password);
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
    <Screen title="Sign in" inset="auth">
      <Muted>{serverUrl ?? ""}</Muted>
      <Field
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        autoComplete="email"
      />
      <Field
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        secureTextEntry
        autoComplete="password"
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <View style={{ height: 8 }} />
      <PrimaryButton label={busy ? "Signing in…" : "Sign in"} onPress={onLogin} disabled={busy || !email || !password} />
      <PrimaryButton label="Change server" variant="outlined" onPress={() => router.replace("/(auth)/server")} />
    </Screen>
  );
}
