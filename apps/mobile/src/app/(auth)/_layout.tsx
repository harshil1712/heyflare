import { Stack } from "expo-router";

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        title: "heyflare",
        headerBackTitle: "Back",
        headerShadowVisible: false,
        headerTintColor: "#111",
      }}
    />
  );
}
