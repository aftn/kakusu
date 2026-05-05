import {
  decryptFile,
  decryptFileFromStream,
  decryptFileStreaming,
} from "@/crypto/chunk";
import {
  decodeShareKey,
  encodeShareKey,
  parseShareFragment,
} from "@/crypto/share";
import {
  decryptNameWithShareKey,
  unwrapCEKWithShareKey,
} from "@/crypto/shareKey";
import {
  getFileContent,
  getFileContentAsStream,
  getFileContentWithProgress,
  setTokenProvider,
} from "@/drive/api";
import {
  clearSilentAuthFailed,
  hasSilentAuthFailed,
  silentRefresh,
  startLogin,
} from "@/drive/auth";
import { fetchShareMetaFile } from "@/drive/shareMeta";

import { getEffectiveParallelCount } from "@/cache/settings";
import ToastContainer from "@/components/ToastContainer";
import {
  MECHANISM_URL,
  PRIVACY_POLICY_URL,
  SESSION_STORAGE_KEYS,
  TERMS_OF_SERVICE_URL,
} from "@/config/app";
import { useUIStore } from "@/stores/uiStore";
import { downloadBlob } from "@/utils/download";
import {
  MAX_PREVIEW_FILE_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
  TEXT_PREVIEW_LIMIT_MESSAGE,
  getMimeType,
  getPreviewType,
  isHtmlFile,
  isMarkdownFile,
  isPreviewable,
  renderMarkdownPreview,
  sanitizeFileName,
} from "@/utils/preview";
import { ZipWriter } from "@/utils/zip";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** 共有受信者は drive.readonly が必要（drive.file では他ユーザー作成ファイルにアクセスできない） */
const SHARE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

function ShareIcon({
  title,
  className,
  children,
  fill = "none",
  stroke = "currentColor",
  viewBox = "0 0 24 24",
}: {
  title: string;
  className: string;
  children: ReactNode;
  fill?: string;
  stroke?: string;
  viewBox?: string;
}) {
  return (
    <svg
      className={className}
      fill={fill}
      stroke={stroke}
      viewBox={viewBox}
      focusable="false"
    >
      <title>{title}</title>
      {children}
    </svg>
  );
}

interface SharedFileEntry {
  id: string;
  name: string;
  /** Display path including parent folders e.g. "sub/nested/file.txt" */
  displayPath: string;
  size?: number;
  /** Base64url wrapped CEK */
  wrappedCek: string;
}

function clearShareSession(): void {
  sessionStorage.removeItem(SESSION_STORAGE_KEYS.shareMetaId);
  sessionStorage.removeItem(SESSION_STORAGE_KEYS.shareKey);
  sessionStorage.removeItem(SESSION_STORAGE_KEYS.shareTimestamp);
}

/** Maximum age (ms) for share session data in sessionStorage (10 minutes). */
const SHARE_SESSION_TTL_MS = 10 * 60 * 1000;

