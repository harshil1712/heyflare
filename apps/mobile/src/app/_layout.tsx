import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, usePathname, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, type ReactNode } from "react";
import * as Notifications from "expo-notifications";
import { AuthProvider, useAuth } from "@/lib/auth";
import { notificationPath, registerForPush } from "@/lib/push";

SplashScreen.preventAutoHideAsync();

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 15_000 } },
});

const AUTH_PATHS = ["/server", "/login", "/mfa"];

function AuthGate({ children }: { children: ReactNode }) {
  const { ready, serverUrl, user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    void SplashScreen.hideAsync();
    const inAuth = AUTH_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
    if (!serverUrl) {
      if (!pathname.includes("server")) router.replace("/(auth)/server");
      return;
    }
    if (!user) {
      if (!inAuth) router.replace("/(auth)/login");
      return;
    }
    if (inAuth) router.replace("/(app)/imbox");
  }, [ready, serverUrl, user, pathname, router]);

  useEffect(() => {
    if (!user) return;
    void registerForPush();
  }, [user]);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const path = notificationPath(response.notification.request.content.data as Record<string, unknown>);
      if (path) router.push(path as never);
    });
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      const path = notificationPath(response?.notification.request.content.data as Record<string, unknown>);
      if (path) router.push(path as never);
    });
    return () => sub.remove();
  }, [router]);

  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <AuthGate>
          <Stack
            screenOptions={{
              headerShown: false,
              animation: "default",
              headerBackTitle: "Back",
              headerBackButtonDisplayMode: "minimal",
              headerTintColor: "#111",
              headerTitleStyle: { fontWeight: "600" },
            }}
          >
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(app)" options={{ title: "Mail", headerShown: false }} />
            <Stack.Screen name="thread/[id]" options={{ headerShown: true, title: "Thread", headerBackTitle: "Back" }} />
            <Stack.Screen name="compose" options={{ headerShown: true, title: "Compose", presentation: "modal", headerBackTitle: "Back" }} />
            <Stack.Screen name="search" options={{ headerShown: true, title: "Search", headerBackTitle: "Back" }} />
            <Stack.Screen name="bucket/[name]" options={{ headerShown: true, headerBackTitle: "Back" }} />
            <Stack.Screen name="assistant/index" options={{ headerShown: true, title: "Assistant", headerBackTitle: "Back" }} />
            <Stack.Screen name="assistant/[id]" options={{ headerShown: true, title: "Chat", headerBackTitle: "Back" }} />
            <Stack.Screen name="settings" options={{ headerShown: true, title: "Settings", headerBackTitle: "Back" }} />
            <Stack.Screen name="power-through" options={{ headerShown: true, title: "Power through", headerBackTitle: "Back" }} />
            <Stack.Screen name="bundle/[id]" options={{ headerShown: true, title: "Bundle", headerBackTitle: "Back" }} />
          </Stack>
        </AuthGate>
      </AuthProvider>
    </QueryClientProvider>
  );
}
