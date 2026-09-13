import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Account, User } from "@shared/types";
import { api, ApiError, type MeResponse, keys } from "./api";
import {
  clearSessionToken,
  clearServerUrl,
  getServerUrl,
  getSessionToken,
  getScope,
  setScope,
  setServerUrl,
  setSessionToken,
  normalizeServerUrl,
} from "./session";
import { useQueryClient } from "@tanstack/react-query";

type AuthState = {
  ready: boolean;
  serverUrl: string | null;
  user: User | null;
  accounts: Account[];
  googleConfigured: boolean;
  scope: string;
  setServer: (url: string) => Promise<void>;
  clearServer: () => Promise<void>;
  setAccountScope: (scope: string) => Promise<void>;
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
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [scope, setScopeState] = useState("all");
  const qc = useQueryClient();

  const refreshMe = useCallback(async () => {
    const me = await api.get<MeResponse>("/api/me");
    setUser(me.user);
    setAccounts(me.accounts ?? []);
    setGoogleConfigured(!!me.google_configured);
    qc.setQueryData(keys.me, me);
  }, [qc]);

  useEffect(() => {
    (async () => {
      const url = await getServerUrl();
      setServerUrlState(url);
      setScopeState(await getScope());
      const token = await getSessionToken();
      if (url && token) {
        try {
          await refreshMe();
        } catch {
          await clearSessionToken();
          setUser(null);
          setAccounts([]);
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
    setAccounts([]);
    setServerUrlState(null);
  }, []);

  const setAccountScope = useCallback(async (next: string) => {
    await setScope(next);
    setScopeState(next);
    await qc.invalidateQueries();
  }, [qc]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ user?: User; session_token?: string; mfa_required?: boolean; ticket?: string }>(
      "/auth/login",
      { email, password }
    );
    if (res.mfa_required && res.ticket) return { mfa: res.ticket };
    if (!res.session_token) throw new ApiError(500, "Server did not return a session token. Redeploy the Worker.");
    await setSessionToken(res.session_token);
    await refreshMe();
  }, [refreshMe]);

  const completeMfa = useCallback(async (ticket: string, code: string) => {
    const res = await api.post<{ user: User; session_token?: string }>("/auth/login/2fa", { ticket, code });
    if (!res.session_token) throw new ApiError(500, "Server did not return a session token. Redeploy the Worker.");
    await setSessionToken(res.session_token);
    await refreshMe();
  }, [refreshMe]);

  const logout = useCallback(async () => {
    try {
      const { unregisterPush } = await import("./push");
      await unregisterPush();
    } catch {
      /* ignore */
    }
    try {
      await api.post("/auth/logout");
    } catch {
      /* ignore */
    }
    await clearSessionToken();
    setUser(null);
    setAccounts([]);
    qc.clear();
  }, [qc]);

  const value = useMemo(
    () => ({
      ready,
      serverUrl,
      user,
      accounts,
      googleConfigured,
      scope,
      setServer,
      clearServer,
      setAccountScope,
      login,
      completeMfa,
      logout,
      refreshMe,
    }),
    [
      ready,
      serverUrl,
      user,
      accounts,
      googleConfigured,
      scope,
      setServer,
      clearServer,
      setAccountScope,
      login,
      completeMfa,
      logout,
      refreshMe,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
