import { useUIStore } from "@/stores/uiStore";
import {
  MAX_TEXT_PREVIEW_BYTES,
  TEXT_PREVIEW_LIMIT_MESSAGE,
  getPreviewType,
  isHtmlFile,
  isMarkdownFile,
  renderMarkdownPreview,
  sanitizeFileName,
} from "@/utils/preview";
import { hasCachedPreview } from "@/utils/previewCache";
import { useEffect, useState } from "react";

export default function FilePreview() {
  const preview = useUIStore((s) => s.preview);
  const setPreview = useUIStore((s) => s.setPreview);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [videoError, setVideoError] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const current = useUIStore.getState().preview;
        if (current) {
          if (!hasCachedPreview(current.file.driveId)) {
            URL.revokeObjectURL(current.blobUrl);
          }
          useUIStore.getState().setPreview(null);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (!preview) return;
    setVideoError(false);
    const type = getPreviewType(preview.file.name);
    if (type === "text") {
      if ((preview.file.size ?? 0) > MAX_TEXT_PREVIEW_BYTES) {
        setTextContent(TEXT_PREVIEW_LIMIT_MESSAGE);
        return;
      }
      // 以前のテキスト内容を消してから読み込み、古い内容の残留を防ぐ。
      setTextContent(null);
      void fetch(preview.blobUrl)
        .then((r) => r.text())
        .then(setTextContent)
        .catch(() => setTextContent("読み込みに失敗しました"));
    } else {
      setTextContent(null);
    }
  }, [preview]);

  if (!preview) return null;

  const { file, blobUrl, mimeType } = preview;
  const previewType = getPreviewType(file.name);
  const isHtml = isHtmlFile(file.name);
  const isMd = isMarkdownFile(file.name);

  const handleClose = () => {
    // キャッシュ済みの Blob URL はここでは破棄しない。
    if (!hasCachedPreview(file.driveId)) {
      URL.revokeObjectURL(blobUrl);
    }
    setPreview(null);
  };

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = sanitizeFileName(file.name);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="プレビューを閉じる"
        onClick={handleClose}
        className="absolute inset-0 bg-black/60"
      />
      <div className="relative z-10 flex max-h-[100dvh] w-full flex-col bg-white shadow-2xl sm:mx-4 dark:bg-gray-800 sm:max-h-[90vh] sm:max-w-3xl sm:rounded-xl">
        {/* ヘッダー */}
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
          <h3 className="min-w-0 truncate text-sm font-medium text-gray-800 dark:text-gray-200">
            {file.name}
          </h3>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              ダウンロード
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* コンテンツ */}
        <div className="flex flex-1 items-center justify-center overflow-auto p-3 sm:p-4">
          {previewType === "image" && (
            <img
              src={blobUrl}
              alt={file.name}
              className="max-h-[60dvh] max-w-full rounded object-contain sm:max-h-[70vh]"
            />
          )}
          {previewType === "audio" && (
            <div className="w-full max-w-md">
              <div className="mb-4 flex justify-center">
                <svg
                  className="h-20 w-20 text-gray-300 dark:text-gray-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1}
                    d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
                  />
                </svg>
              </div>
              {/* biome-ignore lint/a11y/useMediaCaption: ユーザー提供の音声には字幕トラック情報が含まれない */}
              <audio controls className="w-full" src={blobUrl} />
            </div>
          )}
          {previewType === "video" && !videoError && (
            /* biome-ignore lint/a11y/useMediaCaption: ユーザー提供の動画には字幕トラック情報が含まれない */
            <video
              controls
              playsInline
              preload="metadata"
              className="max-h-[60dvh] max-w-full rounded sm:max-h-[70vh]"
              onLoadedData={() => setVideoError(false)}
              onError={() => setVideoError(true)}
            >
              <source src={blobUrl} type={mimeType} />
            </video>
          )}
          {previewType === "video" && videoError && (
            <div className="flex flex-col items-center gap-3 text-gray-400 dark:text-gray-500">
              <svg
                className="h-16 w-16"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
              <p className="text-sm">この動画形式はブラウザで再生できません</p>
              <button
                type="button"
                onClick={handleDownload}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
              >
                ダウンロードして再生
              </button>
            </div>
          )}
          {previewType === "text" && isHtml && (
            <div className="w-full">
              <div className="mb-3 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
                HTML は安全のため実行せず、ソースのみ表示します。
              </div>
              <pre className="max-h-[60dvh] w-full overflow-auto rounded-lg bg-gray-50 p-4 text-sm text-gray-800 whitespace-pre-wrap dark:bg-gray-900 dark:text-gray-200 break-words sm:max-h-[70vh]">
                {textContent ?? "読み込み中..."}
              </pre>
            </div>
          )}
          {previewType === "text" && isMd && textContent !== null && (
            <iframe
              title={file.name}
              srcDoc={renderMarkdownPreview(textContent)}
              sandbox=""
              className="h-[60dvh] w-full rounded border border-gray-200 bg-white sm:h-[70vh] dark:border-gray-700 dark:bg-gray-900"
            />
          )}
          {previewType === "text" && isMd && textContent === null && (
            <pre className="max-h-[60dvh] w-full overflow-auto rounded-lg bg-gray-50 p-4 text-sm text-gray-800 whitespace-pre-wrap dark:bg-gray-900 dark:text-gray-200 break-words sm:max-h-[70vh]">
              読み込み中...
            </pre>
          )}
          {previewType === "text" && !isHtml && !isMd && (
            <pre className="max-h-[60dvh] w-full overflow-auto rounded-lg bg-gray-50 p-4 text-sm text-gray-800 whitespace-pre-wrap dark:bg-gray-900 dark:text-gray-200 break-words sm:max-h-[70vh]">
              {textContent ?? "読み込み中..."}
            </pre>
          )}
          {previewType === "pdf" && (
            <object
              data={blobUrl}
              type={mimeType || "application/pdf"}
              className="h-[60dvh] w-full rounded border border-gray-200 bg-gray-50 sm:h-[70vh] dark:border-gray-700 dark:bg-gray-900"
            >
              <div className="flex h-full min-h-[16rem] flex-col items-center justify-center gap-3 text-gray-500 dark:text-gray-400">
                <p className="text-sm">PDF を埋め込み表示できませんでした</p>
                <button
                  type="button"
                  onClick={handleDownload}
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
        </div>
      </div>
    </div>
  );
}
