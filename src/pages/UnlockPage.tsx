import AutofillUsernameField from "@/components/AutofillUsernameField";
import { useVaultStore } from "@/stores/vaultStore";
import { useRef, useState } from "react";

/** 連続失敗回数に応じた遅延（秒）。5回目以降は60秒固定。 */
const LOCKOUT_DELAYS = [0, 0, 2, 5, 15, 60];
function getLockoutDelay(failCount: number): number {
  return LOCKOUT_DELAYS[Math.min(failCount, LOCKOUT_DELAYS.length - 1)]! * 1000;
}

export default function UnlockPage() {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lockoutRemaining, setLockoutRemaining] = useState(0);
  const failCountRef = useRef(0);
  const lockoutTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unlock = useVaultStore((s) => s.unlock);

  const startLockout = (failCount: number) => {
    const delay = getLockoutDelay(failCount);
    if (delay <= 0) return;
    const until = Date.now() + delay;
    setLockoutRemaining(Math.ceil(delay / 1000));
    if (lockoutTimerRef.current) clearInterval(lockoutTimerRef.current);
    lockoutTimerRef.current = setInterval(() => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        setLockoutRemaining(0);
        if (lockoutTimerRef.current) clearInterval(lockoutTimerRef.current);
        lockoutTimerRef.current = null;
      } else {
        setLockoutRemaining(left);
      }
    }, 500);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase || lockoutRemaining > 0) return;

    setError(null);
    setLoading(true);

    try {
      const success = await unlock(passphrase);
      if (!success) {
        failCountRef.current++;
        startLockout(failCountRef.current);
        setError("パスフレーズが違います");
      } else {
        failCountRef.current = 0;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "アンロックに失敗しました");
    } finally {
      setLoading(false);
      setPassphrase("");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md dark:bg-gray-800">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
            <svg
              className="h-8 w-8 text-blue-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            KaKuSu
          </h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            パスフレーズを入力してアンロック
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <AutofillUsernameField />

          <div>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              placeholder="パスフレーズ"
              autoComplete="current-password"
              maxLength={1024}
              disabled={loading}
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          {lockoutRemaining > 0 && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              セキュリティのため {lockoutRemaining} 秒後に再試行できます
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !passphrase || lockoutRemaining > 0}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                検証中...
              </span>
            ) : (
              "アンロック"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
