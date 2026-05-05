import { silentRefresh } from "@/drive/auth";
import { useAuthStore } from "@/stores/authStore";
import { useEffect } from "react";

export function useAuth() {
  const {
    accessToken,
    expiresAt,
    login,
    logout,
    handleCallback,
    isTokenValid: checkValid,
  } = useAuthStore();

  const isAuthenticated = !!accessToken && checkValid();

  useEffect(() => {
    if (!accessToken || !expiresAt) return;

    const REFRESH_BEFORE_MS = 10 * 60 * 1000; // 10分前
    const refreshAt = expiresAt - REFRESH_BEFORE_MS;
    const delay = Math.max(0, refreshAt - Date.now());

    const timer = setTimeout(async () => {
      try {
        const result = await silentRefresh();
        if (result) {
          handleCallback(result);
        }
      } catch {
        // サイレント失敗 — 次のチェックで期限切れになればlogout
      }
    }, delay);

    // フォールバック: 期限切れ後、リフレッシュ猶予30秒を待ってlogout
    const expiryTimer = setTimeout(
      async () => {
        if (!checkValid()) {
          try {
            const result = await silentRefresh();
            if (result) {
              handleCallback(result);
              return;
            }
          } catch {
            /* failed */
          }
          if (!checkValid()) logout();
        }
      },
      Math.max(0, expiresAt - Date.now() + 30000),
    );

    return () => {
      clearTimeout(timer);
      clearTimeout(expiryTimer);
    };
  }, [expiresAt, accessToken, checkValid, handleCallback, logout]);

  return {
    isAuthenticated,
    accessToken,
    expiresAt,
    login,
    logout,
  };
}
