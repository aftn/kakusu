import { useDownload } from "@/hooks/useDownload";
import { useFileStore } from "@/stores/fileStore";
import { useShareStore } from "@/stores/shareStore";
import { useUIStore } from "@/stores/uiStore";
import { useVaultStore } from "@/stores/vaultStore";
import {
  MAX_PREVIEW_FILE_BYTES,
  getMimeType,
  isPreviewable,
} from "@/utils/preview";
import { getCachedPreview, setCachedPreview } from "@/utils/previewCache";
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

const decorativeIconProps = {
  "aria-hidden": true,
  focusable: "false",
} as const;

function MenuIcon({
  children,
  className = "h-4 w-4 text-gray-400 dark:text-gray-500",
  title = "アイコン",
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      {...decorativeIconProps}
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <title>{title}</title>
      {children}
    </svg>
  );
}

function MenuButton({
  children,
  className = "flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
}) {
  return (
    <button type="button" className={className} {...props}>
      {children}
    </button>
  );
}

export default function ContextMenu() {
  const contextMenu = useUIStore((s) => s.contextMenu);
  const closeContextMenu = useUIStore((s) => s.closeContextMenu);
  const openShareDialog = useUIStore((s) => s.openShareDialog);
  const startRename = useUIStore((s) => s.startRename);
  const selectedIds = useUIStore((s) => s.selectedIds);
  const clearSelection = useUIStore((s) => s.clearSelection);
  const {
    remove,
    removeMultiple,
    downloadMultiple,
    pasteFiles,
    files,
    refresh,
    currentFolderId,
    restoreFile,
    restoreMultiple,
    permanentDelete,
    permanentDeleteMultiple,
  } = useFileStore();
  const browseMode = useFileStore((s) => s.browseMode);
  const clipboard = useUIStore((s) => s.clipboard);
  const setClipboard = useUIStore((s) => s.setClipboard);
  const { handleDownload } = useDownload();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      // メニュー内のクリック（ファイル選択ダイアログを含む）では閉じない
      if (menuRef.current?.contains(e.target as Node)) return;
      closeContextMenu();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeContextMenu();
    };
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [closeContextMenu]);

  useEffect(() => {
    setPosition(null);
    if (!contextMenu) return;
    // rAF で描画後に要素サイズを測定して位置を確定する
    const id = requestAnimationFrame(() => {
      if (!menuRef.current) return;
      const rect = menuRef.current.getBoundingClientRect();
      let { x, y } = contextMenu;
      if (x + rect.width > window.innerWidth)
        x = window.innerWidth - rect.width - 8;
      if (y + rect.height > window.innerHeight)
        y = window.innerHeight - rect.height - 8;
      if (x < 0) x = 8;
      if (y < 0) y = 8;
      setPosition({ x, y });
    });
    return () => cancelAnimationFrame(id);
  }, [contextMenu]);

  if (!contextMenu) return null;

  const isFileMenu = contextMenu.type === "file";
  const file = isFileMenu ? contextMenu.file : null;
  const multiCount = selectedIds.size;

  const handleRename = () => {
    if (!file) return;
    closeContextMenu();
    startRename(file.driveId);
  };

  const handleDelete = () => {
    const openConfirmDialog = useUIStore.getState().openConfirmDialog;
    closeContextMenu();
    if (multiCount > 1) {
      const selectedFiles = files.filter((f) => selectedIds.has(f.driveId));
      openConfirmDialog(
        `${selectedFiles.length}件のアイテムをゴミ箱に移動しますか？`,
        () => {
          removeMultiple(selectedFiles);
          clearSelection();
        },
      );
    } else if (file) {
      openConfirmDialog(`「${file.name}」をゴミ箱に移動しますか？`, () => {
        remove(file);
      });
    }
  };

  const handleShareLinkDelete = () => {
    const { openConfirmDialog, addToast, updateToast } = useUIStore.getState();
    const { removeShareLinks, shareLinks } = useShareStore.getState();
    closeContextMenu();

    const targetIds =
      multiCount > 1
        ? shareLinks
            .filter((l) => selectedIds.has(l.summary.metaFileId))
            .map((l) => ({ id: l.summary.metaFileId, name: l.shareName }))
        : file
          ? [{ id: file.driveId, name: file.name }]
          : [];
    if (targetIds.length === 0) return;

    const metaFileIds = targetIds.map((t) => t.id);
    const label =
      targetIds.length === 1
        ? `「${targetIds[0]?.name}」`
        : `${targetIds.length}件の共有リンク`;
    const message = `${label}の共有を無効化してから削除しますか？\nGoogle Drive側のファイル共有を無効化してから削除すると時間がかかる場合があります。`;

    const doDelete = (revoke: boolean) => {
      // 削除確認後に対象がまだ存在するか検証する
      const currentLinks = useShareStore.getState().shareLinks;
      const validIds = metaFileIds.filter((id) =>
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
      clearSelection();
    };

    openConfirmDialog(message, () => doDelete(true), {
      confirmLabel: "削除",
      secondaryLabel: "無効化せずに削除",
      onSecondary: () => doDelete(false),
    });
  };

  const handleMultiDownload = () => {
    const selectedFiles = files.filter((f) => selectedIds.has(f.driveId));
    closeContextMenu();
    downloadMultiple(selectedFiles);
  };

  const handleMultiShare = () => {
    const selectedFiles = files.filter((f) => selectedIds.has(f.driveId));
    if (selectedFiles.length > 0) {
      closeContextMenu();
      openShareDialog(selectedFiles);
    }
  };

  const handleNewFolder = () => {
    closeContextMenu();
    const tempId = useFileStore.getState().addPendingFolder();
    useUIStore.getState().startRename(tempId);
  };

  const handleRefresh = () => {
    closeContextMenu();
    refresh();
  };

  const handleRestore = () => {
    const openConfirmDialog = useUIStore.getState().openConfirmDialog;
    closeContextMenu();
    if (multiCount > 1) {
      const selectedFiles = files.filter((f) => selectedIds.has(f.driveId));
      openConfirmDialog(`${selectedFiles.length}件を復元しますか？`, () => {
        restoreMultiple(selectedFiles);
        clearSelection();
      });
    } else if (file) {
      restoreFile(file);
    }
  };

  const handlePermanentDelete = () => {
    const openConfirmDialog = useUIStore.getState().openConfirmDialog;
    closeContextMenu();
    if (multiCount > 1) {
      const selectedFiles = files.filter((f) => selectedIds.has(f.driveId));
      openConfirmDialog(
        `${selectedFiles.length}件を完全に削除しますか？この操作は取り消せません。`,
        () => {
          permanentDeleteMultiple(selectedFiles);
          clearSelection();
        },
      );
    } else if (file) {
      openConfirmDialog(
        `「${file.name}」を完全に削除しますか？この操作は取り消せません。`,
        () => {
          permanentDelete(file);
        },
      );
    }
  };

  const handleCopyShareURL = async () => {
    closeContextMenu();
    const { addToast, updateToast } = useUIStore.getState();

    const tid = addToast({ message: "URL を発行中...", type: "progress" });

    try {
      // Try new meta-file share URL copy via shareStore
      const shareLinks = useShareStore.getState().shareLinks;

      // If we have a file selected in share mode, try matching against share links
      if (file && shareLinks.length > 0) {
        for (const link of shareLinks) {
          if (link.summary.metaFileId === file.driveId) {
            try {
              await useShareStore
                .getState()
                .copyShareLink(link.summary.metaFileId);
              updateToast(tid, {
                message: "共有URLをコピーしました",
                type: "success",
              });
              return;
            } catch {
              break;
            }
          }
        }
      }

      // No share link found for this file
      updateToast(tid, {
        message: "共有URLの取得に失敗しました",
        type: "error",
      });
    } catch {
      updateToast(tid, {
        message: "共有URLの取得に失敗しました",
        type: "error",
      });
    }
  };

  const handleCopy = () => {
    closeContextMenu();
    const targets =
      multiCount > 1
        ? files.filter((f) => selectedIds.has(f.driveId))
        : file
          ? [file]
          : [];
    if (targets.length > 0) {
      setClipboard({
        action: "copy",
        files: targets,
        sourceFolderId: currentFolderId,
      });
    }
  };

  const handleCut = () => {
    closeContextMenu();
    const targets =
      multiCount > 1
        ? files.filter((f) => selectedIds.has(f.driveId))
        : file
          ? [file]
          : [];
    if (targets.length > 0) {
      setClipboard({
        action: "cut",
        files: targets,
        sourceFolderId: currentFolderId,
      });
    }
  };

  const handlePaste = () => {
    closeContextMenu();
    if (!clipboard) return;
    const vault = useFileStore.getState();
    const destId =
      currentFolderId ||
      vault.currentFolderId ||
      useVaultStore.getState().dataFolderId;
    if (!destId) return;
    void pasteFiles(clipboard, destId);
    if (clipboard.action === "cut") {
      setClipboard(null);
    }
  };

  // 背景コンテキストメニュー
  if (!isFileMenu) {
    return (
      <div
        ref={menuRef}
        className="fixed z-50 w-56 rounded-lg border border-gray-200 bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-800"
        style={{
          left: position ? position.x : contextMenu.x,
          top: position ? position.y : contextMenu.y,
          visibility: position ? "visible" : "hidden",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {browseMode === "data" && (
          <>
            <MenuButton onClick={handleNewFolder}>
              <MenuIcon>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
                />
              </MenuIcon>
              新しいフォルダ
            </MenuButton>
            <label className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700">
              <MenuIcon>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              </MenuIcon>
              ファイルをアップロード
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) {
                    const event = new CustomEvent("kakusu:upload", {
                      detail: e.target.files,
                    });
                    window.dispatchEvent(event);
                  }
                  closeContextMenu();
                }}
              />
            </label>
            <label className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700">
              <MenuIcon>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              </MenuIcon>
              フォルダをアップロード
              <input
                type="file"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    const event = new CustomEvent("kakusu:folderupload", {
                      detail: e.target.files,
                    });
                    window.dispatchEvent(event);
                  }
                  closeContextMenu();
                }}
                {...({
                  webkitdirectory: "",
                } as React.InputHTMLAttributes<HTMLInputElement>)}
              />
            </label>
            <hr className="my-1 border-gray-100 dark:border-gray-700" />
          </>
        )}
        {browseMode === "share" &&
          useFileStore.getState().folderPath.length > 0 && (
            <>
              <MenuButton onClick={handleCopyShareURL}>
                <MenuIcon>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
                  />
                </MenuIcon>
                共有URLをコピー
              </MenuButton>
              <hr className="my-1 border-gray-100 dark:border-gray-700" />
            </>
          )}
        {clipboard && browseMode === "data" && (
          <MenuButton onClick={handlePaste}>
            <MenuIcon>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </MenuIcon>
            貼り付け ({clipboard.files.length}件)
          </MenuButton>
        )}
        <MenuButton onClick={handleRefresh}>
          <MenuIcon>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </MenuIcon>
          最新の状態に更新
        </MenuButton>
      </div>
    );
  }

  // ゴミ箱モードのコンテキストメニュー
  if (browseMode === "trash") {
    return (
      <div
        ref={menuRef}
        className="fixed z-50 w-52 rounded-lg border border-gray-200 bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-800"
        style={{
          left: position ? position.x : contextMenu.x,
          top: position ? position.y : contextMenu.y,
          visibility: position ? "visible" : "hidden",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {multiCount > 1 && (
          <div className="px-4 py-1.5 text-xs text-gray-400 dark:text-gray-500">
            {multiCount}件選択中
          </div>
        )}
        <MenuButton onClick={handleRestore}>
          <MenuIcon>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
            />
          </MenuIcon>
          {multiCount > 1 ? "まとめて復元" : "復元"}
        </MenuButton>
        <hr className="my-1 border-gray-100 dark:border-gray-700" />
        <MenuButton
          onClick={handlePermanentDelete}
          className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
        >
          <MenuIcon className="h-4 w-4">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </MenuIcon>
          {multiCount > 1 ? "まとめて完全に削除" : "完全に削除"}
        </MenuButton>
      </div>
    );
  }

  // ファイルのコンテキストメニュー — 共有リンク一覧モード
  if (browseMode === "share" && !currentFolderId) {
    return (
      <div
        ref={menuRef}
        className="fixed z-50 w-52 rounded-lg border border-gray-200 bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-800"
        style={{
          left: position ? position.x : contextMenu.x,
          top: position ? position.y : contextMenu.y,
          visibility: position ? "visible" : "hidden",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {multiCount > 1 ? (
          <>
            <div className="px-4 py-1.5 text-xs text-gray-400 dark:text-gray-500">
              {multiCount}件選択中
            </div>
            <MenuButton
              onClick={handleShareLinkDelete}
              className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              <MenuIcon className="h-4 w-4">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </MenuIcon>
              まとめて削除
            </MenuButton>
          </>
        ) : (
          <>
            <MenuButton onClick={handleRename}>
              <MenuIcon>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                />
              </MenuIcon>
              名前を変更
            </MenuButton>
            <MenuButton onClick={handleCopyShareURL}>
              <MenuIcon>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
                />
              </MenuIcon>
              共有URLをコピー
            </MenuButton>
            <hr className="my-1 border-gray-100 dark:border-gray-700" />
            <MenuButton
              onClick={handleShareLinkDelete}
              className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              <MenuIcon className="h-4 w-4">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </MenuIcon>
              削除
            </MenuButton>
          </>
        )}
      </div>
    );
  }

  // ファイルのコンテキストメニュー
  return (
    <div
      ref={menuRef}
      className="fixed z-50 w-52 rounded-lg border border-gray-200 bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-800"
      style={{
        left: position ? position.x : contextMenu.x,
        top: position ? position.y : contextMenu.y,
        visibility: position ? "visible" : "hidden",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {multiCount > 1 ? (
        <>
          <div className="px-4 py-1.5 text-xs text-gray-400 dark:text-gray-500">
            {multiCount}件選択中
          </div>
          <MenuButton onClick={handleMultiDownload}>
            <MenuIcon>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </MenuIcon>
            まとめてダウンロード
          </MenuButton>
          {browseMode === "data" && (
            <MenuButton onClick={handleMultiShare}>
              <MenuIcon>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                />
              </MenuIcon>
              まとめて共有
            </MenuButton>
          )}
          <MenuButton onClick={handleCopy}>
            <MenuIcon>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </MenuIcon>
            コピー
          </MenuButton>
          {browseMode === "data" && (
            <MenuButton onClick={handleCut}>
              <MenuIcon>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z"
                />
              </MenuIcon>
              切り取り
            </MenuButton>
          )}
          <hr className="my-1 border-gray-100 dark:border-gray-700" />
          <MenuButton
            onClick={handleDelete}
            className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            <MenuIcon className="h-4 w-4">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </MenuIcon>
            まとめて削除
          </MenuButton>
        </>
      ) : (
        <>
          {file && file.type === "file" && (
            <MenuButton
              onClick={() => {
                closeContextMenu();
                handleDownload(file);
              }}
            >
              <MenuIcon>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </MenuIcon>
              ダウンロード
            </MenuButton>
          )}
          {file && file.type === "file" && isPreviewable(file.name) && (
            <MenuButton
              onClick={() => {
                if (!file) return;
                closeContextMenu();
                const {
                  setPreview,
                  addToast,
                  updateToast: ut,
                } = useUIStore.getState();
                const cached = getCachedPreview(file.driveId);
                if (file.size && file.size > MAX_PREVIEW_FILE_BYTES) {
                  const { addToast } = useUIStore.getState();
                  addToast({
                    message:
                      "ファイルが大きすぎるためプレビューできません（200MB超）。ダウンロードして確認してください。",
                    type: "error",
                  });
                  return;
                }
                if (cached) {
                  setPreview({
                    file,
                    blobUrl: cached.blobUrl,
                    mimeType: cached.mimeType,
                  });
                  return;
                }
                const { downloadFileAsBlob } = useFileStore.getState();
                const tid = addToast({
                  message: `「${file.name}」をプレビュー中...`,
                  type: "progress",
                });
                downloadFileAsBlob(file)
                  .then((blob) => {
                    const mimeType = blob.type || getMimeType(file.name);
                    const blobUrl = URL.createObjectURL(blob);
                    setCachedPreview(file.driveId, blobUrl, mimeType);
                    setPreview({ file, blobUrl, mimeType });
                    ut(tid, {
                      message: `「${file.name}」のプレビュー準備完了`,
                      type: "success",
                    });
                  })
                  .catch(() => {
                    ut(tid, {
                      message: "プレビューの読み込みに失敗しました",
                      type: "error",
                    });
                  });
              }}
            >
              <MenuIcon>
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
              </MenuIcon>
              プレビュー
            </MenuButton>
          )}
          {file && file.type === "folder" && (
            <>
              <MenuButton
                onClick={() => {
                  if (!file) return;
                  closeContextMenu();
                  const { navigate } = useFileStore.getState();
                  navigate(file.driveId, file.name);
                }}
              >
                <MenuIcon>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                  />
                </MenuIcon>
                開く
              </MenuButton>
              {browseMode !== "share" && (
                <MenuButton
                  onClick={() => {
                    closeContextMenu();
                    handleDownload(file);
                  }}
                >
                  <MenuIcon>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                    />
                  </MenuIcon>
                  フォルダごとダウンロード
                </MenuButton>
              )}
            </>
          )}
          {(browseMode === "data" || browseMode === "share") && (
            <MenuButton onClick={handleRename}>
              <MenuIcon>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                />
              </MenuIcon>
              名前を変更
            </MenuButton>
          )}
          {file && browseMode === "data" && (
            <MenuButton
              onClick={() => {
                if (!file) return;
                closeContextMenu();
                openShareDialog([file]);
              }}
            >
              <MenuIcon>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                />
              </MenuIcon>
              共有
            </MenuButton>
          )}
          {browseMode === "share" && (
            <MenuButton onClick={handleCopyShareURL}>
              <MenuIcon>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
                />
              </MenuIcon>
              共有URLをコピー
            </MenuButton>
          )}
          <MenuButton onClick={handleCopy}>
            <MenuIcon>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </MenuIcon>
            コピー
          </MenuButton>
          {browseMode === "data" && (
            <MenuButton onClick={handleCut}>
              <MenuIcon>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z"
                />
              </MenuIcon>
              切り取り
            </MenuButton>
          )}
          <hr className="my-1 border-gray-100 dark:border-gray-700" />
          <MenuButton
            onClick={handleDelete}
            className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            <MenuIcon className="h-4 w-4">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </MenuIcon>
            ゴミ箱に移動
          </MenuButton>
        </>
      )}
    </div>
  );
}
