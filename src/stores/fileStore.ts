import { getCacheMaxAgeMs, getEffectiveParallelCount } from "@/cache/settings";
import {
  clearAllFiles,
  getCachedFolderListing,
  setCachedFolderListing,
} from "@/cache/store";
import {
  LARGE_FILE_THRESHOLD_BYTES,
  RESUMABLE_UPLOAD_THRESHOLD_BYTES,
  UPLOAD_CONCURRENCY_DEFAULT,
} from "@/config/app";
import {
  computeEncryptedSize,
  decryptFile,
  decryptFileFromStream,
  decryptFileStreaming,
  encryptFile,
  encryptFileStreaming,
  generateBaseIV,
} from "@/crypto/chunk";
import {
  DRIVE_NAME_BLOCK_BYTES,
  DRIVE_NAME_WARN_BYTES,
  buildEncryptedDriveName,
  encryptMetadata,
  estimateEncryptedDriveNameLength,
} from "@/crypto/encrypt";
import { generateCEK, unwrapCEK, wrapCEK } from "@/crypto/keys";
import * as driveApi from "@/drive/api";
import { listDataFiles as listDriveFiles } from "@/drive/files";
import {
  type DeleteProgress,
  deleteFolderBottomUp,
  trashFolderBottomUp,
} from "@/drive/recursiveOps";
import { syncAllFiles, syncFileTree, syncTrashedFiles } from "@/drive/sync";
import { DRIVE_NAME_MAX_BYTES } from "@/drive/validation";
import type { FileState, KakusuFile } from "@/types";
import { DEFAULT_CHUNK_SIZE, FOLDER_MIME } from "@/types";
import { fromBase64, toBase64 } from "@/utils/base64url";
import { downloadBlob } from "@/utils/download";
import {
  clearSegmentedAppProperty,
  writeSegmentedAppProperty,
} from "@/utils/driveProperties";
import { formatUserError } from "@/utils/errors";
import { getMimeType, sanitizeFileName } from "@/utils/preview";
import { generateUUID } from "@/utils/uuid";
import { ZipWriter } from "@/utils/zip";
import { create } from "zustand";
import { useCacheSettingsStore } from "./cacheSettingsStore";
import {
  buildNameEncryptionUpdate,
  buildRelativePath,
  buildRestorePlan,
  formatSpeed,
  pooledWithProgress,
  verifyChunkCount,
} from "./fileStoreHelpers";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";

function toast(
  message: string,
  type: "progress" | "success" | "error" = "progress",
  percent?: number,
  onCancel?: () => void,
) {
  return useUIStore
    .getState()
    .addToast({ message, type, percent, startedAt: Date.now(), onCancel });
}
function updateToast(
  id: string,
  updates: {
    message?: string;
    type?: "progress" | "success" | "error";
    percent?: number;
    speed?: string;
    onCancel?: () => void;
    phase?: "encrypting" | "uploading" | "downloading" | "decrypting";
  },
) {
  useUIStore.getState().updateToast(id, updates);
}





function loadCachedListing(
  folderId: string,
  mekEnc: CryptoKey | null,
): Promise<KakusuFile[] | null> {
  if (!mekEnc) return Promise.resolve(null);
  const { metadataCacheMode } = useCacheSettingsStore.getState();
  if (metadataCacheMode === "off") return Promise.resolve(null);
  return getCachedFolderListing(
    folderId,
    mekEnc,
    getCacheMaxAgeMs(metadataCacheMode),
  );
}

/**
 * 現在のフォルダ一覧をキャッシュに保存する（ナビゲーション前呼び出し用）。
 * files が空またはキャッシュ無効の場合は何もしない。
 */
function saveCachedListingForCurrentFolder(
  files: KakusuFile[],
  currentFolderId: string | null,
  browseMode: string,
): void {
  if (files.length === 0) return;
  const vault = useVaultStore.getState();
  if (!vault.mekEnc) return;
  const { metadataCacheMode } = useCacheSettingsStore.getState();
  if (metadataCacheMode === "off") return;
  const isShareMode = browseMode === "share";
  const rootId = isShareMode ? vault.shareFolderId : vault.dataFolderId;
  const targetId = currentFolderId || rootId;
  if (targetId) {
    void setCachedFolderListing(targetId, files, vault.mekEnc);
  }
}

/**
 * フォルダを再帰的にコピーする。
 * Google Drive の files.copy はフォルダ非対応なので、改めてフォルダを作成し
 * 中身のファイルを 1 つずつコピーする。
 */
async function copyFolderRecursive(
  sourceFolderId: string,
  destParentId: string,
): Promise<void> {
  const { createFolder } = await import("@/drive/folders");
  // 元フォルダのメタデータ取得
  const meta = await driveApi.getFileMetadata(sourceFolderId);
  // 先に空フォルダを作成（暗号化名メタデータも appProperties ごとコピー）
  const newFolder = await createFolder(
    destParentId,
    meta.name ?? "Untitled",
    meta.appProperties as Record<string, string> | undefined,
  );
  // 子アイテムを列挙（生の DriveFile データで appProperties を保持）
  const children = await listDriveFiles(sourceFolderId);
  // フォルダは順次（親→子の作成順序を保証）、ファイルは並列コピー
  const folders = children.filter((c) => c.mimeType === FOLDER_MIME);
  const files = children.filter((c) => c.mimeType !== FOLDER_MIME);
  // フォルダを先に作成（サブフォルダ構造の整合性のため順次）
  for (const folder of folders) {
    await copyFolderRecursive(folder.id, newFolder.id);
  }
  // ファイルは並列コピー
  if (files.length > 0) {
    await pooledWithProgress(
      files.map(
        (f) => () =>
          driveApi.copyFile(f.id, newFolder.id, undefined, f.appProperties),
      ),
      8,
    );
  }
}

