import Breadcrumb from "@/components/Breadcrumb";
import ConfirmDialog from "@/components/ConfirmDialog";
import ContextMenu from "@/components/ContextMenu";
import DropZone from "@/components/DropZone";
import type { FolderEntry } from "@/components/DropZone";
import FileList from "@/components/FileList";
import FilePreview from "@/components/FilePreview";
import PasswordChange from "@/components/PasswordChange";
import SettingsDialog from "@/components/SettingsDialog";
import ShareDialog from "@/components/ShareDialog";
import ToastContainer from "@/components/ToastContainer";
import { TEXT_INPUT_MAX_LENGTH, sanitizeTextInput } from "@/drive/validation";
import { useUpload } from "@/hooks/useUpload";
import { useAuthStore } from "@/stores/authStore";
import { useCacheSettingsStore } from "@/stores/cacheSettingsStore";
import { useFileStore } from "@/stores/fileStore";
import { useShareStore } from "@/stores/shareStore";
import { useUIStore } from "@/stores/uiStore";
import { useVaultStore } from "@/stores/vaultStore";
import type {
  BulkUploadBehavior,
  CacheMetadataMode,
  PreviewCacheMode,
} from "@/types";
import { buildZip } from "@/utils/zip";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

function AppIcon({
  title,
  className,
  children,
}: {
  title: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      focusable="false"
    >
      <title>{title}</title>
      {children}
    </svg>
  );
}

