import {
  TEXT_INPUT_MAX_LENGTH,
  sanitizeTextInput,
  validateEmails,
} from "@/drive/validation";
import { useShare } from "@/hooks/useShare";
import { useUIStore } from "@/stores/uiStore";
import { useEffect, useRef, useState } from "react";

export default function ShareDialog() {
  const shareTargets = useUIStore((s) => s.shareTargets);
  const closeShareDialog = useUIStore((s) => s.closeShareDialog);
  const { handleShare, shareURL, sharing, shareProgress, copyShareURL } =
    useShare();
  const [mode, setMode] = useState<"link" | "email">("link");
  const [email, setEmail] = useState("");
  const [shareName, setShareName] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeShareDialog();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeShareDialog]);

  if (shareTargets.length === 0) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      closeShareDialog();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = sanitizeTextInput(shareName);
    if (mode === "email") {
      const { valid, invalid } = validateEmails(email);
      if (invalid.length > 0) {
        setEmailError(`無効なメールアドレス: ${invalid.join(", ")}`);
        return;
      }
      if (valid.length === 0) {
        setEmailError("メールアドレスを入力してください");
        return;
      }
      setEmailError(null);
      await handleShare(
        shareTargets,
        mode,
        valid.join(","),
        undefined,
        cleanName || undefined,
      );
    } else {
      setEmailError(null);
      await handleShare(
        shareTargets,
        mode,
        undefined,
        undefined,
        cleanName || undefined,
      );
    }
  };

  const handleCopy = async () => {
    await copyShareURL();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const description =
    shareTargets.length === 1
      ? `「${shareTargets[0]?.name}」を共有します`
      : `${shareTargets.length}件のアイテムを共有します`;

  const handleBackdropKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") closeShareDialog();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleBackdropClick}
      onKeyDown={handleBackdropKeyDown}
    >
      <div
        ref={panelRef}
        className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl dark:bg-gray-800"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
            共有
          </h2>
          <button
            type="button"
            onClick={closeShareDialog}
            className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          >
            ✕
          </button>
        </div>

        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
          {description}
        </p>

        {!shareURL ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="share-name"
                className="block text-xs font-medium text-gray-600 mb-1 dark:text-gray-400"
              >
                共有名（任意）
              </label>
              <input
                id="share-name"
                type="text"
                value={shareName}
                onChange={(e) => setShareName(e.target.value)}
                maxLength={TEXT_INPUT_MAX_LENGTH}
                placeholder="例: 友人への共有"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                未入力の場合はタイムスタンプが設定されます
              </p>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode("link")}
                className={`flex-1 rounded-md px-3 py-2 text-sm ${mode === "link" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"}`}
              >
                リンク共有
              </button>
              <button
                type="button"
                onClick={() => setMode("email")}
                className={`flex-1 rounded-md px-3 py-2 text-sm ${mode === "email" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"}`}
              >
                メール指定
              </button>
            </div>

            {mode === "email" && (
              <div>
                <input
                  type="text"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailError(null);
                  }}
                  placeholder="メールアドレス（カンマ区切りで複数指定可）"
                  className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none dark:bg-gray-700 dark:text-gray-200 ${emailError ? "border-red-400 focus:border-red-500 dark:border-red-500" : "border-gray-300 focus:border-blue-500 dark:border-gray-600"}`}
                />
                {emailError && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {emailError}
                  </p>
                )}
              </div>
            )}

            <div className="rounded-md bg-amber-50 p-3 dark:bg-amber-900/20">
              <p className="text-xs text-amber-800 dark:text-amber-200">
                共有リンクにはファイルの復号鍵が含まれます。E2E暗号化メッセンジャー経由での送信を推奨します。
              </p>
            </div>

            <button
              type="submit"
              disabled={sharing || (mode === "email" && !email)}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {sharing ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  暗号化・共有中...
                </span>
              ) : (
                "共有リンクを生成"
              )}
            </button>
            {sharing && shareProgress && (
              <div>
                <div className="mb-1 flex justify-between text-xs text-gray-500 dark:text-gray-400">
                  <span>{shareProgress.message}</span>
                  <span>{shareProgress.percent}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all duration-200"
                    style={{ width: `${shareProgress.percent}%` }}
                  />
                </div>
              </div>
            )}
          </form>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md bg-green-50 p-3 dark:bg-green-900/20">
              <p className="mb-2 text-sm font-medium text-green-800 dark:text-green-300">
                共有リンクが生成されました
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={shareURL}
                  readOnly
                  className="flex-1 rounded border bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="rounded bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700"
                >
                  {copied ? "コピー済み!" : "コピー"}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={closeShareDialog}
              className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              閉じる
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
