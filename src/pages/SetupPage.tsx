import AutofillUsernameField from "@/components/AutofillUsernameField";
import { checkPassphraseStrength } from "@/crypto/verify";
import { useVaultStore } from "@/stores/vaultStore";
import { useState } from "react";

export default function SetupPage() {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setup = useVaultStore((s) => s.setup);
  const strength = checkPassphraseStrength(passphrase);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (passphrase !== confirm) {
      setError("パスフレーズが一致しません");
      return;
    }

    if (passphrase.length < 8) {
      setError("パスフレーズは8文字以上にしてください");
      return;
    }

    if (strength.score < 2) {
      setError(
        "パスフレーズが弱すぎます。より強いパスフレーズを設定してください",
      );
      return;
    }

    setLoading(true);
    try {
      await setup(passphrase);
    } catch (e) {
      setError(e instanceof Error ? e.message : "セットアップに失敗しました");
    } finally {
      setLoading(false);
    }
  };

  const strengthColors = [
    "bg-red-500",
    "bg-orange-500",
    "bg-yellow-500",
    "bg-lime-500",
    "bg-green-500",
  ];
  const strengthLabels = ["非常に弱い", "弱い", "普通", "強い", "非常に強い"];

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md dark:bg-gray-800">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            KaKuSu セットアップ
          </h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            ファイルを暗号化するためのパスフレーズを設定してください。
            このパスフレーズはどこにも保存されません。忘れるとデータを復元できません。
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <AutofillUsernameField />

          <div>
            <label
              htmlFor="passphrase"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              パスフレーズ
            </label>
            <input
              id="passphrase"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              placeholder="8文字以上の強いパスフレーズ"
              autoComplete="new-password"
              maxLength={1024}
              disabled={loading}
            />
            {passphrase && (
              <div className="mt-2">
                <div className="flex gap-1">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      className={`h-1 flex-1 rounded ${i <= strength.score ? strengthColors[strength.score] : "bg-gray-200 dark:bg-gray-600"}`}
                    />
                  ))}
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {strengthLabels[strength.score]}
                </p>
                {strength.feedback.map((f) => (
                  <p
                    key={f}
                    className="text-xs text-orange-600 dark:text-orange-400"
                  >
                    {f}
                  </p>
                ))}
              </div>
            )}
          </div>

          <div>
            <label
              htmlFor="confirm"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              パスフレーズ（確認）
            </label>
            <input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              placeholder="もう一度入力してください"
              autoComplete="new-password"
              maxLength={1024}
              disabled={loading}
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading || !passphrase || !confirm}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                セットアップ中...
              </span>
            ) : (
              "セットアップ開始"
            )}
          </button>
        </form>

        <div className="mt-6 rounded-md bg-amber-50 p-3 dark:bg-amber-900/20">
          <p className="text-xs text-amber-800 dark:text-amber-200">
            <strong>⚠ 重要:</strong>{" "}
            パスフレーズを忘れた場合、暗号化されたファイルを復元する方法はありません。
            安全性を優先するため、パスフレーズの永続保存機能は提供していません。
          </p>
        </div>
      </div>
    </div>
  );
}
