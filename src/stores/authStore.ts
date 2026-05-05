import { setOnInsufficientScope, setTokenProvider } from "@/drive/api";
import {
  clearToken,
  hasSilentAuthFailed,
  isTokenValid,
  loadToken,
  revokeToken,
  saveToken,
  silentRefresh,
  startLogin,
} from "@/drive/auth";
import type { AuthState } from "@/types";
import { create } from "zustand";
import { useUIStore } from "./uiStore";

async function fetchUserProfile(
  accessToken: string,
  retryCount = 0,
): Promise<AuthState["user"]> {
  try {
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      if (retryCount < 1) {
        await new Promise((r) => setTimeout(r, 2000));
        return fetchUserProfile(accessToken, retryCount + 1);
      }
      return null;
    }

    const profile = (await response.json()) as {
      email?: string;
      name?: string;
      picture?: string;
    };

    if (!profile.email && !profile.name && !profile.picture) {
      return null;
    }

    return {
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    };
  } catch (e) {
    console.warn("Failed to fetch user profile", e);
    if (retryCount < 1) {
      await new Promise((r) => setTimeout(r, 2000));
      return fetchUserProfile(accessToken, retryCount + 1);
    }
    return null;
  }
}

export const useAuthStore = create<AuthState>((set, get) => {
  // sessionStorage に残っている認証状態を復元する。
  const saved = loadToken();

  const hydrateUser = (accessToken: string) => {
    void fetchUserProfile(accessToken).then((user) => {
      if (get().accessToken !== accessToken) {
        return;
      }
      set({ user });
    });
  };

  // トークン期限切れ時にサイレントリフレッシュを試みるプロバイダ。
  // 同時に複数の API 呼び出しがリフレッシュを要求する場合に備えて重複排除する。
  let inlineRefreshPromise: Promise<string> | null = null;

  const tokenProvider = async (): Promise<string> => {
    const state = get();
    if (state.accessToken && isTokenValid(state.expiresAt)) {
      return state.accessToken;
    }

    // トークンが期限切れ — サイレントリフレッシュを試みる
    if (inlineRefreshPromise) return inlineRefreshPromise;

    inlineRefreshPromise = (async () => {
      try {
        if (hasSilentAuthFailed())
          throw new Error("Silent auth previously failed");
        const result = await silentRefresh();
        if (result) {
          get().handleCallback(result);
          return result.accessToken;
        }
      } catch {
        /* failed */
      }
      throw new Error("Token expired");
    })().finally(() => {
      inlineRefreshPromise = null;
    });

    return inlineRefreshPromise;
  };

  if (saved && isTokenValid(saved.expiresAt)) {
    setTokenProvider(tokenProvider);
    hydrateUser(saved.accessToken);
  }

  // スコープ不足を検出した場合、1回だけ再認証を促す
  let insufficientScopePrompted = false;
  setOnInsufficientScope(() => {
    if (insufficientScopePrompted) return;
    insufficientScopePrompted = true;
    useUIStore.getState().openConfirmDialog(
      "権限が不足しています。Googleアカウントの再認証が必要です。",
      () => {
        insufficientScopePrompted = false;
        void get().login("consent");
      },
      { confirmLabel: "再認証" },
    );
  });

  return {
    accessToken: saved?.accessToken ?? null,
    expiresAt: saved?.expiresAt ?? null,
    scope: saved?.scope ?? null,
    user: null,
    authError: null,

    login: async (
      prompt?: "select_account" | "consent",
      scopeOverride?: string,
    ) => {
      try {
        const result = await startLogin(prompt, scopeOverride);
        if (result) {
          get().handleCallback(result);
        }
      } catch (e) {
        console.warn("Login failed:", e);
      }
    },

    handleCallback: async ({ accessToken, expiresIn, scope }) => {
      saveToken(accessToken, expiresIn, scope);
      const expiresAt = Date.now() + expiresIn * 1000;
      insufficientScopePrompted = false;

      set({
        accessToken,
        expiresAt,
        scope,
        user: null,
        authError: null,
      });

      setTokenProvider(tokenProvider);

      hydrateUser(accessToken);
    },

    logout: () => {
      const { accessToken } = get();
      if (accessToken) {
        void revokeToken(accessToken).catch((e) =>
          console.warn("Token revocation failed", e),
        );
      }
      clearToken();
      set({
        accessToken: null,
        expiresAt: null,
        scope: null,
        user: null,
      });
    },

    isTokenValid: () => {
      return isTokenValid(get().expiresAt);
    },

    getToken: async () => {
      const { accessToken, expiresAt } = get();
      if (!accessToken || !isTokenValid(expiresAt)) {
        throw new Error("Token expired");
      }
      return accessToken;
    },

    trySilentRefresh: async () => {
      if (get().accessToken) return;

      // Google のログインセッションが有効なら prompt=none でサイレント再認証を試みる
      if (!hasSilentAuthFailed()) {
        try {
          const result = await silentRefresh();
          if (result) {
            get().handleCallback(result);
            return;
          }
        } catch (e) {
          console.warn("Silent refresh failed:", e);
        }
      }

      if (!get().accessToken) {
        set({ authError: "silent_refresh_failed" });
      }
    },
  };
});
