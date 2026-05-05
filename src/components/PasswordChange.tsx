import { clearAllFiles } from "@/cache/store";
import AutofillUsernameField from "@/components/AutofillUsernameField";
import {
  deriveMEKs,
  unwrapNameKey,
  unwrapVaultKey,
  wrapNameKey,
  wrapVaultKey,
} from "@/crypto/keys";
import { createVerifyData, verifyPassphrase } from "@/crypto/verify";
import { getVerifyFromMeta, uploadVerify } from "@/drive/files";
import {
  getWrappedNameKey,
  getWrappedVaultKey,
  setWrappedKeys,
  useVaultStore,
} from "@/stores/vaultStore";
import { toBase64 } from "@/utils/base64url";
import { useState } from "react";

interface PasswordChangeProps {
  onClose: () => void;
}

export default function PasswordChange({ onClose }: PasswordChangeProps) {
  const [oldPass, setOldPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { rootFolderId, salt, dataFolderId, metaFileId, verifyIv } =
    useVaultStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rootFolderId || !salt || !dataFolderId) return;

    if (newPass !== confirmPass) {
      setError("新しいパスフレーズが一致しません");
      return;
    }

    if (newPass.length < 8) {
      setError("パスフレーズは8文字以上にしてください");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Phase 1: Verify old passphrase
      setProgress("旧パスフレーズを検証中...");
      const oldMEKs = await deriveMEKs(oldPass, salt);
      const verifyData =
        metaFileId && verifyIv
          ? await getVerifyFromMeta(metaFileId, verifyIv)
          : null;
      if (!verifyData) throw new Error("検証ファイルが見つかりません");

      const isValid = await verifyPassphrase(
        oldMEKs.mekEnc,
        verifyData.ciphertext,
        verifyData.iv,
      );
      if (!isValid) {
        setError("旧パスフレーズが正しくありません");
        setLoading(false);
        return;
      }

      // Derive new keys
      setProgress("新しい鍵を導出中...");
      const newMEKs = await deriveMEKs(newPass, salt);

      const wrappedVK = getWrappedVaultKey();
      const wrappedNK = getWrappedNameKey();
      if (!wrappedVK || !wrappedNK)
        throw new Error("Envelope Key が見つかりません");

      // Re-unwrap with extractable: true so wrapKey succeeds
      setProgress("Vault Key を更新中...");
      const extractableVaultKey = await unwrapVaultKey(
        oldMEKs.mekWrap,
        wrappedVK,
        true,
      );
      const extractableNameKey = await unwrapNameKey(
        oldMEKs.mekWrap,
        wrappedNK,
        true,
      );
      const newWrappedVaultKey = await wrapVaultKey(
        newMEKs.mekWrap,
        extractableVaultKey,
      );
      const newWrappedNameKey = await wrapNameKey(
        newMEKs.mekWrap,
        extractableNameKey,
      );

      // Update verify data + wrapped keys in DO_NOT_DELETE (JSON body + appProperties)
      const { ciphertext: newCiphertext, iv: newIv } = await createVerifyData(
        newMEKs.mekEnc,
      );
      if (!metaFileId) throw new Error("DO_NOT_DELETE が見つかりません");
      if (!rootFolderId) throw new Error("Root folder not found");
      await uploadVerify(rootFolderId, newCiphertext, newIv, metaFileId, {
        wrapped_vault_key: toBase64(newWrappedVaultKey),
        wrapped_name_key: toBase64(newWrappedNameKey),
      });

      // Update store
      await clearAllFiles();
      setWrappedKeys(newWrappedVaultKey, newWrappedNameKey);
      useVaultStore.setState({
        mekEnc: newMEKs.mekEnc,
        mekWrap: newMEKs.mekWrap,
        verifyIv: newIv,
      });

      setProgress("完了しました！");
      setTimeout(() => onClose(), 1500);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "パスフレーズの変更に失敗しました",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40">
      <div className="mx-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
            パスフレーズ変更
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
            disabled={loading}
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <AutofillUsernameField />

          <div>
            <label
              htmlFor="old-pass"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              現在のパスフレーズ
            </label>
            <input
              id="old-pass"
              type="password"
              value={oldPass}
              onChange={(e) => setOldPass(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              disabled={loading}
              autoComplete="current-password"
              maxLength={1024}
            />
          </div>
          <div>
            <label
              htmlFor="new-pass"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              新しいパスフレーズ
            </label>
            <input
              id="new-pass"
              type="password"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              disabled={loading}
              autoComplete="new-password"
              maxLength={1024}
            />
          </div>
          <div>
            <label
              htmlFor="new-pass-confirm"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              新しいパスフレーズ（確認）
            </label>
            <input
              id="new-pass-confirm"
              type="password"
              value={confirmPass}
              onChange={(e) => setConfirmPass(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              disabled={loading}
              autoComplete="new-password"
              maxLength={1024}
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          {progress && (
            <p className="text-sm text-blue-600 dark:text-blue-400">
              {progress}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !oldPass || !newPass || !confirmPass}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "変更中..." : "パスフレーズを変更"}
          </button>
        </form>

        <div className="mt-4 rounded-md bg-amber-50 p-3 dark:bg-amber-900/20">
          <p className="text-xs text-amber-800 dark:text-amber-200">
            {getWrappedVaultKey()
              ? "Vault Key による高速パスフレーズ変更が利用できます。ファイルの再暗号化は不要です。"
              : "レガシー形式のため、初回はすべてのファイル鍵の移行が必要です。処理中に中断しないでください。移行後はパスフレーズ変更が瞬時に完了します。"}
          </p>
        </div>
      </div>
    </div>
  );
}