export default function VaultPage() {
  const { dataFolderId, shareFolderId, syncedSettings } = useVaultStore();
  const {
    files,
    loading,
    currentFolderId,
    refresh,
    browseMode,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    emptyTrash,
    uploadFolder,
  } = useFileStore();
  const {
    error,
    showSettings,
    showShareDialog,
    showPasswordChange,
    viewMode,
    setViewMode,
    openSettings,
    closeSettings,
    closePasswordChange,
    setError,
    userIconDisplay,
  } = useUIStore();
  const selectedIds = useUIStore((s) => s.selectedIds);
  const clearSelection = useUIStore((s) => s.clearSelection);
  const openBackgroundMenu = useUIStore((s) => s.openBackgroundMenu);
  const openContextMenu = useUIStore((s) => s.openContextMenu);
  const selectFile = useUIStore((s) => s.selectFile);
  const selectAll = useUIStore((s) => s.selectAll);
  const selectRange = useUIStore((s) => s.selectRange);
  const renamingFileId = useUIStore((s) => s.renamingFileId);
  const cancelRename = useUIStore((s) => s.cancelRename);
  const preview = useUIStore((s) => s.preview);
  const multiSelectMode = useUIStore((s) => s.multiSelectMode);
  const exitMultiSelectMode = useUIStore((s) => s.exitMultiSelectMode);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const lock = useVaultStore((s) => s.lock);
  const { handleUpload } = useUpload();
  const defaultEncryptName = useUIStore((s) => s.defaultEncryptName);
  const bulkUploadBehavior = useUIStore((s) => s.bulkUploadBehavior);
  const setBulkUploadBehavior = useUIStore((s) => s.setBulkUploadBehavior);
  const openConfirmDialog = useUIStore((s) => s.openConfirmDialog);
  const {
    shareLinks,
    loading: shareLoading,
    loadShareLinks,
    renameShareLink,
  } = useShareStore();

  const BULK_UPLOAD_THRESHOLD = 100;

  /**
   * ZIP化してからアップロード（トップレベルフォルダごとに個別ZIPを作成する）
   */
  const zipAndUpload = useCallback(
    async (entries: FolderEntry[], encryptName: boolean) => {
      const { addToast, updateToast } = useUIStore.getState();
      const tid = addToast({
        message: `${entries.length}件のファイルをZIPに圧縮中...`,
        type: "progress",
        percent: 0,
        startedAt: Date.now(),
      });
      try {
        // トップレベルフォルダでグルーピング
        const groups = new Map<string, FolderEntry[]>();
        for (const entry of entries) {
          const topDir = entry.relativePath.split("/")[0] || "archive";
          if (!groups.has(topDir)) groups.set(topDir, []);
          groups.get(topDir)?.push(entry);
        }

        const zipFiles: File[] = [];
        let processed = 0;
        for (const [folderName, groupEntries] of groups) {
          const zipEntries: Array<{ path: string; data: Uint8Array }> = [];
          for (const entry of groupEntries) {
            const buf = await entry.file.arrayBuffer();
            zipEntries.push({
              path: entry.relativePath,
              data: new Uint8Array(buf),
            });
            processed++;
            updateToast(tid, {
              message: `${entries.length}件のファイルをZIPに圧縮中... (${processed}/${entries.length})`,
              percent: Math.round((processed / entries.length) * 100),
            });
          }
          const blob = buildZip(zipEntries);
          zipFiles.push(
            new File([blob], `${folderName}.zip`, { type: "application/zip" }),
          );
        }

        updateToast(tid, {
          message:
            zipFiles.length > 1
              ? `ZIP作成完了 (${zipFiles.length}個)。アップロード開始...`
              : "ZIP作成完了。アップロード開始...",
          type: "success",
          percent: 100,
        });
        await handleUpload(zipFiles, encryptName);
      } catch (e) {
        updateToast(tid, {
          message: `ZIP作成に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
          type: "error",
        });
      }
    },
    [handleUpload],
  );

  /**
   * フォルダアップロードのラッパー。100件以上の場合は設定に応じてダイアログを表示する。
   */
  const handleFolderUpload = useCallback(
    (entries: FolderEntry[], encryptName: boolean) => {
      const behavior: BulkUploadBehavior =
        entries.length >= BULK_UPLOAD_THRESHOLD ? bulkUploadBehavior : "direct";

      if (behavior === "direct") {
        uploadFolder(entries, encryptName);
        return;
      }
      if (behavior === "zip") {
        void zipAndUpload(entries, encryptName);
        return;
      }

      // behavior === "ask"
      openConfirmDialog(
        `${entries.length}件のファイルが含まれています。\n\n100件以上のファイルをアップロードすると、大量のAPIリクエストが発生し、エラーが起きやすくなります。\nZIPファイルに圧縮してからアップロードすることを推奨します。`,
        () => {
          // noop — handled by onConfirmWithCheckbox
        },
        {
          confirmLabel: "そのままアップロード",
          secondaryLabel: "ZIPにしてアップロード",
          checkboxLabel: "今後表示しない",
          variant: "info",
          onConfirmWithCheckbox: (dontAsk: boolean) => {
            if (dontAsk) setBulkUploadBehavior("direct");
            uploadFolder(entries, encryptName);
          },
          onSecondaryWithCheckbox: (dontAsk: boolean) => {
            if (dontAsk) setBulkUploadBehavior("zip");
            void zipAndUpload(entries, encryptName);
          },
        },
      );
    },
    [
      bulkUploadBehavior,
      uploadFolder,
      zipAndUpload,
      openConfirmDialog,
      setBulkUploadBehavior,
    ],
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "size" | "date" | "type">(
    "name",
  );
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  // --- 共有ビュー専用の状態 ---
  const [shareEditName, setShareEditName] = useState("");
  const [shareSortBy, setShareSortBy] = useState<
    "name" | "count" | "date" | "status"
  >("date");
  const [shareSortOrder, setShareSortOrder] = useState<"asc" | "desc">("desc");
  const [avatarImageFailed, setAvatarImageFailed] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  // 共有リネームinputの初回マウント時だけフォーカス＆全選択する安定ref
  const shareRenameInputRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      setTimeout(() => {
        el.focus();
        el.setSelectionRange(0, el.value.length);
      }, 0);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Apply synced settings from DO_NOT_DELETE on first load
  useEffect(() => {
    if (!syncedSettings) return;
    const validMetaModes: CacheMetadataMode[] = [
      "off",
      "session",
      "24h",
      "7d",
      "unlimited",
    ];
    const validPreviewModes: PreviewCacheMode[] = ["off", "memory"];

    if (syncedSettings.encryptName !== undefined) {
      useUIStore.getState().setDefaultEncryptName(syncedSettings.encryptName);
    }
    if (syncedSettings.autoPopupLogin !== undefined) {
      useUIStore.getState().setAutoPopupLogin(syncedSettings.autoPopupLogin);
    }
    if (
      syncedSettings.metadataCacheMode &&
      validMetaModes.includes(
        syncedSettings.metadataCacheMode as CacheMetadataMode,
      )
    ) {
      useCacheSettingsStore
        .getState()
        .setMetadataCacheMode(
          syncedSettings.metadataCacheMode as CacheMetadataMode,
        );
    }
    if (
      syncedSettings.previewCacheMode &&
      validPreviewModes.includes(
        syncedSettings.previewCacheMode as PreviewCacheMode,
      )
    ) {
      useCacheSettingsStore
        .getState()
        .setPreviewCacheMode(
          syncedSettings.previewCacheMode as PreviewCacheMode,
        );
    }
  }, [syncedSettings]);

  // 共有モードに切り替えたときに共有リンク一覧を読み込む
  useEffect(() => {
    if (browseMode === "share" && shareFolderId) {
      loadShareLinks();
    }
  }, [browseMode, shareFolderId, loadShareLinks]);

  // 共有リンクのリネーム開始時に編集名を同期する
  const prevRenamingRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      browseMode === "share" &&
      renamingFileId &&
      renamingFileId !== prevRenamingRef.current
    ) {
      const link = shareLinks.find(
        (l) => l.summary.metaFileId === renamingFileId,
      );
      if (link) {
        setShareEditName(link.shareName);
      }
    }
    prevRenamingRef.current = renamingFileId;
  }, [browseMode, renamingFileId, shareLinks]);

  // フォルダ変更・モード切り替え時に複数選択モードを解除する
  useEffect(() => {
    if (multiSelectMode) exitMultiSelectMode();
    else clearSelection();
    cancelRename();
    setShareEditName("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderId, browseMode]);

  useEffect(() => {
    setAvatarImageFailed(false);
  }, [user?.picture]);

  // 背景コンテキストメニューからのアップロード要求を受け取る。
  useEffect(() => {
    const handler = (e: Event) => {
      const files = (e as CustomEvent).detail as FileList;
      if (files) handleUpload(files);
    };
    const folderHandler = (e: Event) => {
      const files = (e as CustomEvent).detail as FileList;
      if (!files || files.length === 0) return;
      const entries: FolderEntry[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const relativePath =
          (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
          file.name;
        entries.push({ file, relativePath });
      }
      if (entries.length > 0) {
        handleFolderUpload(entries, defaultEncryptName);
      }
    };
    window.addEventListener("kakusu:upload", handler);
    window.addEventListener("kakusu:folderupload", folderHandler);
    return () => {
      window.removeEventListener("kakusu:upload", handler);
      window.removeEventListener("kakusu:folderupload", folderHandler);
    };
  }, [handleUpload, handleFolderUpload, defaultEncryptName]);

  const filteredFiles = useMemo(() => {
    let currentFiles: typeof files;
    if (browseMode === "trash") {
      // ゴミ箱では親フォルダに関係なくすべて表示する。
      currentFiles = files;
    } else {
      const rootId = browseMode === "share" ? shareFolderId : dataFolderId;
      currentFiles = files.filter((f) => {
        if (!currentFolderId) return f.parentId === rootId;
        return f.parentId === currentFolderId;
      });
    }

    const searched = searchQuery
      ? currentFiles.filter((f) =>
          f.name.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : currentFiles;

    const getExt = (name: string) => {
      const dot = name.lastIndexOf(".");
      return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    };

    return [...searched].sort((a, b) => {
      // フォルダを常に先頭に並べる。
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      let cmp = 0;
      switch (sortBy) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "size":
          cmp = (a.size ?? 0) - (b.size ?? 0);
          break;
        case "date":
          cmp =
            new Date(a.modifiedTime).getTime() -
            new Date(b.modifiedTime).getTime();
          break;
        case "type":
          cmp = getExt(a.name).localeCompare(getExt(b.name));
          if (cmp === 0) cmp = a.name.localeCompare(b.name);
          break;
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
  }, [
    files,
    currentFolderId,
    dataFolderId,
    shareFolderId,
    browseMode,
    searchQuery,
    sortBy,
    sortOrder,
  ]);

  // --- 共有リンクの検索・ソート ---
  const filteredShareLinks = useMemo(() => {
    const searched = searchQuery
      ? shareLinks.filter((l) =>
          l.shareName.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : shareLinks;

    return [...searched].sort((a, b) => {
      let cmp = 0;
      switch (shareSortBy) {
        case "name":
          cmp = a.shareName.localeCompare(b.shareName);
          break;
        case "count":
          cmp = a.summary.itemCount - b.summary.itemCount;
          break;
        case "date":
          cmp =
            new Date(a.summary.createdTime || 0).getTime() -
            new Date(b.summary.createdTime || 0).getTime();
          break;
        case "status":
          cmp = a.summary.status.localeCompare(b.summary.status);
          break;
      }
      return shareSortOrder === "asc" ? cmp : -cmp;
    });
  }, [shareLinks, searchQuery, shareSortBy, shareSortOrder]);

  // キーボードショートカット
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 入力中はショートカットを横取りしない。
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      // 戻る / 進む
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
        return;
      }
      if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        goForward();
        return;
      }
      // 入力中でなければ Backspace でも戻れるようにする。
      if (e.key === "Backspace") {
        e.preventDefault();
        goBack();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        const { browseMode: bm, currentFolderId: cfId } =
          useFileStore.getState();
        if (bm === "share" && !cfId) {
          const ids = filteredShareLinks.map((l) => l.summary.metaFileId);
          useUIStore.getState().selectAll(ids);
        } else {
          const ids = filteredFiles.map((f) => f.driveId);
          useUIStore.getState().selectAll(ids);
        }
      }
      // コピー（共有リンク一覧では無効）
      if ((e.ctrlKey || e.metaKey) && e.key === "c" && selectedIds.size > 0) {
        const { browseMode: bm, currentFolderId: cfId } =
          useFileStore.getState();
        if (bm === "share" && !cfId) return;
        e.preventDefault();
        const targets = files.filter((f) => selectedIds.has(f.driveId));
        if (targets.length > 0) {
          useUIStore.getState().setClipboard({
            action: "copy",
            files: targets,
            sourceFolderId: useFileStore.getState().currentFolderId,
          });
          useUIStore.getState().addToast({
            message: `${targets.length}件をコピーしました`,
            type: "success",
          });
        }
      }
      // 切り取り（data モードのみ）
      if ((e.ctrlKey || e.metaKey) && e.key === "x" && selectedIds.size > 0) {
        e.preventDefault();
        if (useFileStore.getState().browseMode === "data") {
          const targets = files.filter((f) => selectedIds.has(f.driveId));
          if (targets.length > 0) {
            useUIStore.getState().setClipboard({
              action: "cut",
              files: targets,
              sourceFolderId: useFileStore.getState().currentFolderId,
            });
            useUIStore.getState().addToast({
              message: `${targets.length}件を切り取りました`,
              type: "success",
            });
          }
        }
      }
      // 貼り付け（data モードのみ）
      if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        e.preventDefault();
        const clip = useUIStore.getState().clipboard;
        const fs = useFileStore.getState();
        if (clip && fs.browseMode === "data") {
          const destId =
            fs.currentFolderId || useVaultStore.getState().dataFolderId;
          if (destId) {
            void fs.pasteFiles(clip, destId);
            if (clip.action === "cut") {
              useUIStore.getState().setClipboard(null);
            }
          }
        }
      }
      if (e.key === "Escape") {
        clearSelection();
      }
      if (e.key === "Delete" && selectedIds.size > 0) {
        const { browseMode: bm, currentFolderId: cfId } =
          useFileStore.getState();
        // 共有リンク一覧の場合は共有リンクを削除する
        if (bm === "share" && !cfId) {
          handleShareDeleteSelected(() => clearSelection());
          return;
        }
        const selectedFiles = files.filter((f) => selectedIds.has(f.driveId));
        if (selectedFiles.length > 0) {
          const isTrash = useFileStore.getState().browseMode === "trash";
          if (isTrash) {
            useUIStore
              .getState()
              .openConfirmDialog(
                `${selectedFiles.length}件を完全に削除しますか？この操作は取り消せません。`,
                () => {
                  useFileStore
                    .getState()
                    .permanentDeleteMultiple(selectedFiles);
                  clearSelection();
                },
              );
          } else {
            useUIStore
              .getState()
              .openConfirmDialog(
                `${selectedFiles.length}件のアイテムをゴミ箱に移動しますか？`,
                () => {
                  useFileStore.getState().removeMultiple(selectedFiles);
                  clearSelection();
                },
              );
          }
        }
      }
      if (
        e.key === "F2" &&
        selectedIds.size === 1 &&
        useFileStore.getState().browseMode !== "trash"
      ) {
        const [id] = Array.from(selectedIds);
        if (id) {
          useUIStore.getState().startRename(id);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedIds,
    files,
    filteredFiles,
    filteredShareLinks,
    clearSelection,
    goBack,
    goForward,
  ]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleUpload(e.target.files);
      e.target.value = "";
    }
  };

  const handleFolderInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const entries: FolderEntry[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const relativePath =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
        file.name;
      entries.push({ file, relativePath });
    }
    if (entries.length > 0) {
      handleFolderUpload(entries, defaultEncryptName);
    }
    e.target.value = "";
  };

  const handleNewFolder = () => {
    const tempId = useFileStore.getState().addPendingFolder();
    useUIStore.getState().startRename(tempId);
  };

  const handleLock = () => {
    setAccountMenuOpen(false);
    lock();
  };
  const handleLogout = () => {
    setAccountMenuOpen(false);
    lock();
    logout();
  };

  const handleSort = (field: "name" | "size" | "date" | "type") => {
    if (field === sortBy) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortOrder("asc");
    }
  };

  // マウスの戻る / 進むボタン
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        goBack();
      }
      if (e.button === 4) {
        e.preventDefault();
        goForward();
      }
    };
    window.addEventListener("mouseup", handler);
    return () => window.removeEventListener("mouseup", handler);
  }, [goBack, goForward]);

  // マウスボタン押下中に body[data-mousedown] を設定して
  // ファイルアイテムのホバーを CSS で抑制する。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.button === 0) document.body.setAttribute("data-mousedown", "");
    };
    const onUp = () => {
      document.body.removeAttribute("data-mousedown");
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      document.body.removeAttribute("data-mousedown");
    };
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (
        accountMenuRef.current &&
        !accountMenuRef.current.contains(event.target as Node)
      ) {
        setAccountMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAccountMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen]);

  const handleBackgroundContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      openBackgroundMenu(e.clientX, e.clientY);
    },
    [openBackgroundMenu],
  );

  // ── 矩形ドラッグ選択 ──
  const [dragSelect, setDragSelect] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const dragSelectRef = useRef(dragSelect);
  dragSelectRef.current = dragSelect;

  const handleBackgroundMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // ファイルアイテム、ヘッダー、ボタン等を除外
      if (
        (e.target as HTMLElement).closest("[data-file-item]") ||
        (e.target as HTMLElement).closest("header") ||
        (e.target as HTMLElement).closest("button") ||
        (e.target as HTMLElement).closest("input") ||
        e.button !== 0
      )
        return;
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
        clearSelection();
      }
      setDragSelect({
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
      });
      useUIStore.getState().setDragSelecting(true);
    },
    [clearSelection],
  );

  const isDragSelecting = dragSelect !== null;
  useEffect(() => {
    if (!isDragSelecting) return;

    const DRAG_THRESHOLD = 5;

    const onMouseMove = (e: MouseEvent) => {
      setDragSelect((prev) =>
        prev ? { ...prev, currentX: e.clientX, currentY: e.clientY } : null,
      );

      const ds = dragSelectRef.current;
      if (!ds) return;
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD)
        return;

      // 矩形を計算
      const left = Math.min(ds.startX, e.clientX);
      const top = Math.min(ds.startY, e.clientY);
      const right = Math.max(ds.startX, e.clientX);
      const bottom = Math.max(ds.startY, e.clientY);

      // 矩形と交差するファイルアイテムを検出
      const items = document.querySelectorAll<HTMLElement>("[data-file-id]");
      const ids = new Set<string>();
      for (const el of items) {
        const rect = el.getBoundingClientRect();
        if (
          rect.right >= left &&
          rect.left <= right &&
          rect.bottom >= top &&
          rect.top <= bottom
        ) {
          const fid = el.getAttribute("data-file-id");
          if (fid) ids.add(fid);
        }
      }
      useUIStore.getState().setSelectedIds(ids);
    };

    const onMouseUp = () => {
      useUIStore.getState().setDragSelecting(false);
      setDragSelect(null);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragSelecting]);

  // --- 共有ビューのハンドラ ---
  const shareRenameLockRef = useRef(false);
  const handleShareSaveEdit = useCallback(
    async (metaFileId: string, currentName: string) => {
      if (shareRenameLockRef.current) return;
      shareRenameLockRef.current = true;
      try {
        const trimmed = sanitizeTextInput(shareEditName);
        if (!trimmed || trimmed === currentName) {
          cancelRename();
          setShareEditName("");
          return;
        }
        if (trimmed.length > TEXT_INPUT_MAX_LENGTH) {
          useUIStore.getState().addToast({
            message: "共有名が長すぎます（200文字以内）",
            type: "error",
          });
          cancelRename();
          setShareEditName("");
          return;
        }
        const tid = useUIStore
          .getState()
          .addToast({ message: "共有名を更新中...", type: "progress" });
        try {
          await renameShareLink(metaFileId, trimmed);
          useUIStore.getState().updateToast(tid, {
            message: "共有名を更新しました",
            type: "success",
          });
        } catch {
          useUIStore.getState().updateToast(tid, {
            message: "共有名の更新に失敗しました",
            type: "error",
          });
        }
        cancelRename();
        setShareEditName("");
      } finally {
        shareRenameLockRef.current = false;
      }
    },
    [shareEditName, renameShareLink, cancelRename],
  );

  const handleShareSelect = useCallback(
    (metaFileId: string, e: React.MouseEvent) => {
      if (e.shiftKey) {
        const { lastSelectedId } = useUIStore.getState();
        if (lastSelectedId) {
          const startIdx = filteredShareLinks.findIndex(
            (l) => l.summary.metaFileId === lastSelectedId,
          );
          const endIdx = filteredShareLinks.findIndex(
            (l) => l.summary.metaFileId === metaFileId,
          );
          if (startIdx >= 0 && endIdx >= 0) {
            const [from, to] = [
              Math.min(startIdx, endIdx),
              Math.max(startIdx, endIdx),
            ];
            const rangeIds = filteredShareLinks
              .slice(from, to + 1)
              .map((l) => l.summary.metaFileId);
            selectRange(rangeIds, e.ctrlKey || e.metaKey);
            return;
          }
        }
      }
      selectFile(metaFileId, e.ctrlKey || e.metaKey);
    },
    [filteredShareLinks, selectFile, selectRange],
  );

  const handleShareSelectAll = useCallback(() => {
    const allIds = filteredShareLinks.map((l) => l.summary.metaFileId);
    const allSelected =
      filteredShareLinks.length > 0 &&
      filteredShareLinks.every((l) => selectedIds.has(l.summary.metaFileId));
    if (allSelected) {
      clearSelection();
    } else {
      selectAll(allIds);
    }
  }, [filteredShareLinks, selectedIds, selectAll, clearSelection]);

  const handleShareContextMenu = useCallback(
    (e: React.MouseEvent, link: (typeof shareLinks)[0]) => {
      e.preventDefault();
      e.stopPropagation();
      const metaFileId = link.summary.metaFileId;
      if (!selectedIds.has(metaFileId)) {
        selectFile(metaFileId, false);
      }
      // KakusuFile 互換オブジェクトを作り Context Menu へ渡す
      openContextMenu(e.clientX, e.clientY, {
        driveId: metaFileId,
        name: link.shareName,
        nameEncrypted: false,
        type: "file",
        parentId: "",
        modifiedTime: link.summary.createdTime || new Date().toISOString(),
      });
    },
    [selectedIds, selectFile, openContextMenu],
  );

  const handleShareDeleteSelected = useCallback(
    (onComplete?: () => void) => {
      const { shareLinks: links, removeShareLinks } = useShareStore.getState();
      const { openConfirmDialog, addToast, updateToast } =
        useUIStore.getState();
      const targets = links.filter((l) =>
        selectedIds.has(l.summary.metaFileId),
      );
      if (targets.length === 0) return;
      const metaIds = targets.map((t) => t.summary.metaFileId);
      const label =
        targets.length === 1
          ? `「${targets[0]?.shareName}」`
          : `${targets.length}件の共有リンク`;
      const message = `${label}の共有を無効化してから削除しますか？\nGoogle Drive側のファイル共有を無効化してから削除すると時間がかかる場合があります。`;
      const doDelete = (revoke: boolean) => {
        const currentLinks = useShareStore.getState().shareLinks;
        const validIds = metaIds.filter((id) =>
          currentLinks.some((l) => l.summary.metaFileId === id),
        );
        if (validIds.length === 0) {
          addToast({
            message: "対象の共有リンクが見つかりません",
            type: "error",
          });
          return;
        }
        if (revoke) {
          const tid = addToast({
            message: `${label}を削除中（権限を無効化しています...）`,
            type: "progress",
            percent: 0,
          });
          removeShareLinks(validIds, true, (done, total) => {
            updateToast(tid, {
              message: `権限を無効化中... (${done}/${total})`,
              percent: total > 0 ? Math.round((done / total) * 90) : 0,
            });
          })
            .then(() => {
              updateToast(tid, {
                message: `${label}を削除しました（権限も無効化済み）`,
                type: "success",
                percent: 100,
              });
            })
            .catch(() => {
              updateToast(tid, {
                message: `${label}の削除に失敗しました`,
                type: "error",
              });
            });
        } else {
          const tid = addToast({
            message: `${label}を削除中...`,
            type: "progress",
          });
          removeShareLinks(validIds, false)
            .then(() => {
              updateToast(tid, {
                message: `${label}を削除しました`,
                type: "success",
              });
            })
            .catch(() => {
              updateToast(tid, {
                message: `${label}の削除に失敗しました`,
                type: "error",
              });
            });
        }
        onComplete?.();
      };
      openConfirmDialog(message, () => doDelete(true), {
        confirmLabel: "削除",
        secondaryLabel: "無効化せずに削除",
        onSecondary: () => doDelete(false),
      });
    },
    [selectedIds],
  );

  const handleShareSort = useCallback(
    (col: "name" | "count" | "date" | "status") => {
      setShareSortBy((prev) => {
        if (prev === col) {
          setShareSortOrder((o) => (o === "asc" ? "desc" : "asc"));
          return prev;
        }
        setShareSortOrder(col === "date" ? "desc" : "asc");
        return col;
      });
    },
    [],
  );

  const accountLabel = user?.name || user?.email || "Google アカウント";
  const accountSecondaryLabel =
    user?.email && user?.name ? user.email : "アカウントメニュー";
  const accountInitials =
    (user?.name || user?.email || "G")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "G";

  return (
    <div
      className="flex min-h-screen flex-col bg-gray-50 dark:bg-gray-900"
      data-vault-page
      onMouseDown={handleBackgroundMouseDown}
    >
      {/* ヘッダー */}
      <header className="border-b bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <img
              src="/white.png"
              alt=""
              aria-hidden="true"
              className="h-8 w-8 object-contain"
            />
            <span className="text-lg font-bold tracking-wide text-gray-900 dark:text-gray-100">
              KaKuSu
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openSettings}
              className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
              title="設定"
            >
              <AppIcon title="設定" className="h-5 w-5">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </AppIcon>
            </button>
            <div ref={accountMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setAccountMenuOpen((current) => !current)}
                className="flex items-center gap-3 rounded-full px-1.5 py-1 text-gray-600 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                title={accountLabel}
                aria-haspopup="menu"
                aria-expanded={accountMenuOpen}
              >
                {userIconDisplay !== "none" && (
                  <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-sky-500 to-blue-700 text-sm font-semibold text-white">
                    {user?.picture && !avatarImageFailed ? (
                      <img
                        src={user.picture}
                        alt={accountLabel}
                        className="h-full w-full object-cover"
                        referrerPolicy="no-referrer"
                        onError={() => setAvatarImageFailed(true)}
                      />
                    ) : (
                      <span>{accountInitials}</span>
                    )}
                  </div>
                )}
                {userIconDisplay === "none" && (
                  <AppIcon
                    title="アカウント"
                    className="h-6 w-6 text-gray-500 dark:text-gray-400"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                    />
                  </AppIcon>
                )}
                {(userIconDisplay === "name-icon" ||
                  userIconDisplay === "name-email-icon") && (
                  <div className="hidden min-w-0 text-left md:block">
                    <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                      {accountLabel}
                    </p>
                    {userIconDisplay === "name-email-icon" && (
                      <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                        {accountSecondaryLabel}
                      </p>
                    )}
                  </div>
                )}
                {(userIconDisplay === "name-icon" ||
                  userIconDisplay === "name-email-icon") && (
                  <AppIcon
                    title="アカウントメニュー"
                    className="hidden h-4 w-4 text-gray-400 md:block dark:text-gray-500"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </AppIcon>
                )}
              </button>

              {accountMenuOpen && (
                <div
                  className="absolute right-0 top-12 z-20 w-64 overflow-hidden rounded-xl border border-gray-200 bg-white py-2 shadow-xl dark:border-gray-700 dark:bg-gray-800"
                  role="menu"
                >
                  <div className="border-b border-gray-100 px-4 pb-3 pt-2 dark:border-gray-700">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-sky-500 to-blue-700 text-sm font-semibold text-white">
                        {user?.picture && !avatarImageFailed ? (
                          <img
                            src={user.picture}
                            alt={accountLabel}
                            className="h-full w-full object-cover"
                            referrerPolicy="no-referrer"
                            onError={() => setAvatarImageFailed(true)}
                          />
                        ) : (
                          <span>{accountInitials}</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                          {accountLabel}
                        </p>
                        <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                          {user?.email || "現在のログイン情報"}
                        </p>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleLock}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-gray-700 transition hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
                    role="menuitem"
                  >
                    <AppIcon
                      title="ロック"
                      className="h-4 w-4 text-gray-400 dark:text-gray-500"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                      />
                    </AppIcon>
                    ロック
                  </button>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-red-700 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                    role="menuitem"
                  >
                    <AppIcon title="ログアウト" className="h-4 w-4">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h6a2 2 0 012 2v1"
                      />
                    </AppIcon>
                    ログアウト
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* エラー表示 */}
      {error && (
        <div className="mx-auto w-full max-w-7xl px-4 pt-3">
          <div className="flex items-center justify-between rounded-lg bg-red-50 px-4 py-2 dark:bg-red-900/20">
            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* ツールバー */}
      <div className="mx-auto w-full max-w-7xl px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-1 sm:gap-2">
            <button
              type="button"
              onClick={goBack}
              disabled={!canGoBack}
              className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent dark:text-gray-400 dark:hover:bg-gray-700"
              title="戻る (Alt+←)"
            >
              <AppIcon title="戻る" className="h-4 w-4">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </AppIcon>
            </button>
            <button
              type="button"
              onClick={goForward}
              disabled={!canGoForward}
              className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent dark:text-gray-400 dark:hover:bg-gray-700"
              title="進む (Alt+→)"
            >
              <AppIcon title="進む" className="h-4 w-4">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </AppIcon>
            </button>
            <Breadcrumb />
          </div>
          <div className="hidden min-h-11 gap-2 sm:flex sm:w-auto sm:flex-wrap lg:justify-end">
            {browseMode === "data" && (
              <>
                <label
                  className="flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 sm:w-auto sm:px-4"
                  aria-label="アップロード"
                >
                  <AppIcon title="アップロード" className="h-4 w-4">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                    />
                  </AppIcon>
                  <span>アップロード</span>
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleFileInput}
                  />
                </label>
                <label
                  className="flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 sm:w-auto sm:px-4 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                  aria-label="フォルダをアップロード"
                >
                  <AppIcon title="フォルダをアップロード" className="h-4 w-4">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                    />
                  </AppIcon>
                  <span>フォルダ</span>
                  <input
                    type="file"
                    className="hidden"
                    onChange={handleFolderInput}
                    {...({
                      webkitdirectory: "",
                    } as React.InputHTMLAttributes<HTMLInputElement>)}
                  />
                </label>
                <button
                  type="button"
                  onClick={handleNewFolder}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 sm:w-auto sm:px-4 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                  aria-label="新しいフォルダ"
                >
                  <AppIcon title="新しいフォルダ" className="h-4 w-4">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
                    />
                  </AppIcon>
                  <span>新しいフォルダ</span>
                </button>
              </>
            )}
            {browseMode === "trash" && files.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  useUIStore
                    .getState()
                    .openConfirmDialog(
                      `ゴミ箱内の${files.length}件をすべて完全に削除しますか？この操作は取り消せません。`,
                      () => {
                        emptyTrash();
                      },
                    );
                }}
                className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm text-white shadow-sm transition hover:bg-red-700"
              >
                <AppIcon title="ゴミ箱を空にする" className="h-4 w-4">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </AppIcon>
                ゴミ箱を空にする
              </button>
            )}
            {browseMode === "share" && selectedIds.size > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {selectedIds.size}件選択中
                </span>
                <button
                  type="button"
                  onClick={() =>
                    handleShareDeleteSelected(() => clearSelection())
                  }
                  className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
                >
                  <AppIcon title="削除" className="h-4 w-4">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </AppIcon>
                  削除
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 検索バー */}
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="relative min-w-0">
            <AppIcon
              title="検索"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </AppIcon>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                browseMode === "share"
                  ? "共有リンクを検索..."
                  : "ファイルを検索..."
              }
              maxLength={TEXT_INPUT_MAX_LENGTH}
              className="h-11 w-full rounded-xl border border-gray-300 py-2 pl-10 pr-3 text-sm text-gray-700 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:placeholder-gray-500"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:text-gray-600"
              >
                <AppIcon title="検索文字をクリア" className="h-4 w-4">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </AppIcon>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {browseMode === "share" ? (
              <>
                <select
                  value={shareSortBy}
                  onChange={(e) =>
                    setShareSortBy(
                      e.target.value as "name" | "count" | "date" | "status",
                    )
                  }
                  className="h-11 min-w-0 flex-1 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:min-w-[10rem] sm:flex-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
                >
                  <option value="name">共有名</option>
                  <option value="count">件数</option>
                  <option value="date">作成日</option>
                  <option value="status">状態</option>
                </select>
                <button
                  type="button"
                  onClick={() =>
                    setShareSortOrder((prev) =>
                      prev === "asc" ? "desc" : "asc",
                    )
                  }
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-gray-300 bg-white p-2 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
                  title={shareSortOrder === "asc" ? "昇順" : "降順"}
                  aria-label={shareSortOrder === "asc" ? "昇順" : "降順"}
                >
                  {shareSortOrder === "asc" ? (
                    <AppIcon title="昇順" className="h-5 w-5">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 5v14m0-14l-4 4m4-4l4 4"
                      />
                    </AppIcon>
                  ) : (
                    <AppIcon title="降順" className="h-5 w-5">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 19V5m0 14l-4-4m4 4l4-4"
                      />
                    </AppIcon>
                  )}
                </button>
              </>
            ) : (
              <>
                <select
                  value={sortBy}
                  onChange={(e) =>
                    setSortBy(
                      e.target.value as "name" | "size" | "date" | "type",
                    )
                  }
                  className="h-11 min-w-0 flex-1 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:min-w-[10rem] sm:flex-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
                >
                  <option value="name">名前</option>
                  <option value="type">形式</option>
                  <option value="size">サイズ</option>
                  <option value="date">更新日</option>
                </select>
                <button
                  type="button"
                  onClick={() =>
                    setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"))
                  }
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-gray-300 bg-white p-2 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
                  title={sortOrder === "asc" ? "昇順" : "降順"}
                  aria-label={sortOrder === "asc" ? "昇順" : "降順"}
                >
                  {sortOrder === "asc" ? (
                    <AppIcon title="昇順" className="h-5 w-5">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 5v14m0-14l-4 4m4-4l4 4"
                      />
                    </AppIcon>
                  ) : (
                    <AppIcon title="降順" className="h-5 w-5">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 19V5m0 14l-4-4m4 4l4-4"
                      />
                    </AppIcon>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setViewMode(viewMode === "list" ? "grid" : "list")
                  }
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-gray-300 bg-white p-2 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
                  title={viewMode === "list" ? "グリッド表示" : "リスト表示"}
                >
                  {viewMode === "list" ? (
                    <AppIcon title="グリッド表示" className="h-5 w-5">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
                      />
                    </AppIcon>
                  ) : (
                    <AppIcon title="リスト表示" className="h-5 w-5">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 6h16M4 10h16M4 14h16M4 18h16"
                      />
                    </AppIcon>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ファイル一覧 / ドロップ領域 */}
      <main
        className="mx-auto w-full max-w-7xl flex-1 px-4 pb-6"
        onContextMenu={handleBackgroundContextMenu}
      >
        {browseMode === "share" ? (
          /* 共有リンク一覧 */
          shareLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            </div>
          ) : shareLinks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400">
              <AppIcon title="共有なし" className="mb-3 h-12 w-12">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                />
              </AppIcon>
              <p className="text-sm">共有リンクはありません</p>
            </div>
          ) : filteredShareLinks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400">
              <p className="text-sm">検索結果はありません</p>
            </div>
          ) : (
            <>
              <div
                className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
                data-file-list
              >
                <table className="w-full">
                  <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                    <tr>
                      <th className="w-10 px-3 py-3">
                        <button
                          type="button"
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition ${
                            filteredShareLinks.length > 0 &&
                            filteredShareLinks.every((l) =>
                              selectedIds.has(l.summary.metaFileId),
                            )
                              ? "border-blue-500 bg-blue-500 text-white"
                              : "border-gray-300 bg-white text-transparent hover:border-gray-500 dark:border-gray-600 dark:bg-gray-800"
                          }`}
                          onClick={handleShareSelectAll}
                          aria-label={
                            filteredShareLinks.length > 0 &&
                            filteredShareLinks.every((l) =>
                              selectedIds.has(l.summary.metaFileId),
                            )
                              ? "すべての選択を解除"
                              : "すべて選択"
                          }
                        >
                          <span
                            aria-hidden="true"
                            className="text-[10px] leading-none"
                          >
                            ✓
                          </span>
                        </button>
                      </th>
                      <th
                        className="cursor-pointer px-4 py-3 select-none hover:text-gray-700 dark:hover:text-gray-300"
                        onClick={() => handleShareSort("name")}
                      >
                        共有名{" "}
                        {shareSortBy === "name" &&
                          (shareSortOrder === "asc" ? "↑" : "↓")}
                      </th>
                      <th
                        className="hidden cursor-pointer px-4 py-3 select-none hover:text-gray-700 dark:hover:text-gray-300 sm:table-cell"
                        onClick={() => handleShareSort("count")}
                      >
                        件数{" "}
                        {shareSortBy === "count" &&
                          (shareSortOrder === "asc" ? "↑" : "↓")}
                      </th>
                      <th
                        className="hidden cursor-pointer px-4 py-3 select-none hover:text-gray-700 dark:hover:text-gray-300 sm:table-cell"
                        onClick={() => handleShareSort("date")}
                      >
                        作成日{" "}
                        {shareSortBy === "date" &&
                          (shareSortOrder === "asc" ? "↑" : "↓")}
                      </th>
                      <th
                        className="cursor-pointer px-4 py-3 select-none hover:text-gray-700 dark:hover:text-gray-300"
                        onClick={() => handleShareSort("status")}
                      >
                        状態{" "}
                        {shareSortBy === "status" &&
                          (shareSortOrder === "asc" ? "↑" : "↓")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {filteredShareLinks.map((link) => {
                      const d = link.summary.createdTime
                        ? new Date(link.summary.createdTime)
                        : null;
                      const dateStr = d
                        ? d.toLocaleString("ja-JP", {
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "—";
                      const isSelected = selectedIds.has(
                        link.summary.metaFileId,
                      );
                      const isRenaming =
                        renamingFileId === link.summary.metaFileId;
                      return (
                        <tr
                          key={link.summary.metaFileId}
                          className={`group cursor-pointer select-none transition ${isSelected ? "bg-[#cce8ff] dark:bg-blue-900/30" : "hover:bg-[#f5f9ff] dark:hover:bg-gray-700/50"}`}
                          onClick={(e) => {
                            if (isRenaming) return;
                            handleShareSelect(link.summary.metaFileId, e);
                          }}
                          onContextMenu={(e) => handleShareContextMenu(e, link)}
                        >
                          <td className="w-10 px-3 py-3">
                            <button
                              type="button"
                              aria-label={isSelected ? "選択を解除" : "選択"}
                              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition ${
                                isSelected
                                  ? "border-blue-500 bg-blue-500 text-white"
                                  : "border-gray-300 bg-white text-transparent opacity-0 group-hover:opacity-100 dark:border-gray-600 dark:bg-gray-800"
                              }`}
                              onClick={(e) => {
                                e.stopPropagation();
                                selectFile(link.summary.metaFileId, true);
                              }}
                            >
                              <span
                                aria-hidden="true"
                                className="text-[10px] leading-none"
                              >
                                ✓
                              </span>
                            </button>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="min-w-0 flex-1">
                                {isRenaming ? (
                                  <form
                                    onSubmit={(e) => {
                                      e.preventDefault();
                                      void handleShareSaveEdit(
                                        link.summary.metaFileId,
                                        link.shareName,
                                      );
                                    }}
                                    className="flex items-center gap-1"
                                  >
                                    <input
                                      type="text"
                                      value={shareEditName}
                                      onChange={(e) =>
                                        setShareEditName(e.target.value)
                                      }
                                      onBlur={() =>
                                        void handleShareSaveEdit(
                                          link.summary.metaFileId,
                                          link.shareName,
                                        )
                                      }
                                      onKeyDown={(e) => {
                                        if (e.key === "Escape") {
                                          cancelRename();
                                          setShareEditName("");
                                        }
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                      maxLength={TEXT_INPUT_MAX_LENGTH}
                                      ref={shareRenameInputRef}
                                      className="w-full rounded border border-blue-400 bg-white px-1 py-0.5 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-blue-300 dark:bg-gray-900 dark:text-gray-200"
                                    />
                                  </form>
                                ) : (
                                  <span
                                    className="block truncate text-sm font-medium text-gray-700 dark:text-gray-300"
                                    title={link.shareName}
                                  >
                                    {link.shareName}
                                  </span>
                                )}
                                <span className="block truncate text-xs text-gray-400 sm:hidden">
                                  {link.summary.itemCount}件 · {dateStr}
                                </span>
                              </div>
                              {!isRenaming && (
                                <button
                                  type="button"
                                  className="shrink-0 rounded-full p-1.5 text-gray-400 active:bg-gray-200 sm:hidden"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleShareContextMenu(e, link);
                                  }}
                                  aria-label="メニュー"
                                >
                                  <AppIcon title="メニュー" className="h-5 w-5">
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2}
                                      d="M12 5v.01M12 12v.01M12 19v.01"
                                    />
                                  </AppIcon>
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="hidden px-4 py-3 sm:table-cell">
                            <span className="text-sm text-gray-500 dark:text-gray-400">
                              {link.summary.itemCount}件
                            </span>
                          </td>
                          <td className="hidden px-4 py-3 sm:table-cell">
                            <span className="text-sm text-gray-500 dark:text-gray-400">
                              {dateStr}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                                link.summary.status === "active"
                                  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                                  : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                              }`}
                            >
                              {link.summary.status === "active"
                                ? "有効"
                                : "無効"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )
        ) : (
          <DropZone
            onDrop={(droppedFiles) => {
              if (browseMode === "trash") return;
              if (browseMode === "data") handleUpload(droppedFiles);
            }}
            onDropFolder={
              browseMode === "data"
                ? (entries: FolderEntry[]) => {
                    handleFolderUpload(entries, defaultEncryptName);
                  }
                : undefined
            }
          >
            {loading && filteredFiles.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
              </div>
            ) : (
              <>
                {loading && (
                  <div className="mb-2 h-0.5 w-full overflow-hidden rounded-full bg-gray-200">
                    <div className="h-full w-1/3 animate-[loading_1s_ease-in-out_infinite] rounded-full bg-blue-500" />
                  </div>
                )}
                {browseMode === "trash" && filteredFiles.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-gray-400 dark:text-gray-500">
                    <AppIcon title="空のゴミ箱" className="mb-4 h-16 w-16">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </AppIcon>
                    <p className="text-sm font-medium text-gray-600 dark:text-gray-300">
                      {files.length === 0
                        ? "ゴミ箱は空です"
                        : "検索条件に一致する項目はありません"}
                    </p>
                    <p className="mt-1 text-sm">
                      {files.length === 0
                        ? "削除したファイルはここに表示されます"
                        : "条件を変えてもう一度お試しください"}
                    </p>
                  </div>
                ) : (
                  <FileList
                    files={filteredFiles}
                    viewMode={viewMode}
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSort={handleSort}
                  />
                )}
              </>
            )}
          </DropZone>
        )}
      </main>

      {/* モバイル複数選択ツールバー */}
      {multiSelectMode && (
        <div className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-between border-t border-gray-200 bg-white px-4 py-3 shadow-lg sm:hidden dark:border-gray-700 dark:bg-gray-800">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {selectedIds.size}件選択中
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (browseMode === "share" && !currentFolderId) {
                  const ids = useShareStore
                    .getState()
                    .shareLinks.map((l) => l.summary.metaFileId);
                  useUIStore.getState().selectAll(ids);
                } else {
                  const ids = filteredFiles.map((f) => f.driveId);
                  useUIStore.getState().selectAll(ids);
                }
              }}
              className="rounded-lg px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20"
            >
              全選択
            </button>
            {selectedIds.size > 0 &&
              browseMode !== "trash" &&
              !(browseMode === "share" && !currentFolderId) && (
                <button
                  type="button"
                  onClick={() => {
                    const selectedFiles = files.filter((f) =>
                      selectedIds.has(f.driveId),
                    );
                    if (selectedFiles.length > 0) {
                      useFileStore.getState().downloadMultiple(selectedFiles);
                    }
                  }}
                  className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                  title="ダウンロード"
                >
                  <AppIcon title="ダウンロード" className="h-5 w-5">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                    />
                  </AppIcon>
                </button>
              )}
            {/* コピー（data / share 共通） */}
            {selectedIds.size > 0 &&
              browseMode !== "trash" &&
              !(browseMode === "share" && !currentFolderId) && (
                <button
                  type="button"
                  onClick={() => {
                    const targets = files.filter((f) =>
                      selectedIds.has(f.driveId),
                    );
                    if (targets.length > 0) {
                      useUIStore.getState().setClipboard({
                        action: "copy",
                        files: targets,
                        sourceFolderId: useFileStore.getState().currentFolderId,
                      });
                      useUIStore.getState().addToast({
                        message: `${targets.length}件をコピーしました`,
                        type: "success",
                      });
                      exitMultiSelectMode();
                    }
                  }}
                  className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                  title="コピー"
                >
                  <AppIcon title="コピー" className="h-5 w-5">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </AppIcon>
                </button>
              )}
            {/* 切り取り（data モードのみ） */}
            {selectedIds.size > 0 && browseMode === "data" && (
              <button
                type="button"
                onClick={() => {
                  const targets = files.filter((f) =>
                    selectedIds.has(f.driveId),
                  );
                  if (targets.length > 0) {
                    useUIStore.getState().setClipboard({
                      action: "cut",
                      files: targets,
                      sourceFolderId: useFileStore.getState().currentFolderId,
                    });
                    useUIStore.getState().addToast({
                      message: `${targets.length}件を切り取りました`,
                      type: "success",
                    });
                    exitMultiSelectMode();
                  }
                }}
                className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                title="切り取り"
              >
                <AppIcon title="切り取り" className="h-5 w-5">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z"
                  />
                </AppIcon>
              </button>
            )}
            {selectedIds.size === 1 &&
              browseMode === "share" &&
              !currentFolderId && (
                <button
                  type="button"
                  onClick={() => {
                    const [id] = Array.from(selectedIds);
                    if (id) useUIStore.getState().startRename(id);
                  }}
                  className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                  title="名前を変更"
                >
                  <AppIcon title="名前を変更" className="h-5 w-5">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    />
                  </AppIcon>
                </button>
              )}
            {selectedIds.size > 0 && (
              <button
                type="button"
                onClick={() => {
                  // 共有リンク一覧モードの場合
                  if (browseMode === "share" && !currentFolderId) {
                    handleShareDeleteSelected(() => exitMultiSelectMode());
                    return;
                  }
                  const selectedFiles = files.filter((f) =>
                    selectedIds.has(f.driveId),
                  );
                  if (selectedFiles.length === 0) return;
                  if (browseMode === "trash") {
                    useUIStore
                      .getState()
                      .openConfirmDialog(
                        `${selectedFiles.length}件を完全に削除しますか？この操作は取り消せません。`,
                        () => {
                          useFileStore
                            .getState()
                            .permanentDeleteMultiple(selectedFiles);
                          exitMultiSelectMode();
                        },
                      );
                  } else {
                    useUIStore
                      .getState()
                      .openConfirmDialog(
                        `${selectedFiles.length}件のアイテムをゴミ箱に移動しますか？`,
                        () => {
                          useFileStore.getState().removeMultiple(selectedFiles);
                          exitMultiSelectMode();
                        },
                      );
                  }
                }}
                className="rounded-lg p-2 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                title="削除"
              >
                <AppIcon title="削除" className="h-5 w-5">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </AppIcon>
              </button>
            )}
            <button
              type="button"
              onClick={exitMultiSelectMode}
              className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* モバイル FAB（スマホ用フローティングボタン） */}
      {browseMode === "data" && !multiSelectMode && (
        <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-3 sm:hidden">
          {/* 新しいフォルダボタン（小さめ） */}
          <button
            type="button"
            onClick={() => handleNewFolder()}
            className="flex h-12 w-12 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-700 shadow-lg transition active:scale-95 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
            aria-label="新しいフォルダ"
          >
            <AppIcon title="新しいフォルダ" className="h-5 w-5">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
              />
            </AppIcon>
          </button>
          {/* アップロードボタン */}
          <label
            className="flex h-12 w-12 cursor-pointer items-center justify-center rounded-full bg-blue-600 text-white shadow-lg transition active:scale-95"
            aria-label="フォルダをアップロード"
          >
            <AppIcon title="フォルダをアップロード" className="h-5 w-5">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
              />
            </AppIcon>
            <input
              type="file"
              className="hidden"
              onChange={(e) => handleFolderInput(e)}
              {...({
                webkitdirectory: "",
              } as React.InputHTMLAttributes<HTMLInputElement>)}
            />
          </label>
          {/* ファイルアップロードボタン */}
          <label
            className="flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-blue-600 text-white shadow-xl transition active:scale-95"
            aria-label="アップロード"
          >
            <AppIcon title="アップロード" className="h-6 w-6">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
              />
            </AppIcon>
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleFileInput(e)}
            />
          </label>
        </div>
      )}
      {/* ゴミ箱モード：モバイル FAB */}
      {browseMode === "trash" && files.length > 0 && !multiSelectMode && (
        <div className="fixed bottom-6 right-6 z-40 sm:hidden">
          <button
            type="button"
            onClick={() => {
              useUIStore
                .getState()
                .openConfirmDialog(
                  `ゴミ箱内の${files.length}件をすべて完全に削除しますか？この操作は取り消せません。`,
                  () => {
                    emptyTrash();
                  },
                );
            }}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 text-white shadow-xl transition active:scale-95"
            aria-label="ゴミ箱を空にする"
          >
            <AppIcon title="ゴミ箱を空にする" className="h-6 w-6">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </AppIcon>
          </button>
        </div>
      )}

      {/* トースト通知 */}
      <ToastContainer />

      {/* ファイルプレビュー */}
      {preview && <FilePreview />}

      {/* モーダル群 */}
      <ContextMenu />
      <ConfirmDialog />
      {showShareDialog && <ShareDialog />}
      {showSettings && <SettingsDialog onClose={closeSettings} />}
      {showPasswordChange && <PasswordChange onClose={closePasswordChange} />}

      {/* 矩形ドラッグ選択ボックス */}
      {dragSelect &&
        (Math.abs(dragSelect.currentX - dragSelect.startX) > 5 ||
          Math.abs(dragSelect.currentY - dragSelect.startY) > 5) && (
          <div
            className="pointer-events-none fixed z-40 border border-blue-500 bg-blue-500/10"
            style={{
              left: Math.min(dragSelect.startX, dragSelect.currentX),
              top: Math.min(dragSelect.startY, dragSelect.currentY),
              width: Math.abs(dragSelect.currentX - dragSelect.startX),
              height: Math.abs(dragSelect.currentY - dragSelect.startY),
            }}
          />
        )}
    </div>
  );
}
