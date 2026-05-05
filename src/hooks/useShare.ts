import { getEffectiveParallelCount } from "@/cache/settings";
import { encryptMetadata } from "@/crypto/encrypt";
import { buildShareURL } from "@/crypto/share";
import {
  encryptNameWithShareKey,
  generateShareKey,
  rewrapCEKForShare,
  wrapShareKey,
} from "@/crypto/shareKey";
import {
  createShareMetaFile,
  setShareDataPermissions,
  setShareMetaPermission,
} from "@/drive/shareMeta";
import type { ShareMetaFile, ShareMetaItem } from "@/drive/shareMeta";
import { syncFileTree } from "@/drive/sync";
import { TEXT_INPUT_MAX_LENGTH, sanitizeTextInput } from "@/drive/validation";
import { useUIStore } from "@/stores/uiStore";
import { useVaultStore } from "@/stores/vaultStore";
import type { KakusuFile } from "@/types";
import { fromBase64 } from "@/utils/base64url";
import { encode } from "@/utils/base64url";
import { writeClipboardText } from "@/utils/clipboard";
import { generateUUID } from "@/utils/uuid";
import { useCallback, useState } from "react";

/** Concurrency limit for CEK re-wrapping & name encryption */
function getSharePoolSize(): number {
  return getEffectiveParallelCount(16);
}

interface FlatFileEntry {
  file: KakusuFile;
  /** relative folder path segments from the share root (e.g. ['sub', 'nested']) */
  path: string[];
}

