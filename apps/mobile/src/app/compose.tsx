import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { ErrorText, Field, HeaderAction, Muted, PrimaryButton, Screen } from "@/components/ui";
import { ApiError, sendMail } from "@/lib/api";
import { useAuth } from "@/lib/auth";

function parseAddrs(raw: string) {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((email) => ({ email, name: "" }));
}

export default function ComposeScreen() {
  const params = useLocalSearchParams<{
    to?: string;
    subject?: string;
    body?: string;
    threadId?: string;
    replyTo?: string;
    accountId?: string;
    draftId?: string;
  }>();
  const { accounts } = useAuth();
  const router = useRouter();
  const defaultAccount = params.accountId || accounts[0]?.id || "";

  const [accountId, setAccountId] = useState(defaultAccount);
  const [to, setTo] = useState(params.to || "");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(params.subject || "");
  const [body, setBody] = useState(params.body || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountLabel = useMemo(() => {
    const a = accounts.find((x) => x.id === accountId);
    return a?.email || "";
  }, [accounts, accountId]);

  const onSend = async () => {
    const recipients = parseAddrs(to);
    if (!recipients.length) {
      setError("Add at least one recipient.");
      return;
    }
    if (!accountId && accounts.length) {
      setError("Pick a From account.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await sendMail({
        account_id: accountId || undefined,
        thread_id: params.threadId || null,
        reply_to_message_id: params.replyTo || null,
        draft_id: params.draftId || undefined,
        to: recipients,
        cc: parseAddrs(cc),
        bcc: [],
        subject,
        body_html: `<div>${body
          .split(/\n/)
          .map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
          .join("<br/>")}</div>`,
      });
      if (res.thread_id) router.replace(`/thread/${res.thread_id}`);
      else router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: params.threadId ? "Reply" : "Compose",
          headerShown: true,
          headerBackTitle: "Back",
          headerRight: () =>
            accounts.length ? (
              <HeaderAction label={busy ? "…" : "Send"} onPress={() => void onSend()} />
            ) : null,
        }}
      />
      <Screen inset="stack">
        <Muted>From</Muted>
        {accounts.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {accounts.map((a) => (
              <PrimaryButton
                key={a.id}
                label={a.email}
                compact
                variant={accountId === a.id ? "filled" : "outlined"}
                onPress={() => setAccountId(a.id)}
              />
            ))}
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            <Muted>No accounts connected — connect Gmail in Settings first.</Muted>
            <PrimaryButton label="Open settings" variant="outlined" onPress={() => router.push("/settings")} />
          </View>
        )}
        {accountLabel ? <Muted>{accountLabel}</Muted> : null}

        <Field value={to} onChangeText={setTo} placeholder="To" autoCapitalize="none" keyboardType="email-address" />
        <Field value={cc} onChangeText={setCc} placeholder="Cc" autoCapitalize="none" keyboardType="email-address" />
        <Field value={subject} onChangeText={setSubject} placeholder="Subject" />
        <Field
          value={body}
          onChangeText={setBody}
          placeholder="Message"
          multiline
          textAlignVertical="top"
          style={{ minHeight: 220 }}
        />
        {error ? <ErrorText>{error}</ErrorText> : null}
        <PrimaryButton
          label="Cancel"
          variant="outlined"
          onPress={() => {
            if (body.trim() || to.trim()) {
              Alert.alert("Discard?", undefined, [
                { text: "Keep editing", style: "cancel" },
                { text: "Discard", style: "destructive", onPress: () => router.back() },
              ]);
            } else router.back();
          }}
        />
      </Screen>
    </>
  );
}
