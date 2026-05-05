import {
  MECHANISM_URL,
  PRIVACY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
} from "@/config/app";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import SetupPage from "@/pages/SetupPage";
import SharePage from "@/pages/SharePage";
import UnlockPage from "@/pages/UnlockPage";
import VaultPage from "@/pages/VaultPage";
import { useAuthStore } from "@/stores/authStore";
import { useUIStore } from "@/stores/uiStore";
import { useVaultStore } from "@/stores/vaultStore";
import { Component, useEffect, useRef } from "react";
import type { ErrorInfo, ReactNode } from "react";

function getRoute(): "share" | "main" {
  const path = window.location.pathname;
  if (path === "/share") return "share";
  return "main";
}

/* ---------- Error Boundary ---------- */
interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
          <div className="w-full max-w-md rounded-lg bg-white p-8 text-center shadow-md dark:bg-gray-800">
            <h1 className="mb-2 text-xl font-bold text-gray-900 dark:text-gray-100">
              予期しないエラーが発生しました
            </h1>
            <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
              ページを再読み込みしてください。問題が解決しない場合は、ブラウザのキャッシュを削除してお試しください。
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              再読み込み
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const route = getRoute();
  const { isSetup, isUnlocked, checkSetup } = useVaultStore();
  const { isAuthenticated } = useAuth();
  useTheme();

  useEffect(() => {
    if (isAuthenticated && isSetup === null) {
      checkSetup();
    }
  }, [isAuthenticated, isSetup, checkSetup]);

  // 共有専用ルート
  if (route === "share")
    return (
      <ErrorBoundary>
        <SharePage />
      </ErrorBoundary>
    );

  // 未ログイン時
  if (!isAuthenticated) {
    return <LoginPage />;
  }

  // 初期設定の確認中
  if (isSetup === null) {
    return <LoadingScreen message="Vaultの状態を確認中..." />;
  }

  // 初回セットアップ
  if (!isSetup)
    return (
      <ErrorBoundary>
        <SetupPage />
      </ErrorBoundary>
    );

  // ロック中
  if (!isUnlocked) {
    return (
      <ErrorBoundary>
        <UnlockPage />
      </ErrorBoundary>
    );
  }

  // メイン画面
  return (
    <ErrorBoundary>
      <VaultPage />
    </ErrorBoundary>
  );
}

function LoginPage() {
  const { login, trySilentRefresh } = useAuthStore();
  const autoPopupLogin = useUIStore((s) => s.autoPopupLogin);
  const attempted = useRef(false);

  useEffect(() => {
    // 自動ポップアップログインが無効の場合はサイレント認証を試みない
    if (!autoPopupLogin) return;

    // 初回表示時に GIS スクリプトの読み込みを待ってからサイレント再認証を試みる
    let interval: ReturnType<typeof setInterval>;
    if (!attempted.current) {
      attempted.current = true;
      let checkCount = 0;
      const checkAndRun = () => {
        if (window.google?.accounts?.oauth2) {
          if (interval) clearInterval(interval);
          trySilentRefresh();
        } else if (checkCount > 50) {
          // 5秒経過しても読み込まれない場合は諦める（AdBlock等の可能性）
          if (interval) clearInterval(interval);
          trySilentRefresh(); // 内部で AuthError を出すためにあえて呼ぶ
        }
        checkCount++;
      };

      if (window.google?.accounts?.oauth2) {
        trySilentRefresh();
      } else {
        interval = setInterval(checkAndRun, 100);
      }
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [trySilentRefresh, autoPopupLogin]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-gray-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
      <div className="mx-4 w-full max-w-sm text-center">
        <div className="mb-8">
          <h1 className="flex items-center justify-center text-4xl font-bold text-gray-900 dark:text-gray-100">
            <img
              src="/white.png"
              alt=""
              className="mr-3 h-10 w-10 object-contain"
            />
            KaKuSu
          </h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            クライアントサイドで暗号化するGoogle Drive
          </p>
        </div>

        <div className="rounded-lg bg-white p-8 shadow-sm dark:bg-gray-800">
          <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
            Googleアカウントでログインしてください
          </p>
          <button
            type="button"
            onClick={() => login()}
            className="flex w-full items-center justify-center gap-3 rounded-md border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50 hover:shadow dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Googleでログイン
          </button>

          {(PRIVACY_POLICY_URL || TERMS_OF_SERVICE_URL) && (
            <div className="mt-4 flex items-center justify-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              {PRIVACY_POLICY_URL && (
                <a
                  href={PRIVACY_POLICY_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  プライバシーポリシー
                </a>
              )}
              {PRIVACY_POLICY_URL && TERMS_OF_SERVICE_URL && (
                <span aria-hidden="true">/</span>
              )}
              {TERMS_OF_SERVICE_URL && (
                <a
                  href={TERMS_OF_SERVICE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  利用規約
                </a>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 rounded-md bg-blue-50 p-4 text-left dark:bg-blue-900/20">
          <div className="space-y-2 text-xs text-blue-700 dark:text-blue-300">
            <p>
              ファイルは保存前にブラウザ上で暗号化されるため、KaKuSuはもちろん、保存先であるGoogleも中身を閲覧することはできません。
            </p>
            <p>
              また、Googleアカウントの認証情報が開発者へ送信されることは一切ありません。
            </p>
          </div>
          {MECHANISM_URL && (
            <div className="mt-4">
              <a
                href={MECHANISM_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300 text-xs"
              >
                仕組みについて詳しく知る
                <svg
                  className="h-3 w-3"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M5.22 14.78a.75.75 0 001.06 0l7.22-7.22v5.69a.75.75 0 001.5 0v-7.5a.75.75 0 00-.75-.75h-7.5a.75.75 0 000 1.5h5.69l-7.22 7.22a.75.75 0 000 1.06z"
                    clipRule="evenodd"
                  />
                </svg>
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LoadingScreen({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-gray-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
      <div className="text-center">
        <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
        <p className="text-gray-600 dark:text-gray-400">{message}</p>
      </div>
    </div>
  );
}
