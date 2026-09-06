import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import {
  clearSessionToken,
  clearServerUrl,
  getServerUrl,
  getSessionToken,
  setServerUrl,
  setSessionToken,
  normalizeServerUrl,
} from "./session";

type User = { id: string; email: string; name: string };

type AuthState = {
  ready: boolean;
  serverUrl: string | null;
  user: User | null;
  setServer: (url: string) => Promise<void>;
  clearServer: () => Promise<void>;
  login: (email: string, password: string) => Promise<{ mfa?: string } | void>;
  completeMfa: (ticket: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [serverUrl, setServerUrlState] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);

  const refreshMe = useCallback(async () => {
    const me = await api.get<{ user: User | null }>("/api/me");
    setUser(me.user);
  }, []);

  useEffect(() => {
    (async () => {
      const url = await getServerUrl();
      setServerUrlState(url);
      const token = await getSessionToken();
      if (url && token) {
        try {
          await refreshMe();
        } catch {
          await clearSessionToken();
          setUser(null);
        }
      }
      setReady(true);
    })();
  }, [refreshMe]);

  const setServer = useCallback(async (url: string) => {
    const normalized = normalizeServerUrl(url);
    await setServerUrl(normalized);
    setServerUrlState(normalized);
  }, []);

  const clearServer = useCallback(async () => {
    await clearSessionToken();
    await clearServerUrl();
    setUser(null);
    setServerUrlState(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ user?: User; session_token?: string; mfa_required?: boolean; ticket?: string }>(
      "/auth/login",
      { email, password }
    );
    if (res.mfa_required && res.ticket) return { mfa: res.ticket };
    if (!res.session_token) throw new ApiError(500, "Server did not return a session token. Redeploy the Worker.");
    await setSessionToken(res.session_token);
    setUser(res.user ?? null);
  }, []);

  const completeMfa = useCallback(async (ticket: string, code: string) => {
    const res = await api.post<{ user: User; session_token?: string }>("/auth/login/2fa", { ticket, code });
    if (!res.session_token) throw new ApiError(500, "Server did not return a session token. Redeploy the Worker.");
    await setSessionToken(res.session_token);
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* ignore */
    }
    await clearSessionToken();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ ready, serverUrl, user, setServer, clearServer, login, completeMfa, logout, refreshMe }),
    [ready, serverUrl, user, setServer, clearServer, login, completeMfa, logout, refreshMe]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
