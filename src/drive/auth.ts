import { SESSION_STORAGE_KEYS } from "@/config/app";
import { OAUTH_CONFIG } from "@/types";
import { AuthError } from "@/utils/errors";
import { requestAccessToken } from "./gis";

/** サイレント認証失敗フラグの TTL (5分) — ネットワーク断復帰後に再試行を許可する。 */
const SILENT_FAILED_TTL_MS = 5 * 60 * 1000;
/** トークン期限切れ判定に使う余裕マージン (5分) */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

const TOKEN_SESSION_KEYS = [
  SESSION_STORAGE_KEYS.accessToken,
  SESSION_STORAGE_KEYS.expiresAt,
  SESSION_STORAGE_KEYS.accessScope,
] as const;

function clearSessionToken(): void {
  for (const key of TOKEN_SESSION_KEYS) {
    sessionStorage.removeItem(key);
  }
}

function assertOAuthConfigured(): void {
  if (!OAUTH_CONFIG.clientId.trim()) {
    throw new AuthError("Google OAuth クライアントIDが設定されていません");
  }
}

/**
 * OAuth2 ログインを開始し、ポップアップを表示する (GIS)
 */
export async function startLogin(
  prompt?: "select_account" | "consent",
  scopeOverride?: string,
): Promise<{ accessToken: string; expiresIn: number; scope: string } | null> {
  assertOAuthConfigured();
  try {
    const res = await requestAccessToken(prompt, scopeOverride);
    return {
      accessToken: res.access_token,
      expiresIn: Number(res.expires_in),
      scope: res.scope,
    };
  } catch (e: unknown) {
    const err = e as { error_description?: string; error?: string };
    throw new AuthError(
      `認証エラー: ${err?.error_description || err?.error || "ログインに失敗しました"}`,
    );
  }
}

/**
 * prompt=none を使ってサイレント再認証を試みる。
 * ブロックされた場合は null を返す（エラー画面には飛ばさずログインボタンを表示させる）。
 */
export async function silentRefresh(
  scopeOverride?: string,
): Promise<{ accessToken: string; expiresIn: number; scope: string } | null> {
  assertOAuthConfigured();
  try {
    const res = await requestAccessToken("none", scopeOverride);
    return {
      accessToken: res.access_token,
      expiresIn: Number(res.expires_in),
      scope: res.scope,
    };
  } catch (e: unknown) {
    const err = e as { error?: string; type?: string };
    // サイレントブロック（サードパーティクッキー制限など）や未ログイン時はフォールバック
    if (err?.error === "interaction_required" || err?.type === "popup_failed") {
      markSilentAuthFailed();
      return null;
    }
    throw e;
  }
}

export function markSilentAuthFailed(): void {
  sessionStorage.setItem(
    SESSION_STORAGE_KEYS.oauthSilentFailed,
    String(Date.now()),
  );
}

export function clearSilentAuthFailed(): void {
  sessionStorage.removeItem(SESSION_STORAGE_KEYS.oauthSilentFailed);
}

export function hasSilentAuthFailed(): boolean {
  const value = sessionStorage.getItem(SESSION_STORAGE_KEYS.oauthSilentFailed);
  if (!value) return false;
  const ts = Number(value);
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > SILENT_FAILED_TTL_MS) {
    sessionStorage.removeItem(SESSION_STORAGE_KEYS.oauthSilentFailed);
    return false;
  }
  return true;
}

/**
 * アクセストークンを失効させる。
 */
export async function revokeToken(token: string): Promise<void> {
  await fetch(OAUTH_CONFIG.revokeEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}

/**
 * トークンを sessionStorage に保存する。
 * - localStorage（永続・全タブ共有）は使わない
 * - sessionStorage はタブ内のみ有効で、タブを閉じると消える
 * - ページリロード時にはトークンが復元される
 */
export function saveToken(
  accessToken: string,
  expiresIn: number,
  scope: string | null,
): void {
  const expiresAt = Date.now() + expiresIn * 1000;
  sessionStorage.setItem(SESSION_STORAGE_KEYS.accessToken, accessToken);
  sessionStorage.setItem(SESSION_STORAGE_KEYS.expiresAt, String(expiresAt));
  if (scope) {
    sessionStorage.setItem(SESSION_STORAGE_KEYS.accessScope, scope);
  } else {
    sessionStorage.removeItem(SESSION_STORAGE_KEYS.accessScope);
  }
}

/**
 * sessionStorage からトークンを復元する。
 * 期限切れの場合は掃除して null を返す。
 */
export function loadToken(): {
  accessToken: string;
  expiresAt: number;
  scope: string | null;
} | null {
  const accessToken = sessionStorage.getItem(SESSION_STORAGE_KEYS.accessToken);
  const expiresAtStr = sessionStorage.getItem(SESSION_STORAGE_KEYS.expiresAt);
  if (!accessToken || !expiresAtStr) return null;

  const expiresAt = Number(expiresAtStr);
  if (!isTokenValid(expiresAt)) {
    clearSessionToken();
    return null;
  }

  const scope = sessionStorage.getItem(SESSION_STORAGE_KEYS.accessScope);
  sessionStorage.setItem(SESSION_STORAGE_KEYS.accessToken, accessToken);
  sessionStorage.setItem(SESSION_STORAGE_KEYS.expiresAt, expiresAtStr);
  if (scope) {
    sessionStorage.setItem(SESSION_STORAGE_KEYS.accessScope, scope);
  }

  return {
    accessToken,
    expiresAt,
    scope,
  };
}

/**
 * トークンをストレージから削除する。
 */
export function clearToken(): void {
  clearSessionToken();
}

/**
 * 現在のトークンがまだ有効かを判定する。5 分の余裕を見て期限切れ扱いにする。
 */
export function isTokenValid(expiresAt: number | null): boolean {
  if (!expiresAt) return false;
  return Date.now() < expiresAt - TOKEN_EXPIRY_MARGIN_MS;
}