export function useShare() {
  const [sharing, setSharing] = useState(false);
  const [shareURL, setShareURL] = useState<string | null>(null);
  const [shareProgress, setShareProgress] = useState<{
    message: string;
    percent: number;
    startedAt: number;
  } | null>(null);
  const setError = useUIStore((s) => s.setError);

  /**
   * Recursively collect all files from a folder tree, preserving folder path.
   */
  const collectFilesRecursively = useCallback(
    async (
      folderId: string,
      mekEnc: CryptoKey,
      nameKey: CryptoKey | null,
      pathPrefix: string[],
      depth = 0,
    ): Promise<FlatFileEntry[]> => {
      if (depth > 50)
        throw new Error("フォルダ階層が深すぎます（上限: 50階層）");
      const children = await syncFileTree(folderId, mekEnc, nameKey);
      const entries: FlatFileEntry[] = [];
      const subFolderPromises: Promise<FlatFileEntry[]>[] = [];

      for (const child of children) {
        if (child.type === "file" && child.wrappedCek) {
          entries.push({ file: child, path: pathPrefix });
        } else if (child.type === "folder") {
          subFolderPromises.push(
            collectFilesRecursively(
              child.driveId,
              mekEnc,
              nameKey,
              [...pathPrefix, child.name],
              depth + 1,
            ),
          );
        }
      }

      const subResults = await Promise.all(subFolderPromises);
      for (const sub of subResults) {
        entries.push(...sub);
      }

      return entries;
    },
    [],
  );

  const handleShare = useCallback(
    async (
      targets: KakusuFile[],
      mode: "link" | "email",
      email?: string,
      expirationTime?: string,
      shareName?: string,
    ) => {
      const vault = useVaultStore.getState();
      if (!vault.mekWrap || !vault.mekEnc || !vault.shareFolderId) return;

      setSharing(true);
      setShareURL(null);
      const startedAt = Date.now();
      setShareProgress({ message: "準備中...", percent: 0, startedAt });

      try {
        // 1. Generate ShareKey
        const shareKeyBytes = generateShareKey();

        // 2. Wrap ShareKey with MEK_wrap for owner storage
        setShareProgress({
          message: "ShareKeyをラップ中...",
          percent: 3,
          startedAt,
        });
        const wrappedShareKey = await wrapShareKey(
          vault.mekWrap,
          shareKeyBytes,
        );

        // 3. Collect all files recursively
        setShareProgress({
          message: "ファイルを収集中...",
          percent: 5,
          startedAt,
        });
        const fileEntries: FlatFileEntry[] = [];
        const folderTargets: KakusuFile[] = [];
        const topLevelFiles: KakusuFile[] = [];

        for (const t of targets) {
          if (t.type === "file" && t.wrappedCek) {
            topLevelFiles.push(t);
          } else if (t.type === "folder") {
            folderTargets.push(t);
          }
        }

        const singleFolderMode =
          folderTargets.length === 1 && topLevelFiles.length === 0;

        for (const f of topLevelFiles) {
          fileEntries.push({ file: f, path: [] });
        }

        for (const folder of folderTargets) {
          const pathPrefix = singleFolderMode ? [] : [folder.name];
          const subEntries = await collectFilesRecursively(
            folder.driveId,
            vault.mekEnc,
            vault.nameKey,
            pathPrefix,
          );
          fileEntries.push(...subEntries);
        }

        if (fileEntries.length === 0) {
          setError("共有可能なファイルがありません");
          return;
        }

        // 4. For each file: unwrap CEK with MEK_wrap, re-wrap with ShareKey, encrypt name
        //    Process with pooled concurrency for better performance.
        setShareProgress({
          message: "CEKをラップ中...",
          percent: 10,
          startedAt,
        });
        let completed = 0;
        const items: ShareMetaItem[] = new Array(fileEntries.length);

        const processEntry = async (index: number) => {
          const entry = fileEntries[index]!;
          const wrappedCekBytes = fromBase64(entry.file.wrappedCek!);
          const unwrapKey =
            entry.file.keyVersion === "2" && vault.vaultKey
              ? vault.vaultKey
              : vault.mekWrap!;
          const wrappedCek = await rewrapCEKForShare(
            unwrapKey,
            wrappedCekBytes,
            shareKeyBytes,
          );
          const { encName, ivName } = await encryptNameWithShareKey(
            shareKeyBytes,
            entry.file.name,
          );
          const item: ShareMetaItem = {
            fileId: entry.file.driveId,
            wrappedCek,
            encName,
            ivName,
          };
          if (entry.path.length > 0) item.path = entry.path;
          items[index] = item;
          completed++;
          const pct = 10 + Math.round((completed / fileEntries.length) * 60);
          setShareProgress({
            message: `(${completed}/${fileEntries.length}) 鍵をラップ中...`,
            percent: pct,
            startedAt,
          });
        };

        // Simple pool: run up to sharePoolSize tasks concurrently
        const sharePoolSize = getSharePoolSize();
        let cursor = 0;
        const runNext = async (): Promise<void> => {
          while (cursor < fileEntries.length) {
            const i = cursor++;
            await processEntry(i);
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(sharePoolSize, fileEntries.length) },
            () => runNext(),
          ),
        );

        // 5. Determine mode and folder list
        const folderIds = folderTargets.map((f) => f.driveId);
        let metaMode: ShareMetaFile["mode"] = "files";
        if (folderIds.length > 0 && topLevelFiles.length > 0) {
          metaMode = "mixed";
        } else if (folderIds.length > 0) {
          metaMode = "folder";
        }

        // 6. Encrypt share name with MEK_enc (owner-only visible)
        const rawName =
          shareName || new Date().toISOString().replace("T", " ").slice(0, 19);
        const effectiveName =
          sanitizeTextInput(rawName).slice(0, TEXT_INPUT_MAX_LENGTH) ||
          rawName.slice(0, TEXT_INPUT_MAX_LENGTH);
        const { encNameFull: encShareName, ivMeta: ivShareName } =
          await encryptMetadata(vault.mekEnc, effectiveName);

        // 6b. Encrypt share name with ShareKey (recipient-visible)
        const {
          encName: encShareNameByShareKey,
          ivName: ivShareNameByShareKey,
        } = await encryptNameWithShareKey(shareKeyBytes, effectiveName);

        // 7. Create meta file
        setShareProgress({
          message: "メタファイルを作成中...",
          percent: 75,
          startedAt,
        });
        const shareId = generateUUID();
        const metaFile: ShareMetaFile = {
          version: 1,
          shareId,
          mode: metaMode,
          folders: folderIds,
          wrappedShareKey: encode(wrappedShareKey),
          encShareName,
          ivShareName,
          encShareNameByShareKey,
          ivShareNameByShareKey,
          items,
        };

        const metaFileId = await createShareMetaFile(
          vault.shareFolderId,
          metaFile,
          encShareName,
          ivShareName,
        );

        // 8. Set permissions on meta file and data files
        setShareProgress({ message: "権限設定中...", percent: 85, startedAt });
        await setShareMetaPermission(metaFileId, mode, email, expirationTime);
        await setShareDataPermissions(
          items,
          folderIds,
          mode,
          email,
          expirationTime,
        );

        // 9. Build URL
        setShareProgress({ message: "完了", percent: 100, startedAt });
        const url = buildShareURL(metaFileId, shareKeyBytes);
        setShareURL(url);

        // ダイアログが閉じられていた場合、トーストで通知
        const { shareTargets: currentTargets, addToast: toastAdd } =
          useUIStore.getState();
        if (currentTargets.length === 0) {
          toastAdd({
            message: "共有リンクが生成されました",
            type: "success",
            copyableUrl: url,
            autoDismiss: 30_000,
          });
        }
      } catch (e) {
        // ダイアログが閉じられていた場合、エラーもトーストで表示
        const { shareTargets: ct, addToast: ta } = useUIStore.getState();
        const errMsg = e instanceof Error ? e.message : "共有に失敗しました";
        if (ct.length === 0) {
          ta({ message: errMsg, type: "error" });
        } else {
          setError(errMsg);
        }
      } finally {
        setSharing(false);
        setShareProgress(null);
      }
    },
    [setError, collectFilesRecursively],
  );

  const copyShareURL = useCallback(async () => {
    if (shareURL) {
      await writeClipboardText(shareURL);
    }
  }, [shareURL]);

  return { handleShare, shareURL, sharing, shareProgress, copyShareURL };
}
