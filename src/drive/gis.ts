/// <reference types="vite/client" />
import { OAUTH_CONFIG } from "@/types";
import { AuthError } from "@/utils/errors";

export interface TokenResponse {
  access_token: string;
  expires_in: string | number;
  scope: string;
  error?: string;
  error_description?: string;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: TokenResponse) => void;
            error_callback?: (error: unknown) => void;
          }) => { requestAccessToken: (opts?: Record<string, string>) => void };
        };
      };
    };
  }
}

let tokenClient: {
  requestAccessToken: (opts?: Record<string, string>) => void;
} | null = null;
let currentResolve: ((res: TokenResponse) => void) | null = null;
let currentReject: ((err: unknown) => void) | null = null;
/** Guard against concurrent requestAccessToken calls overwriting callbacks */
let pendingTokenPromise: Promise<TokenResponse> | null = null;

export function initGIS() {
  if (!window.google?.accounts?.oauth2) {
    throw new AuthError(
      "Google Identity Services が読み込まれていません。通信環境を確認してください。",
    );
  }

  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: OAUTH_CONFIG.clientId,
      scope: OAUTH_CONFIG.scope,
      callback: (response: TokenResponse) => {
        if (response.error) {
          if (currentReject) currentReject(response);
        } else {
          if (currentResolve) currentResolve(response);
        }
      },
      error_callback: (error: unknown) => {
        if (currentReject) currentReject(error);
      },
    });
  }
}

export function requestAccessToken(
  prompt?: "none" | "consent" | "select_account",
  scopeOverride?: string,
): Promise<TokenResponse> {
  // 対話的ログイン (prompt !== "none") は pending のサイレント認証を
  // キャンセルして新しいポップアップを開く。ユーザー操作から5秒以内に
  // 手動ログインした場合にサイレント認証のタイムアウト reject を返さない。
  if (prompt !== "none" && pendingTokenPromise) {
    const oldReject = currentReject;
    pendingTokenPromise = null;
    currentResolve = null;
    currentReject = null;
    // silentRefresh 側は popup_failed を catch して null を返すため安全
    oldReject?.({ error: "superseded", type: "popup_failed" });
  }

  // If a token request is already in progress, return the same promise
  // to avoid overwriting the resolve/reject callbacks (race condition).
  if (pendingTokenPromise) return pendingTokenPromise;

  pendingTokenPromise = new Promise<TokenResponse>((resolve, reject) => {
    try {
      initGIS();
      currentResolve = (res) => {
        pendingTokenPromise = null;
        resolve(res);
      };
      currentReject = (err) => {
        pendingTokenPromise = null;
        reject(err);
      };

      const overrides: Record<string, string> = {};
      if (prompt) overrides.prompt = prompt;
      if (scopeOverride) overrides.scope = scopeOverride;

      // prompt=none (silent auth) はコールバック未発火でハングする場合がある。
      // タイムアウトで pendingTokenPromise を解放し、後続の対話的ログインをブロックしない。
      if (prompt === "none") {
        setTimeout(() => {
          if (pendingTokenPromise) {
            pendingTokenPromise = null;
            reject({ error: "timeout", type: "popup_failed" });
          }
        }, 5_000);
      }

      if (Object.keys(overrides).length > 0) {
        tokenClient?.requestAccessToken(overrides);
      } else {
        tokenClient?.requestAccessToken();
      }
    } catch (e) {
      pendingTokenPromise = null;
      reject(e);
    }
  });

  return pendingTokenPromise;
}