export default function SharePage() {
  const [shareKey, setShareKey] = useState<Uint8Array | null>(null);
  const [metaFileId, setMetaFileId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [, setDownloadPercent] = useState(0);
  const [status, setStatus] = useState<
    "parsing" | "needLogin" | "ready" | "loading" | "error"
  >("parsing");
  const [folderFiles, setFolderFiles] = useState<SharedFileEntry[]>([]);
  const [shareAccessToken, setShareAccessToken] = useState<string | null>(null);
  const [shareExpiresAt, setShareExpiresAt] = useState<number | null>(null);
  const isShareAuthenticated =
    !!shareAccessToken &&
    !!shareExpiresAt &&
    Date.now() < shareExpiresAt - 5 * 60 * 1000;
  const handleShareAuthResult = useCallback(
    (result: { accessToken: string; expiresIn: number; scope: string }) => {
      const expiresAt = Date.now() + result.expiresIn * 1000;
      setShareAccessToken(result.accessToken);
      setShareExpiresAt(expiresAt);
      setTokenProvider(() => Promise.resolve(result.accessToken));
    },
    [],
  );
  const silentAuthStartedRef = useRef(false);
  const autoPopupLogin = useUIStore((s) => s.autoPopupLogin);
  const autoPopupTriedRef = useRef(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // 初回表示時に URL フラグメント、または OAuth 復帰後の sessionStorage を読む。
  useEffect(() => {
    let parsed = parseShareFragment(window.location.hash);
    if (parsed) {
      clearSilentAuthFailed();
      sessionStorage.setItem(
        SESSION_STORAGE_KEYS.shareMetaId,
        parsed.metaFileId,
      );
      sessionStorage.setItem(
        SESSION_STORAGE_KEYS.shareKey,
        encodeShareKey(parsed.shareKey),
      );
      sessionStorage.setItem(
        SESSION_STORAGE_KEYS.shareTimestamp,
        String(Date.now()),
      );
      history.replaceState(null, "", "/share");
      setMetaFileId(parsed.metaFileId);
      setShareKey(parsed.shareKey);
    } else {
      // Restore from sessionStorage (OAuth redirect)
      const savedKey = sessionStorage.getItem(
        SESSION_STORAGE_KEYS.shareKey,
      );
      const savedMetaId = sessionStorage.getItem(
        SESSION_STORAGE_KEYS.shareMetaId,
      );
      const savedTs = sessionStorage.getItem(
        SESSION_STORAGE_KEYS.shareTimestamp,
      );
      const isExpired = savedTs
        ? Date.now() - Number(savedTs) > SHARE_SESSION_TTL_MS
        : true;
      if (savedKey && savedMetaId && !isExpired) {
        try {
          const key = decodeShareKey(savedKey);
          if (key.length === 32) {
            sessionStorage.setItem(
              SESSION_STORAGE_KEYS.shareMetaId,
              savedMetaId,
            );
            sessionStorage.setItem(SESSION_STORAGE_KEYS.shareKey, savedKey);
            if (savedTs) {
              sessionStorage.setItem(
                SESSION_STORAGE_KEYS.shareTimestamp,
                savedTs,
              );
            }
            setMetaFileId(savedMetaId);
            setShareKey(key);
            parsed = { metaFileId: savedMetaId, shareKey: key };
          }
        } catch {
          /* invalid saved data */
        }
      }
    }
    if (!parsed) {
      clearShareSession();
      setError("共有リンクが不正です");
      setStatus("error");
      return;
    }
  }, []);

  // 認証状態と共有情報が揃ったら表示状態を確定する。
  useEffect(() => {
    if (!shareKey || !metaFileId) return;
    if (isShareAuthenticated) {
      clearSilentAuthFailed();
      setStatus("ready");
      return;
    }

    if (!hasSilentAuthFailed() && !silentAuthStartedRef.current) {
      silentAuthStartedRef.current = true;
      setStatus("loading");
      void silentRefresh(SHARE_SCOPE)
        .then((result) => {
          if (result) {
            handleShareAuthResult(result);
          } else {
            setStatus("needLogin");
          }
        })
        .catch(() => {
          setStatus("needLogin");
        });
      return;
    }

    setStatus("needLogin");
  }, [isShareAuthenticated, shareKey, metaFileId, handleShareAuthResult]);

  const handleLogin = useCallback(
    async (suppressError = false) => {
      setLoggingIn(true);
      setLoginError(null);
      clearSilentAuthFailed();
      try {
        const result = await startLogin(undefined, SHARE_SCOPE);
        if (result) {
          handleShareAuthResult(result);
        } else if (!suppressError) {
          setLoginError("ログインに失敗しました。もう一度お試しください。");
        }
      } catch (e) {
        if (!suppressError) {
          setLoginError(
            e instanceof Error ? e.message : "ログインに失敗しました",
          );
        }
      } finally {
        setLoggingIn(false);
      }
    },
    [handleShareAuthResult],
  );

  // autoPopupLogin 有効時: needLogin 遷移後に自動で GIS ポップアップを開く
  // ユーザー操作なしのためブラウザにブロックされやすい — エラーは抑制する
  useEffect(() => {
    if (status !== "needLogin" || !autoPopupLogin || autoPopupTriedRef.current)
      return;
    autoPopupTriedRef.current = true;
    void handleLogin(true);
  }, [status, autoPopupLogin, handleLogin]);

  // フォルダ共有では配下を再帰的にたどって一覧を構築する。
  const [folderLoaded, setFolderLoaded] = useState(false);
  useEffect(() => {
    if (status !== "ready" || !shareKey || !metaFileId || folderLoaded) return;

    setFolderLoaded(true);
    setStatus("loading");
    (async () => {
      try {
        // 30秒タイムアウト付きでメタファイルを取得
        const metaPromise = fetchShareMetaFile(metaFileId);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error("メタファイルの読み込みがタイムアウトしました")),
            30_000,
          ),
        );
        const meta = await Promise.race([metaPromise, timeoutPromise]);

        // Try to decrypt share name with ShareKey (recipient-visible field)
        let decryptedShareName: string | null = null;
        if (meta.encShareNameByShareKey && meta.ivShareNameByShareKey) {
          try {
            decryptedShareName = await decryptNameWithShareKey(
              shareKey,
              meta.encShareNameByShareKey,
              meta.ivShareNameByShareKey,
            );
          } catch {
            // Fallback: derive name from files below
          }
        }
        if (decryptedShareName) {
          setFileName(decryptedShareName);
        } else {
          setFileName(null);
        }

        // Decrypt file names and build file list using item.path
        const entries: SharedFileEntry[] = [];
        let failedCount = 0;
        for (const item of meta.items) {
          try {
            const name = await decryptNameWithShareKey(
              shareKey,
              item.encName,
              item.ivName,
            );
            const pathParts = (item.path ?? []).filter(
              (p: string) => p && p !== "." && p !== "..",
            );
            const displayPath = [...pathParts, name].join("/");
            entries.push({
              id: item.fileId,
              name,
              displayPath,
              wrappedCek: item.wrappedCek,
            });
          } catch {
            failedCount++;
          }
        }
        if (entries.length === 0 && failedCount > 0) {
          setError(
            `共有ファイルの復号に失敗しました（${failedCount}件）。リンクが破損している可能性があります。`,
          );
          setStatus("error");
          return;
        }
        if (failedCount > 0) {
          setError(
            `${failedCount}件のファイルの復号に失敗しました（スキップされています）`,
          );
        }
        // If no explicit share name available, derive from first entry or mode
        if (!decryptedShareName && entries.length > 0) {
          const hasSubfolders = entries.some((e) =>
            e.displayPath.includes("/"),
          );
          setFileName(
            hasSubfolders
              ? (entries[0]?.displayPath.split("/")[0] ?? "")
              : `共有ファイル (${entries.length}件)`,
          );
        }
        setFolderFiles(entries);
        setStatus("ready");
      } catch (e) {
        clearShareSession();
        setError(
          e instanceof Error
            ? e.message
            : "メタファイルの読み込みに失敗しました",
        );
        setStatus("error");
      }
    })();
  }, [status, shareKey, folderLoaded, metaFileId]);

  const downloadFile = async (
    id: string,
    name: string,
    expectedSize: number | null | undefined,
    wrappedCek: string,
  ) => {
    if (!shareKey) return;
    setDownloading(true);
    setDownloadPercent(0);

    const { addToast, updateToast } = useUIStore.getState();
    const startedAt = Date.now();
    const tid = addToast({
      message: `「${name}」をダウンロード中...`,
      type: "progress",
      percent: 0,
      phase: "downloading",
    });

    try {
      const ciphertext = await getFileContentWithProgress(
        id,
        (loaded, total) => {
          if (total > 0) {
            const percent = Math.round((loaded / total) * 100);
            const elapsed = (Date.now() - startedAt) / 1000;
            const speed =
              elapsed > 0.5
                ? `${(loaded / 1024 / 1024 / elapsed).toFixed(1)} MB/s`
                : "";
            setDownloadPercent(Math.round((loaded / total) * 50));
            updateToast(tid, { percent, speed, phase: "downloading" });
          }
        },
        expectedSize ?? undefined,
      );
      setDownloadPercent(50);
      updateToast(tid, {
        percent: 0,
        phase: "decrypting",
        speed: "",
        message: `「${name}」を復号中...`,
      });

      const cek = await unwrapCEKWithShareKey(shareKey, wrappedCek);
      const decrypted = await decryptFile(cek, ciphertext);
      const blobBytes = new Uint8Array(decrypted);
      setDownloadPercent(100);

      const blob = new Blob([blobBytes]);
      downloadBlob(blob, sanitizeFileName(name));

      updateToast(tid, {
        message: `「${name}」のダウンロード完了`,
        type: "success",
        percent: 100,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      updateToast(tid, {
        message: `ダウンロードに失敗しました: ${detail}`,
        type: "error",
      });
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadAll = async () => {
    if (!shareKey) return;
    setDownloading(true);
    setDownloadPercent(0);

    const { addToast, updateToast } = useUIStore.getState();
    const zipName = `${fileName || "shared-files"}.zip`;
    const tid = addToast({
      message: `「${zipName}」を作成中...`,
      type: "progress",
      percent: 0,
      phase: "downloading",
    });

    try {
      const zipWriter = ZipWriter.forBlob();
      let completedCount = 0;
      let zipWriterPromise = Promise.resolve();

      // Split into large and small files
      const largeFiles = folderFiles.filter(
        (f) => f.size && f.size > 5 * 1024 * 1024,
      );
      const smallFiles = folderFiles.filter(
        (f) => !f.size || f.size <= 5 * 1024 * 1024,
      );

      // ── Large files: pipeline download of next file while zipping current ──
      let prefetchStreamPromise: Promise<{
        stream: ReadableStream<Uint8Array>;
        cek: CryptoKey;
      }> | null = null;
      if (largeFiles.length > 0) {
        const first = largeFiles[0]!;
        prefetchStreamPromise = unwrapCEKWithShareKey(
          shareKey,
          first.wrappedCek,
        ).then(async (cek) => {
          const { stream } = await getFileContentAsStream(first.id);
          return { stream, cek };
        });
      }

      for (let li = 0; li < largeFiles.length; li++) {
        const f = largeFiles[li]!;

        // Wait for previous zip writes to finish
        await zipWriterPromise;

        // Retrieve prefetched data
        const { stream, cek } = await prefetchStreamPromise!;
        const decStream = decryptFileFromStream(cek, stream, f.size ?? 0);

        updateToast(tid, {
          message: `「${f.name}」をZIPに追加中（ストリーム）... (${completedCount + 1}/${folderFiles.length})`,
          phase: "downloading",
        });

        // Start prefetching the NEXT file
        if (li + 1 < largeFiles.length) {
          const nf = largeFiles[li + 1]!;
          prefetchStreamPromise = unwrapCEKWithShareKey(
            shareKey,
            nf.wrappedCek,
          ).then(async (nCek) => {
            const { stream: nStream } = await getFileContentAsStream(nf.id);
            return { stream: nStream, cek: nCek };
          });
        }

        // Write streaming entry and update promise queue
        zipWriterPromise = zipWriter
          .addEntryStreaming(f.displayPath, decStream)
          .then(() => {
            completedCount++;
            const percent = Math.round(
              (completedCount / folderFiles.length) * 90,
            );
            setDownloadPercent(percent);
            updateToast(tid, {
              message: `「${f.name}」完了 (${completedCount}/${folderFiles.length})`,
              percent,
              phase: "downloading",
            });
          });
      }

      // ── Small files: concurrent download + sequential zip ──
      const downloadTasks = smallFiles.map((f) => async () => {
        const cek = await unwrapCEKWithShareKey(shareKey, f.wrappedCek);
        const ciphertext = await getFileContent(f.id);

        const myWritePromise = zipWriterPromise.then(async () => {
          updateToast(tid, {
            message: `「${f.name}」をZIPに追加中... (${completedCount + 1}/${folderFiles.length})`,
            phase: "decrypting",
          });
          await zipWriter.addEntryStreaming(
            f.displayPath,
            decryptFileStreaming(cek, ciphertext),
          );
          completedCount++;
          const percent = Math.round(
            (completedCount / folderFiles.length) * 90,
          );
          setDownloadPercent(percent);
          updateToast(tid, {
            message: `「${f.name}」完了 (${completedCount}/${folderFiles.length})`,
            percent,
            phase: "downloading",
          });
        });
        zipWriterPromise = myWritePromise;
        await myWritePromise;
      });

      const limit = getEffectiveParallelCount(16);
      let idx = 0;
      const next = async (): Promise<void> => {
        while (idx < downloadTasks.length) {
          const i = idx++;
          await downloadTasks[i]?.();
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(limit, downloadTasks.length) }, () =>
          next(),
        ),
      );
      await zipWriterPromise;
      setDownloadPercent(95);
      updateToast(tid, {
        message: `「${zipName}」を圧縮中...`,
        percent: 95,
        phase: "decrypting",
      });
      const blob = await zipWriter.finish();
      downloadBlob(blob!, sanitizeFileName(zipName));
      setDownloadPercent(100);
      updateToast(tid, {
        message: `「${zipName}」のダウンロード完了`,
        type: "success",
        percent: 100,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      updateToast(tid, {
        message: `ZIPダウンロードに失敗しました: ${detail}`,
        type: "error",
      });
    } finally {
      setDownloading(false);
    }
    clearShareSession();
  };

  if (status === "error" || error) {
    return (
      <>
        <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
          <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md text-center dark:bg-gray-800 dark:bg-gray-800">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
              <ShareIcon title="エラー" className="h-8 w-8 text-red-600">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </ShareIcon>
            </div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
              エラー
            </h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              {error || "共有リンクが不正です"}
            </p>
            <a
              href="/"
              className="mt-4 inline-block text-blue-600 hover:underline"
            >
              トップに戻る
            </a>
          </div>
        </div>
        <ToastContainer />
      </>
    );
  }

  if (status === "needLogin") {
    return (
      <>
        <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-gray-50 to-blue-50 px-4 dark:from-gray-900 dark:to-gray-800">
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
                ファイルを開くにはGoogleアカウントでログインしてください
              </p>
              {loginError && (
                <p className="mb-4 text-sm text-red-600 dark:text-red-400">
                  {loginError}
                </p>
              )}
              <button
                type="button"
                disabled={loggingIn}
                onClick={() => void handleLogin()}
                className="flex w-full items-center justify-center gap-3 rounded-md border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50 hover:shadow disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
              >
                {loggingIn ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-700 border-t-transparent dark:border-gray-200" />
                    ログイン中...
                  </span>
                ) : (
                  <>
                    <svg
                      className="h-5 w-5"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path
                        fill="#4285F4"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      />
                    </svg>
                    Googleでログイン
                  </>
                )}
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
        <ToastContainer />
      </>
    );
  }

  if (status === "loading") {
    return (
      <>
        <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        </div>
        <ToastContainer />
      </>
    );
  }

  // メタファイルベースの一覧を表示。
  if (folderFiles.length > 0 && shareKey) {
    return (
      <>
        <SharedFileViewer
          folderFiles={folderFiles}
          folderName={fileName || "共有ファイル"}
          downloading={downloading}
          downloadFile={downloadFile}
          handleDownloadAll={handleDownloadAll}
          shareKey={shareKey}
        />
        <ToastContainer />
      </>
    );
  }

  // ファイル一覧がまだ読み込まれていない場合のフォールバック
  return (
    <>
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
      <ToastContainer />
    </>
  );
}

// 共有フォルダ用の一覧ビュー。

interface SharedFileViewerProps {
  folderFiles: SharedFileEntry[];
  folderName: string;
  downloading: boolean;
  downloadFile: (
    id: string,
    name: string,
    expectedSize: number | null | undefined,
    wrappedCek: string,
  ) => Promise<void>;
  handleDownloadAll: () => Promise<void>;
  shareKey: Uint8Array;
}

function SharedFileViewer({
  folderFiles,
  folderName,
  downloading,
  downloadFile,
  handleDownloadAll,
  shareKey,
}: SharedFileViewerProps) {
  const [search, setSearch] = useState("");
  const [previewEntry, setPreviewEntry] = useState<SharedFileEntry | null>(
    null,
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [previewVideoError, setPreviewVideoError] = useState(false);
  const [sortKey, setSortKey] = useState<"name" | "path">("path");
  const [sortAsc, setSortAsc] = useState(true);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string[]>([]);

  // Check if the shared tree has any folders
  const hasFolders = useMemo(
    () => folderFiles.some((f) => f.displayPath.includes("/")),
    [folderFiles],
  );

  // Derive folders and files at the current navigation path (memoized)
  const { folders: navFolders, files: navFiles } = useMemo(() => {
    const prefix = currentPath.length > 0 ? `${currentPath.join("/")}/` : "";
    const folderSet = new Set<string>();
    const files: SharedFileEntry[] = [];

    for (const f of folderFiles) {
      const dp = f.displayPath;
      if (prefix && !dp.startsWith(prefix)) continue;
      const rel = prefix ? dp.slice(prefix.length) : dp;
      const slashIdx = rel.indexOf("/");
      if (slashIdx >= 0) {
        folderSet.add(rel.slice(0, slashIdx));
      } else {
        files.push(f);
      }
    }

    return {
      folders: Array.from(folderSet).sort((a, b) => a.localeCompare(b)),
      files: files.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [folderFiles, currentPath]);

  const isSearching = search.length > 0;
  const useFolderView = hasFolders && !isSearching;

  const filtered = useMemo(
    () =>
      folderFiles
        .filter((f) => {
          if (!search) return true;
          const q = search.toLowerCase();
          return (
            f.displayPath.toLowerCase().includes(q) ||
            f.name.toLowerCase().includes(q)
          );
        })
        .sort((a, b) => {
          const va = sortKey === "name" ? a.name : a.displayPath;
          const vb = sortKey === "name" ? b.name : b.displayPath;
          return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
        }),
    [folderFiles, search, sortKey, sortAsc],
  );

  const handleSort = (key: "name" | "path") => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const handlePreview = async (entry: SharedFileEntry) => {
    if (entry.size && entry.size > MAX_PREVIEW_FILE_BYTES) {
      useUIStore.getState().addToast({
        message:
          "ファイルが大きすぎるためプレビューできません（200MB超）。ダウンロードして確認してください。",
        type: "error",
      });
      return;
    }
    setPreviewEntry(entry);
    setPreviewLoading(true);
    setTextContent(null);
    setPreviewVideoError(false);
    try {
      const ciphertext = await getFileContent(entry.id);
      const cek = await unwrapCEKWithShareKey(shareKey, entry.wrappedCek);
      const decrypted = await decryptFile(cek, ciphertext);
      const blobBytes = new Uint8Array(decrypted);
      const mimeType = getMimeType(entry.name);
      const url = URL.createObjectURL(
        new Blob([blobBytes], { type: mimeType }),
      );
      // 古いプレビュー URL は都度解放する。
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(url);
      // テキスト系プレビューだけ本文を先に読み込む。
      const type = getPreviewType(entry.name);
      if (type === "text") {
        if (decrypted.byteLength > MAX_TEXT_PREVIEW_BYTES) {
          setTextContent(TEXT_PREVIEW_LIMIT_MESSAGE);
        } else {
          const text = new TextDecoder().decode(decrypted);
          setTextContent(text);
        }
      }
    } catch {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setPreviewEntry(null);
      setTextContent(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPreviewEntry(null);
    setTextContent(null);
    setPreviewVideoError(false);
  };

  const handleSingleDownload = async (entry: SharedFileEntry) => {
    setDownloadingId(entry.id);
    try {
      await downloadFile(entry.id, entry.name, undefined, entry.wrappedCek);
    } finally {
      setDownloadingId(null);
    }
  };

  const sortArrow = (key: "name" | "path") => {
    if (sortKey !== key) return null;
    return <span className="ml-1 text-xs">{sortAsc ? "▲" : "▼"}</span>;
  };

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 dark:bg-gray-900">
      {/* ヘッダー */}
      <header className="border-b bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-green-100 dark:bg-green-900/30">
              <ShareIcon
                title="フォルダ"
                className="h-5 w-5 text-green-600"
                fill="currentColor"
                stroke="none"
              >
                <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
              </ShareIcon>
            </div>
            <div className="min-w-0">
              <h1
                className="truncate text-lg font-bold text-gray-900 dark:text-gray-100"
                title={folderName}
              >
                {folderName}
              </h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {folderFiles.length}件のファイル
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDownloadAll}
            disabled={downloading}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {downloading ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            ) : (
              <ShareIcon title="すべてダウンロード" className="h-4 w-4">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </ShareIcon>
            )}
            すべてダウンロード
          </button>
        </div>
      </header>

      {/* ツールバー: 検索 */}
      <div className="mx-auto w-full max-w-7xl px-4 py-3">
        <div className="relative">
          <ShareIcon
            title="検索"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </ShareIcon>
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCurrentPath([]);
            }}
            placeholder="ファイルを検索..."
            maxLength={200}
            className="h-11 w-full rounded-xl border border-gray-300 bg-white py-2 pl-10 dark:border-gray-600 dark:bg-gray-700 pr-4 text-sm text-gray-700 placeholder-gray-400 dark:text-gray-200 dark:placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {search && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setCurrentPath([]);
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
            >
              <ShareIcon title="検索をクリア" className="h-4 w-4">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </ShareIcon>
            </button>
          )}
        </div>

        {/* パンくずリスト（フォルダナビゲーション時のみ） */}
        {useFolderView && (
          <nav className="mt-3">
            <ol className="flex flex-wrap items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
              <li>
                <button
                  type="button"
                  onClick={() => setCurrentPath([])}
                  className={`hover:text-blue-600 ${currentPath.length === 0 ? "font-semibold text-gray-800 dark:text-gray-200" : ""}`}
                >
                  {folderName}
                </button>
              </li>
              {currentPath.map((seg, i) => (
                <li key={`${i}-${seg}`} className="flex items-center gap-1">
                  <span className="text-gray-300">/</span>
                  <button
                    type="button"
                    onClick={() => setCurrentPath(currentPath.slice(0, i + 1))}
                    className={`hover:text-blue-600 ${i === currentPath.length - 1 ? "font-semibold text-gray-800 dark:text-gray-200" : ""}`}
                  >
                    {seg}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}
      </div>

      {/* ファイル一覧 */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-6">
        {useFolderView ? (
          /* フォルダナビゲーション表示 */
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm divide-y divide-gray-100 dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:divide-gray-700">
            {navFolders.map((folder) => (
              <button
                key={folder}
                type="button"
                onClick={() => setCurrentPath([...currentPath, folder])}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                <ShareIcon
                  title="フォルダ"
                  className="h-5 w-5 shrink-0 text-yellow-500"
                  fill="currentColor"
                  stroke="none"
                >
                  <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                </ShareIcon>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-700 dark:text-gray-300">
                  {folder}
                </span>
                <ShareIcon
                  title="開く"
                  className="ml-auto h-4 w-4 shrink-0 text-gray-300"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </ShareIcon>
              </button>
            ))}
            {navFiles.map((f) => {
              const previewable = isPreviewable(f.name);
              const isDl = downloadingId === f.id;
              return (
                <div
                  key={f.id}
                  className="flex items-center gap-3 px-4 py-3 transition hover:bg-gray-50 dark:hover:bg-gray-700"
                  onDoubleClick={() => previewable && handlePreview(f)}
                >
                  <ShareIcon
                    title="ファイル"
                    className="h-5 w-5 shrink-0 text-gray-400"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </ShareIcon>
                  <span
                    className="min-w-0 flex-1 truncate text-sm text-gray-700 dark:text-gray-300"
                    title={f.name}
                  >
                    {f.name}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    {previewable && (
                      <button
                        type="button"
                        onClick={() => handlePreview(f)}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-600"
                        title="プレビュー"
                      >
                        <ShareIcon title="プレビュー" className="h-4 w-4">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                          />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                          />
                        </ShareIcon>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleSingleDownload(f)}
                      disabled={isDl}
                      className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-600 disabled:opacity-50"
                      title="ダウンロード"
                    >
                      {isDl ? (
                        <span className="block h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                      ) : (
                        <ShareIcon title="ダウンロード" className="h-4 w-4">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                          />
                        </ShareIcon>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
            {navFolders.length === 0 && navFiles.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                ファイルがありません
              </div>
            )}
          </div>
        ) : (
          /* フラット表示（フォルダなし or 検索中） */
          <>
            {/* モバイル: コンパクトリスト */}
            <div className="divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm sm:hidden dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800">
              {filtered.map((f) => {
                const previewable = isPreviewable(f.name);
                const isDl = downloadingId === f.id;
                return (
                  <div
                    key={f.id}
                    className="flex items-center gap-3 px-4 py-3 transition hover:bg-gray-50 dark:hover:bg-gray-700"
                    onDoubleClick={() => previewable && handlePreview(f)}
                  >
                    <ShareIcon
                      title="ファイル"
                      className="h-5 w-5 shrink-0 text-gray-400"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </ShareIcon>
                    <div className="min-w-0 flex-1">
                      <span
                        className="block truncate text-sm text-gray-700 dark:text-gray-300 dark:text-gray-300"
                        title={f.name}
                      >
                        {f.name}
                      </span>
                      {hasFolders && (
                        <span
                          className="block truncate text-xs text-gray-400 dark:text-gray-500 dark:text-gray-500"
                          title={f.displayPath}
                        >
                          {f.displayPath}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {previewable && (
                        <button
                          type="button"
                          onClick={() => handlePreview(f)}
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-600"
                          title="プレビュー"
                        >
                          <ShareIcon title="プレビュー" className="h-4 w-4">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                            />
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                            />
                          </ShareIcon>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleSingleDownload(f)}
                        disabled={isDl}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-600 disabled:opacity-50"
                        title="ダウンロード"
                      >
                        {isDl ? (
                          <span className="block h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                        ) : (
                          <ShareIcon title="ダウンロード" className="h-4 w-4">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                            />
                          </ShareIcon>
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-gray-400">
                  {search ? "検索結果がありません" : "ファイルがありません"}
                </div>
              )}
            </div>
            {/* デスクトップ: テーブル */}
            <div className="hidden overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm sm:block dark:border-gray-700 dark:bg-gray-800">
              <table className="w-full">
                <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                  <tr>
                    {hasFolders && (
                      <th className="px-4 py-3">
                        <button
                          type="button"
                          className="select-none"
                          onClick={() => handleSort("path")}
                        >
                          パス{sortArrow("path")}
                        </button>
                      </th>
                    )}
                    <th className="px-4 py-3">
                      <button
                        type="button"
                        className="select-none"
                        onClick={() => handleSort("name")}
                      >
                        ファイル名{sortArrow("name")}
                      </button>
                    </th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {filtered.map((f) => {
                    const previewable = isPreviewable(f.name);
                    const isDl = downloadingId === f.id;
                    return (
                      <tr
                        key={f.id}
                        className="transition hover:bg-gray-50 dark:hover:bg-gray-700"
                        onDoubleClick={() => previewable && handlePreview(f)}
                      >
                        {hasFolders && (
                          <td className="px-4 py-2.5">
                            <span
                              className="block max-w-xs truncate text-xs text-gray-400 dark:text-gray-500 dark:text-gray-500"
                              title={f.displayPath}
                            >
                              {f.displayPath}
                            </span>
                          </td>
                        )}
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <ShareIcon
                              title="ファイル"
                              className="h-4 w-4 shrink-0 text-gray-400"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                              />
                            </ShareIcon>
                            <span
                              className="truncate text-sm text-gray-700 dark:text-gray-300"
                              title={f.name}
                            >
                              {f.name}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {previewable && (
                              <button
                                type="button"
                                onClick={() => handlePreview(f)}
                                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-600"
                                title="プレビュー"
                              >
                                <ShareIcon
                                  title="プレビュー"
                                  className="h-4 w-4"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                                  />
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                                  />
                                </ShareIcon>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleSingleDownload(f)}
                              disabled={isDl}
                              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-600 disabled:opacity-50"
                              title="ダウンロード"
                            >
                              {isDl ? (
                                <span className="block h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                              ) : (
                                <ShareIcon
                                  title="ダウンロード"
                                  className="h-4 w-4"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                                  />
                                </ShareIcon>
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td
                        colSpan={hasFolders ? 3 : 2}
                        className="px-4 py-8 text-center text-sm text-gray-400"
                      >
                        {search
                          ? "検索結果がありません"
                          : "ファイルがありません"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        <p className="mt-4 text-center text-xs text-gray-400 dark:text-gray-500">
          暗号化により、送信者とあなた以外はこのファイルの内容を見ることができません。
        </p>
      </main>

      {/* 共有プレビュー。ローカルの FilePreview と同じ挙動に寄せる。 */}
      {previewEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            aria-label="プレビューを閉じる"
            onClick={closePreview}
            className="absolute inset-0 bg-black/60"
          />
          <div className="relative z-10 mx-4 flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-2xl dark:bg-gray-800">
            <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
              <h3
                className="min-w-0 truncate text-sm font-medium text-gray-800 dark:text-gray-200"
                title={previewEntry.name}
              >
                {previewEntry.name}
              </h3>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    handleSingleDownload(previewEntry);
                  }}
                  className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700"
                >
                  <ShareIcon title="ダウンロード" className="h-3.5 w-3.5">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                    />
                  </ShareIcon>
                  ダウンロード
                </button>
                <button
                  type="button"
                  onClick={closePreview}
                  className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                >
                  <ShareIcon title="閉じる" className="h-5 w-5">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </ShareIcon>
                </button>
              </div>
            </div>
            <div className="flex flex-1 items-center justify-center overflow-auto p-4">
              {previewLoading ? (
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
              ) : previewUrl ? (
                (() => {
                  const previewType = getPreviewType(previewEntry.name);
                  const isHtml = isHtmlFile(previewEntry.name);
                  const isMd = isMarkdownFile(previewEntry.name);
                  return (
                    <>
                      {previewType === "image" && (
                        <img
                          src={previewUrl}
                          alt={previewEntry.name}
                          className="max-h-[70vh] max-w-full rounded object-contain"
                        />
                      )}
                      {previewType === "audio" && (
                        <div className="w-full max-w-md">
                          <div className="mb-4 flex justify-center">
                            <ShareIcon
                              title="音声"
                              className="h-20 w-20 text-gray-300"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1}
                                d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
                              />
                            </ShareIcon>
                          </div>
                          {/* biome-ignore lint/a11y/useMediaCaption: ユーザー提供の音声には字幕トラック情報が含まれない */}
                          <audio controls className="w-full" src={previewUrl} />
                        </div>
                      )}
                      {previewType === "video" &&
                        (!previewVideoError ? (
                          /* biome-ignore lint/a11y/useMediaCaption: ユーザー提供の動画には字幕トラック情報が含まれない */
                          <video
                            controls
                            playsInline
                            preload="metadata"
                            className="max-h-[70vh] max-w-full rounded"
                            onLoadedData={() => setPreviewVideoError(false)}
                            onError={() => setPreviewVideoError(true)}
                          >
                            <source
                              src={previewUrl}
                              type={getMimeType(previewEntry.name)}
                            />
                          </video>
                        ) : (
                          <div className="flex flex-col items-center gap-3 text-gray-400">
                            <ShareIcon title="動画" className="h-16 w-16">
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1}
                                d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                              />
                            </ShareIcon>
                            <p className="text-sm">
                              この動画形式はブラウザで再生できません
                            </p>
                            <button
                              type="button"
                              onClick={() => handleSingleDownload(previewEntry)}
                              className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
                            >
                              ダウンロードして開く
                            </button>
                          </div>
                        ))}
                      {previewType === "text" && isHtml && (
                        <div className="w-full">
                          <div className="mb-3 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
                            HTML は安全のため実行せず、ソースのみ表示します。
                          </div>
                          <pre className="max-h-[70vh] w-full overflow-auto rounded-lg bg-gray-50 p-4 text-sm text-gray-800 whitespace-pre-wrap dark:bg-gray-900 dark:text-gray-200 break-words">
                            {textContent ?? "読み込み中..."}
                          </pre>
                        </div>
                      )}
                      {previewType === "text" &&
                        isMd &&
                        textContent !== null && (
                          <iframe
                            title={previewEntry.name}
                            srcDoc={renderMarkdownPreview(textContent)}
                            sandbox=""
                            className="h-[70vh] w-full rounded border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
                          />
                        )}
                      {previewType === "text" && !isHtml && !isMd && (
                        <pre className="max-h-[70vh] w-full overflow-auto rounded-lg bg-gray-50 p-4 text-sm text-gray-800 whitespace-pre-wrap dark:bg-gray-900 dark:text-gray-200 break-words">
                          {textContent ?? "読み込み中..."}
                        </pre>
                      )}
                      {previewType === "pdf" && (
                        <object
                          data={previewUrl}
                          type={getMimeType(previewEntry.name)}
                          className="h-[70vh] w-full rounded border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900"
                        >
                          <div className="flex h-full min-h-[16rem] flex-col items-center justify-center gap-3 text-gray-500">
                            <p className="text-sm">
                              PDF を埋め込み表示できませんでした
                            </p>
                            <button
                              type="button"
                              onClick={() => handleSingleDownload(previewEntry)}
                              className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
                            >
                              ダウンロードして開く
                            </button>
                          </div>
                        </object>
                      )}
                      {!previewType && (
                        <p className="text-sm text-gray-400">
                          このファイル形式はプレビューできません
                        </p>
                      )}
                    </>
                  );
                })()
              ) : (
                <p className="text-sm text-gray-400">
                  プレビューの読み込みに失敗しました
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
