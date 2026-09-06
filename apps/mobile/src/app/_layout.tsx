import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, usePathname, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, type ReactNode } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";

SplashScreen.preventAutoHideAsync();

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 15_000 } },
});

function AuthGate({ children }: { children: ReactNode }) {
  const { ready, serverUrl, user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    void SplashScreen.hideAsync();
    const inAuth = pathname.startsWith("/server") || pathname.startsWith("/login") || pathname.startsWith("/mfa");
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

  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <AuthGate>
          <Stack screenOptions={{ headerShown: false, animation: "none" }}>
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(app)" />
            <Stack.Screen name="thread/[id]" options={{ headerShown: true, title: "Thread", animation: "default" }} />
          </Stack>
        </AuthGate>
      </AuthProvider>
    </QueryClientProvider>
  );
}
