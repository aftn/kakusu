import { useUIStore } from "@/stores/uiStore";
import { writeClipboardText } from "@/utils/clipboard";
import { useEffect, useRef, useState } from "react";

function CopyableUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await writeClipboardText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="mt-1.5 flex gap-1">
      <input
        type="text"
        value={url}
        readOnly
        className="min-w-0 flex-1 truncate rounded border bg-white px-1.5 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
      />
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 rounded bg-green-600 px-2 py-0.5 text-xs text-white hover:bg-green-700"
      >
        {copied ? "済" : "コピー"}
      </button>
    </div>
  );
}

export default function ToastContainer() {
  const toastMap = useUIStore((s) => s.toasts);
  const removeToast = useUIStore((s) => s.removeToast);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const toasts = Array.from(toastMap.values());

  useEffect(() => {
    for (const toast of toasts) {
      if (
        (toast.type === "success" ||
          toast.type === "error" ||
          toast.type === "info") &&
        !timersRef.current.has(toast.id)
      ) {
        const delay =
          toast.autoDismiss ?? (toast.type === "error" ? 4000 : 2000);
        const timer = setTimeout(() => {
          removeToast(toast.id);
          timersRef.current.delete(toast.id);
        }, delay);
        timersRef.current.set(toast.id, timer);
      }
    }
    // Cleanup timers for removed toasts
    const activeIds = new Set(toasts.map((t) => t.id));
    for (const [id, timer] of timersRef.current) {
      if (!activeIds.has(id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
  }, [toasts, removeToast]);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col-reverse items-center gap-2 sm:left-auto sm:right-4 sm:translate-x-0 sm:items-end"
      style={{ maxWidth: 360 }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex w-auto max-w-[90vw] items-start gap-3 rounded-lg border px-4 py-3 shadow-lg transition-all sm:w-80 ${
            toast.type === "error"
              ? "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20"
              : toast.type === "success"
                ? "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20"
                : toast.type === "info"
                  ? "border-gray-300 bg-gray-100 dark:border-gray-600 dark:bg-gray-700"
                  : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
          }`}
        >
          {/* Icon */}
          <div className="mt-0.5 shrink-0">
            {toast.type === "progress" && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            )}
            {toast.type === "success" && (
              <svg
                className="h-4 w-4 text-green-600 dark:text-green-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <title>成功</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            )}
            {toast.type === "info" && (
              <svg
                className="h-4 w-4 text-gray-500 dark:text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <title>情報</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            )}
            {toast.type === "error" && (
              <svg
                className="h-4 w-4 text-red-600 dark:text-red-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <title>エラー</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            )}
          </div>
          {/* Content */}
          <div className="min-w-0 flex-1">
            <p
              className={`truncate text-sm font-medium ${
                toast.type === "error"
                  ? "text-red-700 dark:text-red-400"
                  : toast.type === "success"
                    ? "text-green-700 dark:text-green-400"
                    : toast.type === "info"
                      ? "text-gray-600 dark:text-gray-300"
                      : "text-gray-700 dark:text-gray-300"
              }`}
              title={toast.message}
            >
              {toast.message}
            </p>
            {toast.copyableUrl && <CopyableUrl url={toast.copyableUrl} />}
            {toast.type === "progress" && toast.percent !== undefined && (
              <div className="mt-1.5">
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                  <span>
                    {(toast.phase === "encrypting" ||
                      toast.phase === "uploading") &&
                      "アップロード中 "}
                    {toast.phase === "decrypting" && "復号中 "}
                    {toast.phase === "downloading" && "ダウンロード中 "}
                    {toast.percent}%
                  </span>
                  {toast.speed && <span>{toast.speed}</span>}
                </div>
                <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ease-out ${
                      toast.phase === "decrypting"
                        ? "bg-amber-500"
                        : "bg-blue-600"
                    }`}
                    style={{ width: `${toast.percent}%` }}
                  />
                </div>
              </div>
            )}
          </div>
          {/* Cancel / Close buttons */}
          <div className="flex shrink-0 items-center gap-1">
            {toast.type === "progress" && toast.onCancel && (
              <button
                type="button"
                onClick={() => toast.onCancel?.()}
                className="text-gray-400 hover:text-red-600 dark:text-gray-500 dark:hover:text-red-400"
                title="中止"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <title>中止</title>
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              className="shrink-0 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <title>閉じる</title>
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
      ))}
    </div>
  );
}