export const useFileStore = create<FileState>((set, get) => {
  // Refresh debounce state (stored in closure, NOT Zustand state)
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingResolves: Array<() => void> = [];
  let refreshPromise: Promise<void> | null = null;

  // Navigation history state (stored in Zustand state for testability/HMR safety)
  const MAX_NAV_HISTORY = 100;
  type NavEntry = {
    folderId: string | null;
    folderPath: Array<{ id: string; name: string }>;
    browseMode: "data" | "share" | "trash";
  };

  const pushNavEntry = (entry: NavEntry) => {
    if (get()._navigatingFromHistory) return;
    const navHistory = [...get()._navHistory];
    // Trim forward history
    navHistory.splice(get()._navIndex + 1);
    navHistory.push(entry);
    let navIndex = navHistory.length - 1;
    // Evict oldest entries if history exceeds limit
    if (navHistory.length > MAX_NAV_HISTORY) {
      const excess = navHistory.length - MAX_NAV_HISTORY;
      navHistory.splice(0, excess);
      navIndex -= excess;
    }
    set({ _navHistory: navHistory, _navIndex: navIndex });
  };

  return {
    files: [],
    currentFolderId: null,
    folderPath: [],
    loading: false,
    browseMode: "data",
    canGoBack: false,
    canGoForward: false,
    _navHistory: [],
    _navIndex: -1,
    _navigatingFromHistory: false,

  setBrowseMode: (mode: "data" | "share" | "trash") => {
    set({
      browseMode: mode,
      currentFolderId: null,
      folderPath: [],
      files: [],
      loading: true,
      _navHistory: [{ folderId: null, folderPath: [], browseMode: mode }],
      _navIndex: 0,
      canGoBack: false,
      canGoForward: false,
    });
    const { _navIndex, _navHistory } = get();
    set({
      canGoBack: _navIndex > 0,
      canGoForward: _navIndex < _navHistory.length - 1,
    });
    // Immediately load cached listing (not for trash — always fetch fresh)
    if (mode !== "trash") {
      const vault = useVaultStore.getState();
      const rootId =
        mode === "share" ? vault.shareFolderId : vault.dataFolderId;
      if (rootId) {
        void loadCachedListing(rootId, vault.mekEnc).then((cached) => {
          if (
            get().currentFolderId === null &&
            get().browseMode === mode &&
            get().files.length === 0 &&
            cached !== null
          ) {
            set({ files: cached, loading: false });
          }
        });
      }
    }
    get().refresh();
  },

  navigate: (folderId: string | null, folderName?: string) => {
    // 保留中の仮フォルダ ID には移動しない
    if (folderId?.startsWith("__pending_")) return;
    // 離脱前に現フォルダの一覧をキャッシュに保存
    saveCachedListingForCurrentFolder(
      get().files,
      get().currentFolderId,
      get().browseMode,
    );
    let newPath: Array<{ id: string; name: string }>;
    if (folderId === null) {
      newPath = [];
      set({ currentFolderId: null, folderPath: [], files: [], loading: true });
    } else {
      const { folderPath } = get();
      const existingIdx = folderPath.findIndex((item) => item.id === folderId);
      if (existingIdx >= 0) {
        newPath = folderPath.slice(0, existingIdx + 1);
      } else if (folderName) {
        newPath = [...folderPath, { id: folderId, name: folderName }];
      } else {
        newPath = folderPath;
      }
      set({
        currentFolderId: folderId,
        folderPath: newPath,
        files: [],
        loading: true,
      });
    }
    pushNavEntry({
      folderId,
      folderPath: newPath,
      browseMode: get().browseMode,
    });
    const { _navIndex: navIdxAfterPush, _navHistory: navHistAfterPush } = get();
    set({
      canGoBack: navIdxAfterPush > 0,
      canGoForward: navIdxAfterPush < navHistAfterPush.length - 1,
    });
    // Immediately load cached listing
    const vault = useVaultStore.getState();
    const isShareMode = get().browseMode === "share";
    const rootId = isShareMode ? vault.shareFolderId : vault.dataFolderId;
    const targetId = folderId || rootId;
    if (targetId) {
      void loadCachedListing(targetId, vault.mekEnc).then((cached) => {
        if (
          get().currentFolderId === folderId &&
          get().files.length === 0 &&
          cached !== null
        ) {
          set({ files: cached, loading: false });
        }
      });
    }
    get().refresh();
  },

  goBack: () => {
    const state = get();
    if (state._navIndex <= 0) return;
    // 離脱前に現フォルダの一覧をキャッシュに保存
    saveCachedListingForCurrentFolder(
      get().files,
      get().currentFolderId,
      get().browseMode,
    );
    const newNavIndex = state._navIndex - 1;
    const entry = state._navHistory[newNavIndex];
    if (!entry) return;
    set({ _navigatingFromHistory: true });
    set({
      currentFolderId: entry.folderId,
      folderPath: entry.folderPath,
      browseMode: entry.browseMode,
      files: [],
      loading: true,
      canGoBack: newNavIndex > 0,
      canGoForward: newNavIndex < state._navHistory.length - 1,
      _navIndex: newNavIndex,
    });
    set({ _navigatingFromHistory: false });
    // Immediately load cached listing
    const vault = useVaultStore.getState();
    const rootId =
      entry.browseMode === "share" ? vault.shareFolderId : vault.dataFolderId;
    const targetId = entry.folderId || rootId;
    if (targetId) {
      void loadCachedListing(targetId, vault.mekEnc).then((cached) => {
        if (
          get().currentFolderId === entry.folderId &&
          get().files.length === 0 &&
          cached !== null
        ) {
          set({ files: cached, loading: false });
        }
      });
    }
    get().refresh();
  },

  goForward: () => {
    const state = get();
    if (state._navIndex >= state._navHistory.length - 1) return;
    // 離脱前に現フォルダの一覧をキャッシュに保存
    saveCachedListingForCurrentFolder(
      get().files,
      get().currentFolderId,
      get().browseMode,
    );
    const newNavIndex = state._navIndex + 1;
    const entry = state._navHistory[newNavIndex];
    if (!entry) return;
    set({ _navigatingFromHistory: true });
    set({
      currentFolderId: entry.folderId,
      folderPath: entry.folderPath,
      browseMode: entry.browseMode,
      files: [],
      loading: true,
      canGoBack: newNavIndex > 0,
      canGoForward: newNavIndex < state._navHistory.length - 1,
      _navIndex: newNavIndex,
    });
    set({ _navigatingFromHistory: false });
    // Immediately load cached listing
    const vault = useVaultStore.getState();
    const rootId =
      entry.browseMode === "share" ? vault.shareFolderId : vault.dataFolderId;
    const targetId = entry.folderId || rootId;
    if (targetId) {
      void loadCachedListing(targetId, vault.mekEnc).then((cached) => {
        if (
          get().currentFolderId === entry.folderId &&
          get().files.length === 0 &&
          cached !== null
        ) {
          set({ files: cached, loading: false });
        }
      });
    }
    get().refresh();
  },

  refresh: async () => {
    // Debounce: coalesce rapid refresh() calls
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      // Resolve any pending waiters so they don't hang
      for (const r of pendingResolves) r();
      pendingResolves = [];
    }

    await new Promise<void>((resolve) => {
      pendingResolves.push(resolve);
      refreshTimer = setTimeout(async () => {
        refreshTimer = null;
        const resolvers = pendingResolves;
        pendingResolves = [];
        const resolveAll = () => {
          for (const resolve of resolvers) {
            resolve();
          }
        };
        // Wait for any ongoing refresh to finish, then re-fetch with current state
        if (refreshPromise) {
          await refreshPromise;
          refreshPromise = null;
        }
        const vault = useVaultStore.getState();
        if (!vault.mekEnc || !vault.dataFolderId) {
          resolveAll();
          return;
        }
        const currentMode = get().browseMode;
        const mekEnc = vault.mekEnc;
        if (!mekEnc) {
          resolveAll();
          return;
        }

        // Trash mode: list all trashed Kakusu files
        if (currentMode === "trash") {
          if (get().files.length === 0) set({ loading: true });
          const doRefresh = async () => {
            try {
              const files = await syncTrashedFiles(mekEnc, vault.nameKey);
              if (get().browseMode === "trash") {
                set({ files, loading: false });
              }
            } catch (error) {
              console.error("Failed to refresh trash:", error);
              if (get().browseMode === "trash") {
                set({ loading: false });
              }
            }
          };
          refreshPromise = doRefresh();
          await refreshPromise;
          refreshPromise = null;
          resolveAll();
          return;
        }

        const isShareMode = currentMode === "share";
        if (isShareMode && !vault.shareFolderId) {
          resolveAll();
          return;
        }

        const rootId = isShareMode ? vault.shareFolderId : vault.dataFolderId;
        if (!rootId) {
          resolveAll();
          return;
        }
        const folderId = get().currentFolderId || rootId;

        // 保留中の仮 ID では Drive API を呼ばない
        if (folderId.startsWith("__pending_")) {
          resolveAll();
          return;
        }

        // If no files shown yet (cache miss), show spinner
        if (get().files.length === 0) set({ loading: true });

        const doRefresh = async () => {
          try {
            const files = await syncFileTree(folderId, mekEnc, vault.nameKey);
            if (
              get().browseMode === currentMode &&
              (get().currentFolderId || rootId) === folderId
            ) {
              set({ files, loading: false });
              // Update cache in background
              if (
                useCacheSettingsStore.getState().metadataCacheMode !== "off"
              ) {
                void setCachedFolderListing(folderId, files, mekEnc);
              }
            }
          } catch (error) {
            console.error("Failed to refresh files:", error);
            if (get().browseMode === currentMode) {
              set({ loading: false });
            }
          }
        };
        refreshPromise = doRefresh();
        await refreshPromise;
        refreshPromise = null;
        resolveAll();
      }, 50);
    });
  },

  upload: async (file: File, encryptName: boolean, options) => {
    const vault = useVaultStore.getState();
    if (!vault.mekEnc) return;
    const refreshAfterUpload = options?.refreshAfterUpload ?? true;
    const suppressToast = options?.suppressToast ?? false;
    const { browseMode } = get();
    // New shares are created via ShareDialog → useShare (meta-file approach).
    // Legacy share folders are read-only for backward compatibility.
    if (browseMode === "share") {
      useUIStore.getState().addToast({
        message:
          "共有フォルダへの直接アップロードは廃止されました。共有ダイアログから共有を作成してください。",
        type: "error",
      });
      return;
    }

    // ── Normal data mode upload ──
    if (!vault.mekWrap || !vault.dataFolderId) return;

    const wrapKey = vault.vaultKey ?? vault.mekWrap;
    const encKey = vault.nameKey ?? vault.mekEnc;
    const useV2 = !!vault.vaultKey;

    const abortController = new AbortController();
    const startedAt = Date.now();
    const tid = suppressToast
      ? ""
      : toast(`「${file.name}」をアップロード中...`, "progress", 0, () => {
          abortController.abort();
          updateToast(tid, {
            message: `「${file.name}」のアップロードを中止しました`,
            type: "error",
            onCancel: undefined,
          });
        });
    const update = suppressToast
      ? ((() => {}) as typeof updateToast)
      : updateToast;

    const parentId = get().currentFolderId || vault.dataFolderId;
    let createdFileId: string | null = null;

    // アップロード中の仮エントリをファイル一覧に追加
    const tempId = `__uploading_${generateUUID()}`;
    const uploadingEntry: KakusuFile = {
      driveId: tempId,
      parentId,
      name: file.name,
      nameEncrypted: false,
      type: "file",
      size: file.size,
      modifiedTime: new Date().toISOString(),
      uploading: true,
    };
    if (
      get().currentFolderId ===
        (parentId === vault.dataFolderId ? null : parentId) ||
      get().currentFolderId === parentId
    ) {
      set((s) => ({ files: [...s.files, uploadingEntry] }));
    }

    try {
      // Generate CEK
      const cek = await generateCEK();
      const wrappedCek = await wrapCEK(wrapKey, cek);

      if (abortController.signal.aborted)
        throw new DOMException("Aborted", "AbortError");

      // Build metadata common to both paths
      const appProperties: Record<string, string> = {
        name_encrypted: String(encryptName),
        wrapped_cek: toBase64(wrappedCek),
      };
      if (useV2) appProperties.key_version = "2";

      let driveName: string;
      if (encryptName && encKey) {
        // Validate & auto-truncate filename for encrypted Drive names
        let uploadName = file.name;
        const estLen = estimateEncryptedDriveNameLength(uploadName);
        if (estLen > DRIVE_NAME_BLOCK_BYTES) {
          // 拡張子を保持しつつファイル名を切り詰める
          const dotIdx = uploadName.lastIndexOf(".");
          const ext = dotIdx > 0 ? uploadName.slice(dotIdx) : "";
          const stem = dotIdx > 0 ? uploadName.slice(0, dotIdx) : uploadName;
          // 暗号化後バイト数が上限以下になるまで切り詰め
          let truncated = stem;
          while (
            truncated.length > 1 &&
            estimateEncryptedDriveNameLength(truncated + ext) >
              DRIVE_NAME_BLOCK_BYTES
          ) {
            truncated = truncated.slice(0, -1);
          }
          uploadName = truncated + ext;
          useUIStore.getState().addToast({
            message: `ファイル名が長すぎるため短くしました: 「${uploadName}」`,
            type: "info",
          });
        } else if (estLen > DRIVE_NAME_WARN_BYTES) {
          useUIStore.getState().addToast({
            message: `「${file.name}」の暗号化ファイル名が長めです（${estLen} バイト）。ファイル名が短いとより安全です。`,
            type: "error",
          });
        }

        const nameUpdate = await buildNameEncryptionUpdate(
          encKey,
          uploadName,
          true,
          false,
          useV2,
        );
        Object.assign(
          appProperties,
          nameUpdate.appProperties as Record<string, string>,
        );
        driveName = nameUpdate.driveName;
      } else {
        driveName = `${file.name}.enc`;
      }

      const wrappedCekBytes = new Uint8Array(wrappedCek);
      const encryptedSize = computeEncryptedSize(
        file.size,
        DEFAULT_CHUNK_SIZE,
        wrappedCekBytes.byteLength,
      );
      const totalChunks = Math.max(
        1,
        Math.ceil(file.size / DEFAULT_CHUNK_SIZE),
      );
      appProperties.total_chunks = String(totalChunks);
      const isLarge = encryptedSize > RESUMABLE_UPLOAD_THRESHOLD_BYTES;

      if (isLarge) {
        // ── Streaming encrypt + upload for large files ──
        // Avoids loading the entire file into memory at once.
        const baseIV = generateBaseIV();
        appProperties.iv_body = toBase64(baseIV);

        const uploadStartedAt = Date.now();
        update(tid, {
          message: `「${file.name}」をアップロード中...`,
          percent: 0,
          phase: "uploading",
          speed: "",
        });
        await driveApi
          .createFileResumableFromStream(
            {
              name: driveName,
              parents: [parentId],
              mimeType: "application/octet-stream",
              appProperties,
            },
            encryptedSize,
            () =>
              encryptFileStreaming(
                cek,
                file,
                baseIV,
                DEFAULT_CHUNK_SIZE,
                undefined,
                wrappedCekBytes,
              ),
            (loaded, total) => {
              if (abortController.signal.aborted) return;
              const percent =
                total > 0 ? Math.round((loaded / total) * 100) : 0;
              update(tid, {
                message: `「${file.name}」をアップロード中...`,
                percent,
                speed: formatSpeed(loaded, uploadStartedAt),
                phase: "uploading",
              });
            },
          )
          .then((result) => {
            createdFileId = result.id;
            return result;
          });
      } else {
        // ── Small file: read into memory, encrypt, multipart upload ──
        let plaintext = await file.arrayBuffer();
        const { encrypted, baseIV } = await encryptFile(
          cek,
          plaintext,
          undefined,
          (done, total) => {
            if (abortController.signal.aborted) return;
            const bytesEncrypted = Math.min(
              done * DEFAULT_CHUNK_SIZE,
              file.size,
            );
            const percent = Math.round((done / total) * 100);
            update(tid, {
              message: `「${file.name}」をアップロード中...`,
              percent,
              speed: formatSpeed(bytesEncrypted, startedAt),
              phase: "uploading",
            });
          },
          wrappedCekBytes,
        );
        // Release plaintext buffer to free memory before upload (GC hint)
        plaintext = undefined!;

        if (abortController.signal.aborted)
          throw new DOMException("Aborted", "AbortError");
        update(tid, {
          message: `「${file.name}」をアップロード中...`,
          percent: 0,
          phase: "uploading",
          speed: "",
        });

        appProperties.iv_body = toBase64(baseIV);

        const uploadStartedAt = Date.now();
        const result = await driveApi.createFileMultipart(
          {
            name: driveName,
            parents: [parentId],
            mimeType: "application/octet-stream",
            appProperties,
          },
          encrypted,
          (loaded, total) => {
            if (abortController.signal.aborted) return;
            const percent = Math.round((loaded / total) * 100);
            update(tid, {
              percent,
              speed: formatSpeed(loaded, uploadStartedAt),
              phase: "uploading",
            });
          },
        );
        createdFileId = result.id;
      }

      // If cancelled while the API call was in flight, delete the created file
      if (abortController.signal.aborted && createdFileId) {
        await driveApi
          .deleteFile(createdFileId)
          .catch((e) =>
            console.warn("Cleanup: failed to delete cancelled upload", e),
          );
        set((s) => ({ files: s.files.filter((f) => f.driveId !== tempId) }));
        return;
      }

      update(tid, {
        message: `「${file.name}」のアップロード完了`,
        type: "success",
        percent: 100,
        onCancel: undefined,
      });
      if (refreshAfterUpload) {
        await get().refresh();
      }
      // refresh() が files 配列を丸ごと置き換えるので仮エントリは消えるが、
      // refresh しない場合やモード不一致で置き換わらない場合に備えて除去
      set((s) => ({ files: s.files.filter((f) => f.driveId !== tempId) }));
    } catch (e) {
      // アップロード失敗/中止: 仮エントリを除去
      set((s) => ({ files: s.files.filter((f) => f.driveId !== tempId) }));
      // Clean up partially uploaded file on cancel or error
      if (createdFileId) {
        await driveApi
          .deleteFile(createdFileId)
          .catch((e) =>
            console.warn("Cleanup: failed to delete failed upload", e),
          );
      }
      if (e instanceof DOMException && e.name === "AbortError") return;
      update(tid, {
        message: formatUserError(`「${file.name}」のアップロード失敗`, e),
        type: "error",
        onCancel: undefined,
      });
      throw e;
    }
  },

  download: async (file: KakusuFile) => {
    const vault = useVaultStore.getState();

    const abortController = new AbortController();
    const startedAt = Date.now();
    const tid = toast(
      `「${file.name}」をダウンロード中...`,
      "progress",
      0,
      () => {
        abortController.abort();
        updateToast(tid, {
          message: `「${file.name}」のダウンロードを中止しました`,
          type: "error",
          onCancel: undefined,
        });
      },
    );

    try {
      if (!vault.mekWrap) return;
      if (!file.wrappedCek || !file.ivBody) {
        throw new Error("ファイルの鍵情報がありません");
      }

      const unwrapKey =
        file.keyVersion === "2" && vault.vaultKey
          ? vault.vaultKey
          : vault.mekWrap;
      const wrappedCekBytes = fromBase64(file.wrappedCek);
      const cek = await unwrapCEK(unwrapKey, wrappedCekBytes);

      if (abortController.signal.aborted)
        throw new DOMException("Aborted", "AbortError");

      // Use streaming download + decryption + File System Access API when
      // available, avoiding buffering the entire ciphertext or plaintext.
      if (typeof window.showSaveFilePicker === "function") {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: sanitizeFileName(file.name),
          });
          const writable = await handle.createWritable();
          try {
            const { stream, total: encTotal } =
              await driveApi.getFileContentAsStream(
                file.driveId,
                (loaded, total) => {
                  if (abortController.signal.aborted) return;
                  const percent =
                    total > 0 ? Math.round((loaded / total) * 50) : 0;
                  updateToast(tid, {
                    percent,
                    speed: formatSpeed(loaded, startedAt),
                    phase: "downloading",
                  });
                },
              );

            if (abortController.signal.aborted) {
              stream.cancel();
              throw new DOMException("Aborted", "AbortError");
            }

            const decryptStartedAt = Date.now();
            let streamChunkCount = 0;
            for await (const chunk of decryptFileFromStream(
              cek,
              stream,
              encTotal || (file.size ?? 0),
              (done, total) => {
                streamChunkCount = done;
                if (abortController.signal.aborted) return;
                const percent =
                  50 + (total > 0 ? Math.round((done / total) * 50) : 0);
                updateToast(tid, {
                  percent,
                  phase: "decrypting",
                  speed: formatSpeed(
                    done * DEFAULT_CHUNK_SIZE,
                    decryptStartedAt,
                  ),
                });
              },
            )) {
              if (abortController.signal.aborted) {
                await writable.abort();
                throw new DOMException("Aborted", "AbortError");
              }
              await writable.write(chunk);
            }
            verifyChunkCount(streamChunkCount, file.totalChunks, file.name);
            await writable.close();
          } catch (streamErr) {
            try {
              await writable.abort();
            } catch {
              /* ignore */
            }
            throw streamErr;
          }
          updateToast(tid, {
            message: `「${file.name}」のダウンロード完了`,
            type: "success",
            percent: 100,
            onCancel: undefined,
          });
          return;
        } catch (pickerErr) {
          // User cancelled the file picker — not an error
          if (
            pickerErr instanceof DOMException &&
            pickerErr.name === "AbortError"
          ) {
            updateToast(tid, {
              message: `「${file.name}」のダウンロードをキャンセルしました`,
              type: "error",
              onCancel: undefined,
            });
            return;
          }
          // Fall through to blob-based download on other errors
        }
      }

      // Fallback: buffer ciphertext then decrypt (browsers without File System Access API)
      const ciphertext = await driveApi.getFileContentWithProgress(
        file.driveId,
        (loaded, total) => {
          if (abortController.signal.aborted) return;
          const percent = Math.round((loaded / total) * 100);
          updateToast(tid, {
            percent,
            speed: formatSpeed(loaded, startedAt),
            phase: "downloading",
          });
        },
        file.size,
      );

      if (abortController.signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      updateToast(tid, { percent: 0, phase: "decrypting", speed: "" });
      const decryptStartedAt = Date.now();
      let fallbackChunkCount = 0;
      const decrypted = await decryptFile(cek, ciphertext, (done, total) => {
        fallbackChunkCount = done;
        if (abortController.signal.aborted) return;
        const percent = Math.round((done / total) * 100);
        updateToast(tid, {
          percent,
          phase: "decrypting",
          speed: formatSpeed(done * DEFAULT_CHUNK_SIZE, decryptStartedAt),
        });
      });
      verifyChunkCount(fallbackChunkCount, file.totalChunks, file.name);

      const blob = new Blob([decrypted]);
      downloadBlob(blob, sanitizeFileName(file.name));
      updateToast(tid, {
        message: `「${file.name}」のダウンロード完了`,
        type: "success",
        percent: 100,
        onCancel: undefined,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      updateToast(tid, {
        message: formatUserError(`「${file.name}」のダウンロード失敗`, e),
        type: "error",
        onCancel: undefined,
      });
      throw e;
    }
  },

  downloadFolder: async (folder: KakusuFile) => {
    const vault = useVaultStore.getState();
    if (!vault.mekEnc || !vault.mekWrap) return;

    const abortController = new AbortController();
    const startedAt = Date.now();
    const tid = toast(
      `「${folder.name}」フォルダをダウンロード中...`,
      "progress",
      0,
      () => {
        abortController.abort();
        updateToast(tid, {
          message: `「${folder.name}」のダウンロードを中止しました`,
          type: "error",
          onCancel: undefined,
        });
      },
    );

    try {
      // Recursively collect all files with their relative paths
      const allFiles = await syncAllFiles(
        folder.driveId,
        vault.mekEnc,
        vault.nameKey,
      );
      const fileItems = allFiles.filter(
        (f) => f.type === "file" && f.wrappedCek,
      );

      if (fileItems.length === 0) {
        updateToast(tid, {
          message: `「${folder.name}」にファイルがありません`,
          type: "error",
          onCancel: undefined,
        });
        return;
      }

      // Build path map: driveId → relative path  (folder.name/sub/file.txt)
      const filesById = new Map<string, KakusuFile>();
      filesById.set(folder.driveId, folder);
      for (const f of allFiles) {
        filesById.set(f.driveId, f);
      }

      // Try File System Access API first
      const useFileSystemAPI = typeof window.showDirectoryPicker === "function";
      let dirHandle: FileSystemDirectoryHandle | null = null;
      if (useFileSystemAPI) {
        try {
          if (!window.showDirectoryPicker) {
            throw new Error("showDirectoryPicker is not available");
          }
          dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        } catch (e) {
          // User cancelled or API not available → fall through to ZIP
          if (e instanceof DOMException && e.name === "AbortError") {
            updateToast(tid, {
              message: "ダウンロードをキャンセルしました",
              type: "error",
              onCancel: undefined,
            });
            return;
          }
          dirHandle = null;
        }
      }

      let totalBytes = 0;

      if (dirHandle) {
        // === File System Access API path (concurrent) ===
        let completedFiles = 0;
        const fsapiHandle = dirHandle;

        const processFile = async (file: KakusuFile) => {
          if (abortController.signal.aborted)
            throw new DOMException("Aborted", "AbortError");

          if (!file.wrappedCek) {
            throw new Error(`「${file.name}」の鍵情報が見つかりません`);
          }
          const unwrapKey =
            file.keyVersion === "2" && vault.vaultKey
              ? vault.vaultKey
              : vault.mekWrap!;
          const wrappedCekBytes = fromBase64(file.wrappedCek);
          const cek = await unwrapCEK(unwrapKey, wrappedCekBytes);
          const ciphertext = await driveApi.getFileContentWithProgress(
            file.driveId,
            () => {
              if (abortController.signal.aborted) return;
            },
            file.size,
          );
          totalBytes += ciphertext.byteLength;

          // Navigate/create subdirectories
          const relPath = buildRelativePath(
            file,
            folder.driveId,
            folder.name,
            filesById,
          );
          const pathParts = relPath.split("/");
          let currentDir = fsapiHandle;
          for (let p = 0; p < pathParts.length - 1; p++) {
            const pathPart = pathParts[p];
            if (!pathPart) {
              continue;
            }
            currentDir = await currentDir.getDirectoryHandle(pathPart, {
              create: true,
            });
          }
          const fileName = pathParts[pathParts.length - 1];
          if (!fileName) {
            throw new Error(`「${file.name}」の保存先パスが不正です`);
          }
          const fileHandle = await currentDir.getFileHandle(fileName, {
            create: true,
          });
          const writable = await fileHandle.createWritable();
          for await (const chunk of decryptFileStreaming(cek, ciphertext)) {
            if (abortController.signal.aborted) {
              await writable.abort();
              throw new DOMException("Aborted", "AbortError");
            }
            await writable.write(chunk);
          }
          await writable.close();
          completedFiles++;
          updateToast(tid, {
            message: `(${completedFiles}/${fileItems.length}) ダウンロード中...`,
            percent: Math.round((completedFiles / fileItems.length) * 100),
            speed: formatSpeed(totalBytes, startedAt),
            phase: "downloading",
          });
        };

        await pooledWithProgress(
          fileItems.map((file) => () => processFile(file)),
          3,
        );
      } else {
        // === ZIP download ===
        // Try streaming ZIP via File System Access API to avoid buffering
        // all plaintext in memory simultaneously.
        let zipWriter: ZipWriter;
        let isStreamingZip = false;
        if (typeof window.showSaveFilePicker === "function") {
          try {
            const saveHandle = await window.showSaveFilePicker({
              suggestedName: `${sanitizeFileName(folder.name)}.zip`,
              types: [
                { description: "ZIP", accept: { "application/zip": [".zip"] } },
              ],
            });
            const writable = await saveHandle.createWritable();
            const streamWriter = (
              writable as unknown as WritableStream<Uint8Array>
            ).getWriter();
            zipWriter = ZipWriter.forStream(streamWriter);
            isStreamingZip = true;
          } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") {
              updateToast(tid, {
                message: "ダウンロードをキャンセルしました",
                type: "error",
                onCancel: undefined,
              });
              return;
            }
            zipWriter = ZipWriter.forBlob();
          }
        } else {
          zipWriter = ZipWriter.forBlob();
        }

        for (let i = 0; i < fileItems.length; i++) {
          if (abortController.signal.aborted)
            throw new DOMException("Aborted", "AbortError");
          const file = fileItems[i];
          if (!file) {
            continue;
          }
          updateToast(tid, {
            message: `(${i + 1}/${fileItems.length}) 「${file.name}」をダウンロード中...`,
            percent: Math.round((i / fileItems.length) * 90),
            speed: formatSpeed(totalBytes, startedAt),
            phase: "downloading",
          });

          if (!file.wrappedCek) {
            throw new Error(`「${file.name}」の鍵情報が見つかりません`);
          }
          const unwrapKey =
            file.keyVersion === "2" && vault.vaultKey
              ? vault.vaultKey
              : vault.mekWrap;
          const wrappedCekBytes = fromBase64(file.wrappedCek);
          const cek = await unwrapCEK(unwrapKey, wrappedCekBytes);
          const ciphertext = await driveApi.getFileContentWithProgress(
            file.driveId,
            (loaded, total) => {
              if (abortController.signal.aborted) return;
              const filePct = total > 0 ? loaded / total : 0;
              const overallPct = Math.round(
                ((i + filePct) / fileItems.length) * 90,
              );
              updateToast(tid, {
                percent: overallPct,
                speed: formatSpeed(totalBytes + loaded, startedAt),
                phase: "downloading",
              });
            },
            file.size,
          );
          totalBytes += ciphertext.byteLength;

          updateToast(tid, {
            message: `(${i + 1}/${fileItems.length}) 「${file.name}」を復号中...`,
            phase: "decrypting",
          });

          const relPath = buildRelativePath(
            file,
            folder.driveId,
            folder.name,
            filesById,
          );

          // Stream decrypted chunks into ZIP to avoid holding all
          // plaintext in memory at once.
          await zipWriter.addEntryStreaming(
            relPath,
            decryptFileStreaming(cek, ciphertext),
          );
        }

        updateToast(tid, { message: "ZIPファイルを作成中...", percent: 90 });
        const blob = await zipWriter.finish();

        if (!isStreamingZip && blob) {
          downloadBlob(blob, `${sanitizeFileName(folder.name)}.zip`);
        }
      }

      updateToast(tid, {
        message: `「${folder.name}」の全${fileItems.length}件ダウンロード完了`,
        type: "success",
        percent: 100,
        onCancel: undefined,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      updateToast(tid, {
        message: formatUserError(`「${folder.name}」のダウンロード失敗`, e),
        type: "error",
        onCancel: undefined,
      });
      throw e;
    }
  },

  downloadFileAsBlob: async (file: KakusuFile): Promise<Blob> => {
    const vault = useVaultStore.getState();
    if (!vault.mekWrap) throw new Error("Vault is locked");
    if (!file.wrappedCek || !file.ivBody)
      throw new Error("ファイルの鍵情報がありません");

    const unwrapKey =
      file.keyVersion === "2" && vault.vaultKey
        ? vault.vaultKey
        : vault.mekWrap;
    const wrappedCekBytes = fromBase64(file.wrappedCek);
    const cek = await unwrapCEK(unwrapKey, wrappedCekBytes);
    const ciphertext = await driveApi.getFileContent(file.driveId);
    let blobChunkCount = 0;
    const decrypted = await decryptFile(cek, ciphertext, (done) => {
      blobChunkCount = done;
    });
    verifyChunkCount(blobChunkCount, file.totalChunks, file.name);
    return new Blob([decrypted], { type: getMimeType(file.name) });
  },

  createFolder: async (name: string, encryptName: boolean) => {
    const vault = useVaultStore.getState();
    if (!vault.mekEnc || !vault.dataFolderId) return null;

    // Validate non-encrypted folder name length against Drive limit
    if (encryptName) {
      const estLen = estimateEncryptedDriveNameLength(name, true);
      if (estLen > DRIVE_NAME_BLOCK_BYTES) {
        useUIStore.getState().addToast({
          message: `フォルダ名が長すぎます（暗号化後 ${estLen} バイト、上限 ${DRIVE_NAME_BLOCK_BYTES}）。短くしてください。`,
          type: "error",
        });
        return null;
      }
      if (estLen > DRIVE_NAME_WARN_BYTES) {
        useUIStore.getState().addToast({
          message: `暗号化フォルダ名が長めです（${estLen} バイト）`,
          type: "error",
        });
      }
    } else {
      const byteLen = new TextEncoder().encode(name).length;
      if (byteLen > DRIVE_NAME_MAX_BYTES) {
        useUIStore.getState().addToast({
          message: `フォルダ名が長すぎます（${byteLen}バイト、上限${DRIVE_NAME_MAX_BYTES}バイト）`,
          type: "error",
        });
        return null;
      }
    }

    const tid = toast("フォルダを作成中...", "progress");

    const parentId = get().currentFolderId || vault.dataFolderId;

    try {
      const nameEncKey = vault.nameKey ?? vault.mekEnc;
      const useV2 = !!vault.vaultKey;
      const appProperties: Record<string, string> = {
        name_encrypted: String(encryptName),
      };
      if (useV2) appProperties.key_version = "2";

      let driveName: string;
      if (encryptName) {
        const nameUpdate = await buildNameEncryptionUpdate(
          nameEncKey,
          name,
          true,
          true,
          useV2,
        );
        Object.assign(
          appProperties,
          nameUpdate.appProperties as Record<string, string>,
        );
        driveName = nameUpdate.driveName;
      } else {
        driveName = name;
      }

      const created = await driveApi.createFileMultipart({
        name: driveName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
        appProperties,
      });

      updateToast(tid, { message: "フォルダを作成しました", type: "success" });
      await get().refresh();
      return created.id;
    } catch (e) {
      updateToast(tid, {
        message: formatUserError("フォルダの作成に失敗しました", e),
        type: "error",
      });
      return null;
    }
  },

  addPendingFolder: () => {
    const vault = useVaultStore.getState();
    const parentId = get().currentFolderId || vault.dataFolderId || "";
    const tempId = `__pending_${generateUUID()}`;
    const pendingFolder: KakusuFile = {
      driveId: tempId,
      parentId,
      name: "新しいフォルダ",
      nameEncrypted: false,
      type: "folder",
      modifiedTime: new Date().toISOString(),
      pending: true,
    };
    set((s) => ({ files: [...s.files, pendingFolder] }));
    return tempId;
  },

  confirmPendingFolder: async (
    tempId: string,
    name: string,
    encryptName: boolean,
  ) => {
    // Remove the pending entry first and replace with optimistic local folder
    const vault = useVaultStore.getState();
    // 保留フォルダ自身の parentId を使う（ユーザーが別フォルダへ移動していた場合に備える）
    const pendingFolder = get().files.find((f) => f.driveId === tempId);
    const parentId =
      pendingFolder?.parentId ||
      get().currentFolderId ||
      vault.dataFolderId ||
      "";
    set((s) => ({
      files: s.files.map((f) =>
        f.driveId === tempId
          ? { ...f, name, pending: false, uploading: true }
          : f,
      ),
    }));

    // Create the real folder on Drive in the background
    (async () => {
      const tid = toast(`「${name}」フォルダを作成中...`, "progress");
      try {
        const nameEncKey = vault.nameKey ?? vault.mekEnc;
        if (!nameEncKey) {
          throw new Error("暗号化鍵が初期化されていません");
        }
        const useV2Folder = !!vault.vaultKey;
        const appProperties: Record<string, string> = {
          name_encrypted: String(encryptName),
        };
        if (useV2Folder) appProperties.key_version = "2";
        let driveName: string;
        if (encryptName) {
          const nameUpdate = await buildNameEncryptionUpdate(
            nameEncKey,
            name,
            true,
            true,
            useV2Folder,
          );
          Object.assign(
            appProperties,
            nameUpdate.appProperties as Record<string, string>,
          );
          driveName = nameUpdate.driveName;
        } else {
          driveName = name;
        }
        const created = await driveApi.createFileMultipart({
          name: driveName,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentId],
          appProperties,
        });
        // Replace pending entry's driveId with the real Drive ID immediately
        set((s) => ({
          files: s.files.map((f) =>
            f.driveId === tempId ? { ...f, driveId: created.id } : f,
          ),
        }));
        updateToast(tid, {
          message: `「${name}」フォルダを作成しました`,
          type: "success",
        });
        // Silently refresh to sync full metadata
        const currentFolderId = get().currentFolderId || vault.dataFolderId;
        if (currentFolderId && vault.mekEnc) {
          const files = await syncFileTree(
            currentFolderId,
            vault.mekEnc,
            vault.nameKey,
          );
          set({ files });
        }
      } catch (error) {
        console.error("Failed to create folder:", error);
        updateToast(tid, {
          message: "フォルダの作成に失敗しました",
          type: "error",
        });
        // Remove the optimistic entry on failure
        set((s) => ({ files: s.files.filter((f) => f.driveId !== tempId) }));
      }
    })();
  },

  removePendingFolder: (tempId: string) => {
    set((s) => ({ files: s.files.filter((f) => f.driveId !== tempId) }));
  },

  rename: async (file: KakusuFile, newName: string) => {
    const vault = useVaultStore.getState();
    if (!vault.mekEnc) return;

    // Validate filename length for encrypted files/folders
    if (file.nameEncrypted) {
      const estLen = estimateEncryptedDriveNameLength(
        newName,
        file.type === "folder",
      );
      if (estLen > DRIVE_NAME_BLOCK_BYTES) {
        useUIStore.getState().addToast({
          message: `名前が長すぎます（暗号化後 ${estLen} バイト、上限 ${DRIVE_NAME_BLOCK_BYTES}）。短くしてください。`,
          type: "error",
        });
        return;
      }
      if (estLen > DRIVE_NAME_WARN_BYTES) {
        useUIStore.getState().addToast({
          message: `暗号化名が長めです（${estLen} バイト）`,
          type: "error",
        });
      }
    } else {
      const driveName = file.type === "folder" ? newName : `${newName}.enc`;
      const byteLen = new TextEncoder().encode(driveName).length;
      if (byteLen > DRIVE_NAME_MAX_BYTES) {
        useUIStore.getState().addToast({
          message: `名前が長すぎます（${byteLen}バイト、上限${DRIVE_NAME_MAX_BYTES}バイト）`,
          type: "error",
        });
        return;
      }
    }

    const tid = toast("名前を変更中...", "progress");

    try {
      // Shared files: update owner-visible name
      if (file.isShared) {
        const nameEncKey = vault.nameKey ?? vault.mekEnc;
        if (!nameEncKey) throw new Error("Encryption key not available");
        const ownerResult = await encryptMetadata(nameEncKey, newName);
        const appProperties: Record<string, string | null> = {
          owner_iv_meta: ownerResult.ivMeta,
        };
        clearSegmentedAppProperty(appProperties, "owner_enc_name");
        writeSegmentedAppProperty(
          appProperties as Record<string, string>,
          "owner_enc_name",
          ownerResult.encNameFull,
        );
        await driveApi.updateFileMetadata(file.driveId, { appProperties });
      } else {
        const nameEncKey = (vault.nameKey ?? vault.mekEnc) as CryptoKey;
        const update = await buildNameEncryptionUpdate(
          nameEncKey,
          newName,
          file.nameEncrypted,
          file.type === "folder",
        );
        await driveApi.updateFileMetadata(file.driveId, {
          name: update.driveName,
          appProperties: update.appProperties,
        });
      }

      updateToast(tid, { message: "名前を変更しました", type: "success" });
      await get().refresh();
    } catch (e) {
      updateToast(tid, {
        message: formatUserError("名前の変更に失敗しました", e),
        type: "error",
      });
    }
  },

  applyNameEncryptionToAll: async (encryptName: boolean) => {
    const vault = useVaultStore.getState();
    if (!vault.mekEnc || !vault.dataFolderId) return;

    const tid = toast(
      encryptName
        ? "既存のファイル名とフォルダ名を暗号化中..."
        : "既存のファイル名とフォルダ名を復元中...",
      "progress",
      0,
    );

    try {
      const targets = (
        await syncAllFiles(vault.dataFolderId, vault.mekEnc, vault.nameKey)
      ).filter((file) => !file.isShared && file.nameEncrypted !== encryptName);

      if (targets.length === 0) {
        updateToast(tid, {
          message: "既存のファイルとフォルダはすでに現在の設定です",
          type: "success",
          percent: 100,
        });
        return;
      }

      const results = await pooledWithProgress(
        targets.map((file) => async () => {
          const nameEncKey = (vault.nameKey ?? vault.mekEnc) as CryptoKey;
          const update = await buildNameEncryptionUpdate(
            nameEncKey,
            file.name,
            encryptName,
            file.type === "folder",
          );
          await driveApi.updateFileMetadata(file.driveId, {
            name: update.driveName,
            appProperties: update.appProperties,
          });
        }),
        3,
        (done, total) => {
          updateToast(tid, {
            message: `${done}/${total}件に適用中...`,
            percent: Math.round((done / total) * 100),
          });
        },
      );

      const failed = results.filter(
        (result) => result.status === "rejected",
      ).length;
      const succeeded = targets.length - failed;

      await clearAllFiles();
      await get().refresh();

      updateToast(tid, {
        message:
          failed === 0
            ? `${succeeded}件に適用しました`
            : `${succeeded}件に適用しました（${failed}件失敗）`,
        type: failed === 0 ? "success" : "error",
        percent: 100,
      });
    } catch (e) {
      updateToast(tid, {
        message: formatUserError("既存アイテムへの適用に失敗しました", e),
        type: "error",
      });
      await clearAllFiles();
      await get().refresh();
    }
  },

  remove: async (file: KakusuFile) => {
    const tid = toast("削除中...", "progress");
    try {
      if (file.type === "folder") {
        await trashFolderBottomUp(file.driveId, (p) => {
          if (p.phase === "scan") {
            updateToast(tid, { message: `検出中... ${p.found}件` });
          } else {
            updateToast(tid, {
              message: `削除中... (${p.deleted}/${p.found}件)`,
              percent: Math.round((p.deleted / Math.max(p.found, 1)) * 100),
            });
          }
        });
      } else {
        await driveApi.trashFile(file.driveId);
      }
      updateToast(tid, { message: "削除しました", type: "success" });
      await get().refresh();
    } catch (e) {
      updateToast(tid, {
        message: formatUserError("削除に失敗しました", e),
        type: "error",
      });
    }
  },

  moveFile: async (
    fileId: string,
    newParentId: string,
    oldParentId: string,
  ) => {
    const tid = toast("移動中...", "progress");
    try {
      await driveApi.moveFile(fileId, newParentId, oldParentId);
      updateToast(tid, { message: "移動しました", type: "success" });
      await get().refresh();
    } catch (e) {
      updateToast(tid, {
        message: formatUserError("移動に失敗しました", e),
        type: "error",
      });
    }
  },

  moveFiles: async (
    moves: { fileId: string; newParentId: string; oldParentId: string }[],
  ) => {
    if (moves.length === 0) return;
    const tid = toast(`${moves.length}件を移動中...`, "progress");
    try {
      await driveApi.moveFiles(moves);
      updateToast(tid, {
        message: `${moves.length}件を移動しました`,
        type: "success",
      });
      await get().refresh();
    } catch (e) {
      updateToast(tid, {
        message: formatUserError("移動に失敗しました", e),
        type: "error",
      });
    }
  },

  pasteFiles: async (clipboard, destFolderId) => {
    const { action, files: items, sourceFolderId } = clipboard;
    const label = action === "copy" ? "コピー" : "移動";
    const tid = toast(`${items.length}件を${label}中...`, "progress", 0);
    try {
      if (action === "cut") {
        // 切り取り = batch moveFiles
        await driveApi.moveFiles(
          items.map((item) => ({
            fileId: item.driveId,
            oldParentId: sourceFolderId ?? item.parentId,
            newParentId: destFolderId,
          })),
        );
      } else {
        // コピー: フォルダは順次（再帰コピー）、ファイルは並列
        const folders = items.filter((i) => i.type === "folder");
        const files = items.filter((i) => i.type !== "folder");
        let completed = 0;
        const total = items.length;
        for (const folder of folders) {
          await copyFolderRecursive(folder.driveId, destFolderId);
          completed++;
          updateToast(tid, { percent: Math.round((completed / total) * 100) });
        }
        if (files.length > 0) {
          await pooledWithProgress(
            files.map((item) => async () => {
              const meta = await driveApi.getFileMetadata(item.driveId);
              await driveApi.copyFile(
                item.driveId,
                destFolderId,
                undefined,
                meta.appProperties,
              );
            }),
            8,
            (done) => {
              updateToast(tid, {
                percent: Math.round(((completed + done) / total) * 100),
              });
            },
          );
        }
      }

      updateToast(tid, {
        message: `${items.length}件を${label}しました`,
        type: "success",
        percent: 100,
      });
      await get().refresh();
    } catch (e) {
      updateToast(tid, {
        message: formatUserError(`${label}に失敗しました`, e),
        type: "error",
      });
    }
  },

  removeMultiple: async (files: KakusuFile[]) => {
    const tid = toast(`${files.length}件を削除中...`, "progress", 0);
    try {
      const folders = files.filter((f) => f.type === "folder");
      const nonFolders = files.filter((f) => f.type !== "folder");
      const errors: Error[] = [];
      let prevFound = 0;
      let prevDeleted = 0;
      // フォルダは子孫を先にボトムアップで処理（個別のエラーは継続）
      for (const folder of folders) {
        let folderTotal = 0;
        try {
          await trashFolderBottomUp(folder.driveId, (p: DeleteProgress) => {
            folderTotal = p.found;
            if (p.phase === "scan") {
              updateToast(tid, {
                message: `検出中... ${prevFound + p.found}件`,
              });
            } else {
              const totalDeleted = prevDeleted + p.deleted;
              const totalFound = prevFound + p.found + nonFolders.length;
              updateToast(tid, {
                message: `削除中... (${totalDeleted}/${totalFound}件)`,
                percent: Math.round(
                  (totalDeleted / Math.max(totalFound, 1)) * 100,
                ),
              });
            }
          });
          prevFound += folderTotal;
          prevDeleted += folderTotal;
        } catch (e) {
          prevFound += folderTotal;
          errors.push(e instanceof Error ? e : new Error(String(e)));
        }
      }
      // ファイルはバッチでゴミ箱移動
      if (nonFolders.length > 0) {
        await driveApi.trashFiles(nonFolders.map((f) => f.driveId));
      }
      if (errors.length > 0) {
        updateToast(tid, {
          message: `${files.length - errors.length}/${files.length}件を削除しました（一部失敗）`,
          type: "error",
        });
      } else {
        updateToast(tid, {
          message: `${files.length}件を削除しました`,
          type: "success",
          percent: 100,
        });
      }
      await get().refresh();
    } catch (e) {
      updateToast(tid, {
        message: formatUserError("削除に失敗しました", e),
        type: "error",
      });
    }
  },

  downloadMultiple: async (files: KakusuFile[]) => {
    const vault = useVaultStore.getState();
    if (!vault.mekEnc) return;

    // Separate files and folders
    const directFiles = files.filter(
      (f) => f.type === "file" && (f.wrappedCek || f.isShared),
    );
    const folders = files.filter((f) => f.type === "folder");

    // Expand folders recursively to collect contained files with paths
    const allDecryptTasks: Array<{ file: KakusuFile; path: string }> = [];

    // Direct files go into root of ZIP
    for (const f of directFiles) {
      allDecryptTasks.push({ file: f, path: sanitizeFileName(f.name) });
    }

    // Expand all folders in parallel
    const folderExpansions = await Promise.all(
      folders.map(async (folder) => {
        const allSubFiles = await syncAllFiles(
          folder.driveId,
          vault.mekEnc!,
          vault.nameKey,
        );
        const filesById = new Map<string, KakusuFile>();
        filesById.set(folder.driveId, folder);
        for (const subFile of allSubFiles) {
          filesById.set(subFile.driveId, subFile);
        }
        const subFileItems = allSubFiles.filter(
          (f) => f.type === "file" && f.wrappedCek,
        );
        return subFileItems.map((sf) => ({
          file: sf,
          path: buildRelativePath(sf, folder.driveId, folder.name, filesById),
        }));
      }),
    );
    for (const tasks of folderExpansions) {
      allDecryptTasks.push(...tasks);
    }

    if (allDecryptTasks.length === 0) return;

    const abortController = new AbortController();
    const startedAt = Date.now();
    const tid = toast(
      `${allDecryptTasks.length}件をダウンロード中...`,
      "progress",
      0,
      () => {
        abortController.abort();
        updateToast(tid, {
          message: "ダウンロードを中止しました",
          type: "error",
          onCancel: undefined,
        });
      },
    );

    try {
      // Try streaming ZIP via File System Access API
      let zipWriter: ZipWriter;
      let isStreamingZip = false;
      if (typeof window.showSaveFilePicker === "function") {
        try {
          const saveHandle = await window.showSaveFilePicker({
            suggestedName: "download.zip",
            types: [
              { description: "ZIP", accept: { "application/zip": [".zip"] } },
            ],
          });
          const writable = await saveHandle.createWritable();
          const streamWriter = (
            writable as unknown as WritableStream<Uint8Array>
          ).getWriter();
          zipWriter = ZipWriter.forStream(streamWriter);
          isStreamingZip = true;
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") {
            updateToast(tid, {
              message: "ダウンロードをキャンセルしました",
              type: "error",
              onCancel: undefined,
            });
            return;
          }
          zipWriter = ZipWriter.forBlob();
        }
      } else {
        zipWriter = ZipWriter.forBlob();
      }

      let totalBytes = 0;
      let completedCount = 0;
      let zipWriterPromise = Promise.resolve();

      // Separate small and large files for optimal processing:
      // - Small files: download concurrently (pool), zip serially
      // - Large files: stream one at a time (no memory buffering)
      const smallTasks = allDecryptTasks.filter(
        (t) => !t.file.size || t.file.size <= LARGE_FILE_THRESHOLD_BYTES,
      );
      const largeTasks = allDecryptTasks.filter(
        (t) => t.file.size && t.file.size > LARGE_FILE_THRESHOLD_BYTES,
      );

      // ── Phase 1: Small files — concurrent download, serial zip ──
      if (smallTasks.length > 0) {
        const smallDownloadFns = smallTasks.map((task) => async () => {
          if (abortController.signal.aborted)
            throw new DOMException("Aborted", "AbortError");
          if (!task.file.wrappedCek) {
            throw new Error(`「${task.file.name}」の鍵情報が見つかりません`);
          }
          if (!vault.mekWrap) throw new Error("Vault is locked");

          const unwrapKey =
            task.file.keyVersion === "2" && vault.vaultKey
              ? vault.vaultKey
              : vault.mekWrap;
          const wrappedCekBytes = fromBase64(task.file.wrappedCek);
          const cek = await unwrapCEK(unwrapKey, wrappedCekBytes);
          const ciphertext = await driveApi.getFileContentWithProgress(
            task.file.driveId,
            () => {
              if (abortController.signal.aborted) return;
            },
            task.file.size,
          );
          totalBytes += ciphertext.byteLength;

          zipWriterPromise = zipWriterPromise.then(async () => {
            if (abortController.signal.aborted)
              throw new DOMException("Aborted", "AbortError");
            updateToast(tid, {
              message: `(${completedCount + 1}/${allDecryptTasks.length}) 「${task.file.name}」を処理中...`,
              phase: "decrypting",
            });
            await zipWriter.addEntryStreaming(
              task.path,
              decryptFileStreaming(cek, ciphertext),
            );
            completedCount++;
            updateToast(tid, {
              percent: Math.round(
                (completedCount / allDecryptTasks.length) * 90,
              ),
              speed: formatSpeed(totalBytes, startedAt),
              phase: "downloading",
            });
          });
          await zipWriterPromise;
        });

        const results = await pooledWithProgress(smallDownloadFns, 8);
        const failedTasks = results
          .map((r, i) => ({ r, task: smallTasks[i] }))
          .filter(({ r }) => r.status === "rejected");
        if (failedTasks.length > 0) {
          console.error(
            "Download failures:",
            failedTasks.map(({ r, task }) => ({
              path: task?.path,
              reason: r.status === "rejected" ? r.reason : undefined,
            })),
          );
          throw new AggregateError(
            failedTasks.map((f) => (f.r as PromiseRejectedResult).reason),
            `${failedTasks.length}件のダウンロードに失敗しました`,
          );
        }
      }

      // ── Phase 2: Large files — serial streaming (no memory buffering) ──
      for (const task of largeTasks) {
        if (abortController.signal.aborted)
          throw new DOMException("Aborted", "AbortError");
        if (!task.file.wrappedCek) {
          throw new Error(`「${task.file.name}」の鍵情報が見つかりません`);
        }
        if (!vault.mekWrap) throw new Error("Vault is locked");

        const unwrapKey =
          task.file.keyVersion === "2" && vault.vaultKey
            ? vault.vaultKey
            : vault.mekWrap;
        const wrappedCekBytes = fromBase64(task.file.wrappedCek);
        const cek = await unwrapCEK(unwrapKey, wrappedCekBytes);

        // Wait for any pending zip writes from Phase 1 to complete
        await zipWriterPromise;

        if (abortController.signal.aborted)
          throw new DOMException("Aborted", "AbortError");
        updateToast(tid, {
          message: `(${completedCount + 1}/${allDecryptTasks.length}) 「${task.file.name}」をストリーム処理中...`,
          phase: "downloading",
        });

        const { stream } = await driveApi.getFileContentAsStream(
          task.file.driveId,
        );
        await zipWriter.addEntryStreaming(
          task.path,
          decryptFileFromStream(cek, stream, task.file.size ?? 0),
        );
        completedCount++;
        updateToast(tid, {
          percent: Math.round((completedCount / allDecryptTasks.length) * 90),
          speed: formatSpeed(totalBytes, startedAt),
          phase: "downloading",
        });
      }

      await zipWriterPromise;
      updateToast(tid, { message: "ZIPファイルを作成中...", percent: 90 });
      const blob = await zipWriter.finish();

      if (!isStreamingZip && blob) {
        downloadBlob(blob, "download.zip");
      }
      updateToast(tid, {
        message: `${allDecryptTasks.length}件のダウンロード完了`,
        type: "success",
        percent: 100,
        onCancel: undefined,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      updateToast(tid, {
        message: formatUserError("ダウンロードに失敗しました", e),
        type: "error",
        onCancel: undefined,
      });
    }
  },

  restoreFile: async (file: KakusuFile) => {
    const tid = toast("復元中...", "progress");
    let restoredCount = 0;
    try {
      const restorePlan = buildRestorePlan(get().files, [file]);
      for (let index = 0; index < restorePlan.length; index++) {
        const target = restorePlan[index];
        if (!target) {
          continue;
        }
        await driveApi.untrashFile(target.driveId);
        restoredCount++;
        updateToast(tid, {
          percent: Math.round(((index + 1) / restorePlan.length) * 100),
        });
      }

      const restoredParentCount = restorePlan.length - 1;
      updateToast(tid, {
        message:
          restoredParentCount > 0
            ? `「${file.name}」を復元しました（親フォルダ${restoredParentCount}件を含む）`
            : `「${file.name}」を復元しました`,
        type: "success",
        percent: 100,
      });
      await get().refresh();
    } catch (e) {
      if (restoredCount > 0) {
        await get().refresh();
      }
      updateToast(tid, {
        message:
          restoredCount > 0
            ? formatUserError(
                `一部は復元されましたが、「${file.name}」の復元を完了できませんでした`,
                e,
              )
            : formatUserError("復元に失敗しました", e),
        type: "error",
      });
    }
  },

  restoreMultiple: async (files: KakusuFile[]) => {
    const tid = toast(`${files.length}件を復元中...`, "progress", 0);
    let restoredCount = 0;
    try {
      const restorePlan = buildRestorePlan(get().files, files);
      for (let index = 0; index < restorePlan.length; index++) {
        const target = restorePlan[index];
        if (!target) {
          continue;
        }
        await driveApi.untrashFile(target.driveId);
        restoredCount++;
        updateToast(tid, {
          percent: Math.round(((index + 1) / restorePlan.length) * 100),
        });
      }

      const selectedIds = new Set(files.map((file) => file.driveId));
      const restoredParentCount = restorePlan.filter(
        (file) => file.type === "folder" && !selectedIds.has(file.driveId),
      ).length;
      updateToast(tid, {
        message:
          restoredParentCount > 0
            ? `${files.length}件を復元しました（親フォルダ${restoredParentCount}件を含む）`
            : `${files.length}件を復元しました`,
        type: "success",
        percent: 100,
      });
      await get().refresh();
    } catch (e) {
      if (restoredCount > 0) {
        await get().refresh();
      }
      updateToast(tid, {
        message:
          restoredCount > 0
            ? formatUserError(
                `${restoredCount}件は復元されましたが、残りの復元に失敗しました`,
                e,
              )
            : formatUserError("復元に失敗しました", e),
        type: "error",
      });
    }
  },

  permanentDelete: async (file: KakusuFile) => {
    const tid = toast("完全に削除中...", "progress");
    try {
      if (file.type === "folder") {
        await deleteFolderBottomUp(file.driveId, (p) => {
          if (p.phase === "scan") {
            updateToast(tid, { message: `検出中... ${p.found}件` });
          } else {
            updateToast(tid, {
              message: `完全に削除中... (${p.deleted}/${p.found}件)`,
              percent: Math.round((p.deleted / Math.max(p.found, 1)) * 100),
            });
          }
        });
      } else {
        await driveApi.deleteFile(file.driveId);
      }
      updateToast(tid, {
        message: `「${file.name}」を完全に削除しました`,
        type: "success",
      });
      await get().refresh();
    } catch (e) {
      updateToast(tid, {
        message: formatUserError("完全な削除に失敗しました", e),
        type: "error",
      });
    }
  },

  permanentDeleteMultiple: async (files: KakusuFile[]) => {
    const tid = toast(`${files.length}件を完全に削除中...`, "progress", 0);
    try {
      const folders = files.filter((f) => f.type === "folder");
      const nonFolders = files.filter((f) => f.type !== "folder");
      const errors: Error[] = [];
      let prevFound = 0;
      let prevDeleted = 0;
      for (const folder of folders) {
        let folderTotal = 0;
        try {
          await deleteFolderBottomUp(folder.driveId, (p: DeleteProgress) => {
            folderTotal = p.found;
            if (p.phase === "scan") {
              updateToast(tid, {
                message: `検出中... ${prevFound + p.found}件`,
              });
            } else {
              const totalDeleted = prevDeleted + p.deleted;
              const totalFound = prevFound + p.found + nonFolders.length;
              updateToast(tid, {
                message: `完全に削除中... (${totalDeleted}/${totalFound}件)`,
                percent: Math.round(
                  (totalDeleted / Math.max(totalFound, 1)) * 100,
                ),
              });
            }
          });
          prevFound += folderTotal;
          prevDeleted += folderTotal;
        } catch (e) {
          prevFound += folderTotal;
          errors.push(e instanceof Error ? e : new Error(String(e)));
        }
      }
      if (nonFolders.length > 0) {
        await driveApi.deleteFiles(nonFolders.map((f) => f.driveId));
      }
      if (errors.length > 0) {
        updateToast(tid, {
          message: `${files.length - errors.length}/${files.length}件を完全に削除しました（一部失敗）`,
          type: "error",
        });
      } else {
        updateToast(tid, {
          message: `${files.length}件を完全に削除しました`,
          type: "success",
          percent: 100,
        });
      }
      await get().refresh();
    } catch (e) {
      updateToast(tid, {
        message: formatUserError("完全な削除に失敗しました", e),
        type: "error",
      });
    }
  },

  emptyTrash: async () => {
    const { files } = get();
    if (files.length === 0) return;
    const tid = toast(
      `ゴミ箱を空にしています (${files.length}件)...`,
      "progress",
      0,
    );
    try {
      const folders = files.filter((f) => f.type === "folder");
      const nonFolders = files.filter((f) => f.type !== "folder");
      const errors: Error[] = [];
      let prevFound = 0;
      let prevDeleted = 0;
      for (const folder of folders) {
        let folderTotal = 0;
        try {
          await deleteFolderBottomUp(folder.driveId, (p: DeleteProgress) => {
            folderTotal = p.found;
            if (p.phase === "scan") {
              updateToast(tid, {
                message: `ゴミ箱: 検出中... ${prevFound + p.found}件`,
              });
            } else {
              const totalDeleted = prevDeleted + p.deleted;
              const totalFound = prevFound + p.found + nonFolders.length;
              updateToast(tid, {
                message: `ゴミ箱を空にしています... (${totalDeleted}/${totalFound}件)`,
                percent: Math.round(
                  (totalDeleted / Math.max(totalFound, 1)) * 100,
                ),
              });
            }
          });
          prevFound += folderTotal;
          prevDeleted += folderTotal;
        } catch (e) {
          prevFound += folderTotal;
          errors.push(e instanceof Error ? e : new Error(String(e)));
        }
      }
      if (nonFolders.length > 0) {
        await driveApi.deleteFiles(nonFolders.map((f) => f.driveId));
      }
      if (errors.length > 0) {
        updateToast(tid, {
          message: "ゴミ箱の一部を空にできませんでした",
          type: "error",
        });
        await get().refresh();
      } else {
        updateToast(tid, {
          message: "ゴミ箱を空にしました",
          type: "success",
          percent: 100,
        });
        set({ files: [] });
      }
    } catch (e) {
      updateToast(tid, {
        message: formatUserError("ゴミ箱を空にできませんでした", e),
        type: "error",
      });
      await get().refresh();
    }
  },

  uploadFolder: async (
    entries: Array<{ file: File; relativePath: string }>,
    encryptName: boolean,
  ) => {
    const vault = useVaultStore.getState();
    if (!vault.mekEnc || !vault.mekWrap || !vault.dataFolderId) return;

    if (entries.length === 0) return;

    const parentId = get().currentFolderId || vault.dataFolderId;
    const abortController = new AbortController();
    const totalCount = entries.length;
    const startedAt = Date.now();
    const tid = toast(
      `フォルダをアップロード中 (${totalCount}件)...`,
      "progress",
      0,
      () => {
        abortController.abort();
        updateToast(tid, {
          message: "フォルダアップロードを中止しました",
          type: "error",
          onCancel: undefined,
        });
      },
    );

    try {
      // Collect all unique directory paths that need creating
      const dirPaths = new Set<string>();
      for (const entry of entries) {
        const parts = entry.relativePath.split("/");
        for (let i = 1; i < parts.length; i++) {
          dirPaths.add(parts.slice(0, i).join("/"));
        }
      }

      // Sort by depth so parents are created first
      const sortedDirs = Array.from(dirPaths).sort(
        (a, b) => a.split("/").length - b.split("/").length,
      );

      // Create folders on Drive, mapping path → DriveId
      const pathToId = new Map<string, string>();

      for (const dirPath of sortedDirs) {
        if (abortController.signal.aborted)
          throw new DOMException("Aborted", "AbortError");
        const parts = dirPath.split("/");
        const folderName = parts[parts.length - 1];
        if (!folderName) {
          throw new Error("フォルダ名が不正です");
        }
        const parentPath = parts.slice(0, -1).join("/");
        const parentDriveId = parentPath ? pathToId.get(parentPath) : parentId;
        if (!parentDriveId) {
          throw new Error("親フォルダが見つかりません");
        }

        const appProperties: Record<string, string> = {
          name_encrypted: String(encryptName),
        };
        if (vault.vaultKey) appProperties.key_version = "2";
        let driveName: string;
        if (encryptName) {
          const pasteEncKey = vault.nameKey ?? vault.mekEnc;
          if (!pasteEncKey) {
            throw new Error("暗号化鍵が初期化されていません");
          }
          const nameUpdate = await buildNameEncryptionUpdate(
            pasteEncKey,
            folderName,
            true,
            true,
            !!vault.vaultKey,
          );
          Object.assign(
            appProperties,
            nameUpdate.appProperties as Record<string, string>,
          );
          driveName = nameUpdate.driveName;
        } else {
          driveName = folderName;
        }

        const folder = await driveApi.createFileMultipart({
          name: driveName,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentDriveId],
          appProperties,
        });

        pathToId.set(dirPath, folder.id);
      }

      // Upload files with concurrency limit (reduce to 1 for large files)
      let completed = 0;
      let totalBytes = 0;
      const hasLargeFile = entries.some(
        (e) => computeEncryptedSize(e.file.size) > RESUMABLE_UPLOAD_THRESHOLD_BYTES,
      );
      const effectiveParallel = getEffectiveParallelCount(20);
      const uploadConcurrency = hasLargeFile
        ? 1
        : Math.max(
            UPLOAD_CONCURRENCY_DEFAULT,
            Math.max(4, Math.min(20, effectiveParallel * 2)),
          );

      const uploadOne = async (entry: { file: File; relativePath: string }) => {
        if (abortController.signal.aborted)
          throw new DOMException("Aborted", "AbortError");

        const parts = entry.relativePath.split("/");
        const dirPath = parts.slice(0, -1).join("/");
        const fileParentId = dirPath ? pathToId.get(dirPath) : parentId;
        if (!fileParentId) {
          throw new Error("アップロード先フォルダが見つかりません");
        }
        if (!vault.mekWrap) {
          throw new Error("復号鍵が初期化されていません");
        }
        if (!vault.mekEnc) {
          throw new Error("暗号化鍵が初期化されていません");
        }

        const wKey = vault.vaultKey ?? vault.mekWrap;
        const nKey = vault.nameKey ?? vault.mekEnc;
        const v2 = !!vault.vaultKey;

        const cek = await generateCEK();
        const wrappedCek = await wrapCEK(wKey, cek);

        const baseIV = generateBaseIV();
        const appProperties: Record<string, string> = {
          name_encrypted: String(encryptName),
          wrapped_cek: toBase64(wrappedCek),
          iv_body: toBase64(baseIV),
        };
        if (v2) appProperties.key_version = "2";

        let driveName: string;
        if (encryptName) {
          // Validate filename length for encrypted Drive names
          const estLen = estimateEncryptedDriveNameLength(entry.file.name);
          if (estLen > DRIVE_NAME_BLOCK_BYTES) {
            throw new Error(
              `「${entry.file.name}」のファイル名が長すぎます（暗号化後 ${estLen} バイト、上限 ${DRIVE_NAME_BLOCK_BYTES}）`,
            );
          }
          if (estLen > DRIVE_NAME_WARN_BYTES) {
            useUIStore.getState().addToast({
              message: `「${entry.file.name}」の暗号化ファイル名が長めです（${estLen} バイト）`,
              type: "error",
            });
          }

          const { encNameFull, ivMeta } = await encryptMetadata(
            nKey,
            entry.file.name,
          );
          writeSegmentedAppProperty(appProperties, "enc_name", encNameFull);
          appProperties.iv_meta = ivMeta;
          driveName = buildEncryptedDriveName(ivMeta, encNameFull);
        } else {
          driveName = `${entry.file.name}.enc`;
        }

        if (abortController.signal.aborted)
          throw new DOMException("Aborted", "AbortError");

        const wrappedCekBytes = new Uint8Array(wrappedCek);
        const encryptedSize = computeEncryptedSize(
          entry.file.size,
          DEFAULT_CHUNK_SIZE,
          wrappedCekBytes.byteLength,
        );
        appProperties.total_chunks = String(
          Math.max(1, Math.ceil(entry.file.size / DEFAULT_CHUNK_SIZE)),
        );
        const isLargeEntry = encryptedSize > RESUMABLE_UPLOAD_THRESHOLD_BYTES;

        if (isLargeEntry) {
          // Streaming encrypt + upload for large files in folder
          const uploadStartedAt = Date.now();
          updateToast(tid, {
            message: `(${completed + 1}/${totalCount}) 「${entry.file.name}」をアップロード中...`,
            percent: Math.round((completed / totalCount) * 100),
            speed: "",
            phase: "uploading",
          });
          await driveApi.createFileResumableFromStream(
            {
              name: driveName,
              parents: [fileParentId],
              mimeType: "application/octet-stream",
              appProperties,
            },
            encryptedSize,
            () =>
              encryptFileStreaming(
                cek,
                entry.file,
                baseIV,
                DEFAULT_CHUNK_SIZE,
                undefined,
                wrappedCekBytes,
              ),
            (loaded, total) => {
              if (abortController.signal.aborted) return;
              const filePct = total > 0 ? loaded / total : 0;
              const overallPct = Math.round(
                ((completed + filePct) / totalCount) * 100,
              );
              updateToast(tid, {
                message: `(${completed + 1}/${totalCount}) 「${entry.file.name}」をアップロード中...`,
                percent: overallPct,
                speed: formatSpeed(loaded, uploadStartedAt),
                phase: "uploading",
              });
            },
          );
        } else {
          // Small file: read into memory and multipart upload
          updateToast(tid, {
            message: `(${completed + 1}/${totalCount}) 「${entry.file.name}」をアップロード中...`,
            percent: Math.round((completed / totalCount) * 100),
            speed: "",
            phase: "uploading",
          });
          let plaintext = await entry.file.arrayBuffer();
          const { encrypted } = await encryptFile(
            cek,
            plaintext,
            DEFAULT_CHUNK_SIZE,
            undefined,
            wrappedCekBytes,
          );
          // GC hint — release plaintext buffer
          plaintext = undefined!;

          const uploadStartedAt = Date.now();
          updateToast(tid, {
            message: `(${completed + 1}/${totalCount}) 「${entry.file.name}」をアップロード中...`,
            percent: Math.round((completed / totalCount) * 100),
            speed: "",
            phase: "uploading",
          });
          await driveApi.createFileMultipart(
            {
              name: driveName,
              parents: [fileParentId],
              mimeType: "application/octet-stream",
              appProperties,
            },
            encrypted,
            (loaded, total) => {
              if (abortController.signal.aborted) return;
              const filePct = total > 0 ? loaded / total : 0;
              const overallPct = Math.round(
                ((completed + filePct) / totalCount) * 100,
              );
              updateToast(tid, {
                message: `(${completed + 1}/${totalCount}) 「${entry.file.name}」をアップロード中...`,
                percent: overallPct,
                speed: formatSpeed(loaded, uploadStartedAt),
                phase: "uploading",
              });
            },
          );
        }

        completed++;
        totalBytes += entry.file.size;
        updateToast(tid, {
          message: `(${completed}/${totalCount}) 「${entry.file.name}」完了`,
          percent: Math.round((completed / totalCount) * 100),
          speed: formatSpeed(totalBytes, startedAt),
        });
      };

      // Pool concurrent uploads
      const tasks = entries.map((entry) => () => uploadOne(entry));
      let idx = 0;
      let failedCount = 0;
      const next = async () => {
        while (idx < tasks.length) {
          const i = idx++;
          const task = tasks[i];
          if (!task) {
            continue;
          }
          try {
            await task();
          } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") throw e;
            failedCount++;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(uploadConcurrency, tasks.length) }, () =>
          next(),
        ),
      );

      if (failedCount > 0) {
        updateToast(tid, {
          message: `${completed}件成功、${failedCount}件失敗`,
          type: completed === 0 ? "error" : "success",
          percent: 100,
          onCancel: undefined,
        });
      } else {
        updateToast(tid, {
          message: `${totalCount}件のアップロード完了`,
          type: "success",
          percent: 100,
          onCancel: undefined,
        });
      }
      await get().refresh();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      updateToast(tid, {
        message: formatUserError("フォルダアップロードに失敗しました", e),
        type: "error",
        onCancel: undefined,
      });
      throw e;
    }
  },
};
});
