import { validateDriveFolderName } from "@/drive/validation";
import { useFileStore } from "@/stores/fileStore";
import { useUIStore } from "@/stores/uiStore";
import type { KakusuFile } from "@/types";
import { downloadBlob } from "@/utils/download";
import {
  MAX_PREVIEW_FILE_BYTES,
  getMimeType,
  getPreviewType,
  isPreviewable,
  sanitizeFileName,
} from "@/utils/preview";
import { getCachedPreview, setCachedPreview } from "@/utils/previewCache";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/** D&D の dataTransfer からファイル ID 配列を取得する */
function getDraggedFileIds(e: React.DragEvent): string[] {
  try {
    const json = e.dataTransfer.getData("application/kakusu-file-ids");
    if (json) {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
        return parsed;
      }
    }
  } catch {
    /* invalid JSON — fall through */
  }
  // フォールバック: 単一 ID
  const single = e.dataTransfer.getData("text/plain");
  return single ? [single] : [];
}

// プレビュー読み込みの競合を避けるため、モジュール単位で状態を管理する。
let activePreviewFileId: string | null = null;
let activePreviewRequestId = 0;
let activePreviewToastId: string | null = null;

/** Long-press detection threshold in ms */
const LONG_PRESS_DURATION = 500;

function SvgIcon({
  title,
  className,
  fill = "none",
  stroke = "currentColor",
  viewBox = "0 0 24 24",
  children,
}: {
  title: string;
  className: string;
  fill?: string;
  stroke?: string;
  viewBox?: string;
  children: ReactNode;
}) {
  return (
    <svg
      className={className}
      fill={fill}
      stroke={stroke}
      viewBox={viewBox}
      focusable="false"
    >
      <title>{title}</title>
      {children}
    </svg>
  );
}

/** 拡張子を残したままファイル名を省略する。 */
function truncateFileName(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx <= 0) return `${name.slice(0, maxLen - 2)}...`;
  const ext = name.slice(dotIdx); // ".png"
  const stem = name.slice(0, dotIdx);
  const available = maxLen - ext.length - 3; // 3 for "..."
  if (available < 1) return `${name.slice(0, maxLen - 2)}...`;
  return `${stem.slice(0, available)}...${ext}`;
}

interface FileItemProps {
  file: KakusuFile;
  viewMode: "list" | "grid";
  selected: boolean;
  onSelect: (id: string, e: React.MouseEvent) => void;
  compact?: boolean;
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function FileItem({
  file,
  viewMode,
  selected,
  onSelect,
  compact,
}: FileItemProps) {
  const navigate = useFileStore((s) => s.navigate);
  const rename = useFileStore((s) => s.rename);
  const moveFile = useFileStore((s) => s.moveFile);
  const moveFiles = useFileStore((s) => s.moveFiles);
  const openContextMenu = useUIStore((s) => s.openContextMenu);
  const selectFile = useUIStore((s) => s.selectFile);
  const selectedIds = useUIStore((s) => s.selectedIds);
  const renamingFileId = useUIStore((s) => s.renamingFileId);
  const cancelRename = useUIStore((s) => s.cancelRename);
  const clipboard = useUIStore((s) => s.clipboard);
  const isCut =
    clipboard?.action === "cut" &&
    clipboard.files.some((f) => f.driveId === file.driveId);

  const isRenaming = renamingFileId === file.driveId;
  const [editName, setEditName] = useState(file.name);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchMovedRef = useRef(false);

  // ドラッグ移動時の親フォルダ ID。
  const parentId = useFileStore((s) => s.currentFolderId || "");
  const multiSelectMode = useUIStore((s) => s.multiSelectMode);

  useEffect(() => {
    if (isRenaming) {
      setEditName(file.name);
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          const dotIdx = file.name.lastIndexOf(".");
          inputRef.current.setSelectionRange(
            0,
            dotIdx > 0 && file.type === "file" ? dotIdx : file.name.length,
          );
        }
      }, 0);
    }
  }, [isRenaming, file.name, file.type]);

  const handleRenameSubmit = useCallback(() => {
    const trimmed = editName.trim();
    if (file.pending) {
      // 仮フォルダは確定時に Drive へ作成し、空名なら破棄する。
      if (trimmed) {
        const encryptName = useUIStore.getState().defaultEncryptName;
        if (!encryptName) {
          const err = validateDriveFolderName(trimmed);
          if (err) {
            useUIStore.getState().addToast({ message: err, type: "error" });
            cancelRename();
            useFileStore.getState().removePendingFolder(file.driveId);
            return;
          }
        }
        useFileStore
          .getState()
          .confirmPendingFolder(file.driveId, trimmed, encryptName);
      } else {
        useFileStore.getState().removePendingFolder(file.driveId);
      }
      cancelRename();
      return;
    }
    if (trimmed && trimmed !== file.name) {
      if (!file.nameEncrypted && file.type === "folder") {
        const err = validateDriveFolderName(trimmed);
        if (err) {
          useUIStore.getState().addToast({ message: err, type: "error" });
          cancelRename();
          return;
        }
      }
      rename(file, trimmed);
    }
    cancelRename();
  }, [editName, file, rename, cancelRename]);

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleRenameSubmit();
    } else if (e.key === "Escape") {
      if (file.pending) {
        useFileStore.getState().removePendingFolder(file.driveId);
      }
      cancelRename();
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    if (isRenaming) return;
    onSelect(file.driveId, e);
  };

  const browseMode = useFileStore((s) => s.browseMode);

  const handleItemKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (isRenaming) return;

    if (e.key === "Enter") {
      e.preventDefault();
      handleDoubleClick();
      return;
    }

    if (e.key === " ") {
      e.preventDefault();
      selectFile(file.driveId, e.ctrlKey || e.metaKey);
    }
  };

  const handleDoubleClick = () => {
    if (isRenaming) return;
    // ゴミ箱ではフォルダ移動やファイルのプレビューを行わない。
    if (browseMode === "trash") return;
    if (file.type === "folder") {
      // 保留中のフォルダ（まだ Drive に作成されていない）には移動できない。
      if (file.pending) return;
      navigate(file.driveId, file.name);
      return;
    }
    if (file.type === "file" && isPreviewable(file.name)) {
      const { setPreview, addToast, updateToast: ut } = useUIStore.getState();
      if (file.size && file.size > MAX_PREVIEW_FILE_BYTES) {
        addToast({
          message:
            "ファイルが大きすぎるためプレビューできません（200MB超）。ダウンロードして確認してください。",
          type: "error",
        });
        return;
      }
      const cached = getCachedPreview(file.driveId);
      if (cached) {
        setPreview({
          file,
          blobUrl: cached.blobUrl,
          mimeType: cached.mimeType,
        });
        return;
      }
      if (activePreviewFileId === file.driveId) {
        return;
      }
      if (activePreviewFileId && activePreviewToastId) {
        ut(activePreviewToastId, {
          message: "プレビューをキャンセルしました",
          type: "error",
        });
      }
      activePreviewRequestId++;
      const myRequestId = activePreviewRequestId;
      activePreviewFileId = file.driveId;
      const { downloadFileAsBlob } = useFileStore.getState();
      const tid = addToast({
        message: `「${file.name}」をプレビュー中...`,
        type: "progress",
      });
      activePreviewToastId = tid;
      downloadFileAsBlob(file)
        .then((blob) => {
          if (myRequestId !== activePreviewRequestId) return;
          activePreviewFileId = null;
          activePreviewToastId = null;
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
          if (myRequestId !== activePreviewRequestId) return;
          activePreviewFileId = null;
          activePreviewToastId = null;
          ut(tid, {
            message: "プレビューの読み込みに失敗しました",
            type: "error",
          });
        });
    } else if (file.type === "file") {
      useUIStore
        .getState()
        .openConfirmDialog(
          `「${file.name}」はプレビューできません。ダウンロードしますか？`,
          () => {
            const { downloadFileAsBlob } = useFileStore.getState();
            const { addToast, updateToast: ut } = useUIStore.getState();
            const tid = addToast({
              message: `「${file.name}」をダウンロード中...`,
              type: "progress",
            });
            downloadFileAsBlob(file)
              .then((blob) => {
                downloadBlob(blob, sanitizeFileName(file.name));
                ut(tid, {
                  message: `「${file.name}」のダウンロード完了`,
                  type: "success",
                });
              })
              .catch(() => {
                ut(tid, {
                  message: "ダウンロードに失敗しました",
                  type: "error",
                });
              });
          },
        );
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 複数選択モード中はコンテキストメニューを出さない
    if (multiSelectMode) return;
    if (!selected) {
      onSelect(file.driveId, e);
    }
    openContextMenu(e.clientX, e.clientY, file);
  };

  // ドラッグアンドドロップでフォルダへ移動する。
  const handleDragStart = (e: React.DragEvent) => {
    if (browseMode === "trash") {
      e.preventDefault();
      return;
    }
    // 複数選択中かつドラッグ対象が選択状態の場合、全選択IDを送る
    const ids =
      selectedIds.size > 1 && selectedIds.has(file.driveId)
        ? Array.from(selectedIds)
        : [file.driveId];
    e.dataTransfer.setData("application/kakusu-file-ids", JSON.stringify(ids));
    e.dataTransfer.setData("text/plain", file.driveId);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (browseMode === "trash") return;
    if (file.type !== "folder") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (browseMode === "trash") return;
    if (file.type !== "folder") return;
    const ids = getDraggedFileIds(e);
    if (ids.length === 0 || (ids.length === 1 && ids[0] === file.driveId)) return;
    if (ids.length === 1) {
      moveFile(ids[0]!, file.driveId, parentId);
    } else {
      const files = useFileStore.getState().files;
      const moves = ids
        .filter((id) => id !== file.driveId)
        .map((id) => ({
          fileId: id,
          newParentId: file.driveId,
          oldParentId: files.find((f) => f.driveId === id)?.parentId ?? parentId,
        }));
      if (moves.length > 0) moveFiles(moves);
    }
  };

  const icon =
    file.type === "folder" ? (
      <SvgIcon
        title="フォルダ"
        className="h-5 w-5 text-blue-500"
        fill="currentColor"
        stroke="none"
      >
        <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
      </SvgIcon>
    ) : (
      <SvgIcon title="ファイル" className="h-5 w-5 text-gray-400">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </SvgIcon>
    );

  const nameDisplay = isRenaming ? (
    <input
      ref={inputRef}
      value={editName}
      onChange={(e) => setEditName(e.target.value)}
      onBlur={handleRenameSubmit}
      onKeyDown={handleRenameKeyDown}
      onClick={(e) => e.stopPropagation()}
      maxLength={200}
      className="w-full rounded border border-blue-400 bg-white px-1 py-0.5 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-blue-300 dark:border-blue-500 dark:bg-gray-700 dark:text-gray-200"
    />
  ) : (
    <span
      className="flex min-w-0 text-sm text-gray-800 dark:text-gray-200"
      title={file.name}
    >
      {(() => {
        const dotIdx = file.name.lastIndexOf(".");
        if (dotIdx > 0 && file.type === "file") {
          return (
            <>
              <span className="truncate">{file.name.slice(0, dotIdx)}</span>
              <span className="shrink-0">{file.name.slice(dotIdx)}</span>
            </>
          );
        }
        return <span className="truncate">{file.name}</span>;
      })()}
    </span>
  );

  const gridNameDisplay = isRenaming ? (
    nameDisplay
  ) : (
    <span className="block break-all text-center text-sm text-gray-800 line-clamp-2 dark:text-gray-200">
      {truncateFileName(file.name, 30)}
    </span>
  );

  // モバイル用ハンドラ（compact / grid 共通）
  const handleMobileClick = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // 右クリック等を無視（onMouseUp 経由で呼ばれるケース対策）
    if (useUIStore.getState().isDragSelecting) return; // 矩形ドラッグ選択中は無視
    if (isRenaming) return;
    if (multiSelectMode) {
      e.preventDefault();
      e.stopPropagation();
      useUIStore.getState().toggleSelectFile(file.driveId);
      return;
    }
    onSelect(file.driveId, e);
  };

  const handleMobileDoubleClick = () => {
    if (multiSelectMode) return;
    handleDoubleClick();
  };

  const handleTouchStart = () => {
    touchMovedRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      if (!multiSelectMode) {
        useUIStore.getState().setMultiSelectMode(true);
      }
      // ロングプレスで選択モードに移行したらメニューを閉じる
      useUIStore.getState().closeContextMenu();
      useUIStore.getState().selectFile(file.driveId, false);
    }, LONG_PRESS_DURATION);
  };

  const handleTouchMove = () => {
    touchMovedRef.current = true;
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    // In multi-select mode, prevent default to avoid triggering click on touch
    if (multiSelectMode && !touchMovedRef.current) {
      e.preventDefault();
      useUIStore.getState().toggleSelectFile(file.driveId);
    }
  };

  if (compact) {
    const compactIcon =
      file.type === "folder" ? (
        <SvgIcon
          title="フォルダ"
          className="h-8 w-8 text-blue-500"
          fill="currentColor"
          stroke="none"
        >
          <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
        </SvgIcon>
      ) : (
        <SvgIcon title="ファイル" className="h-8 w-8 text-gray-400">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </SvgIcon>
      );

    const compactDate = (() => {
      const d = new Date(file.modifiedTime);
      const now = new Date();
      if (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      ) {
        return d.toLocaleString("ja-JP", {
          hour: "2-digit",
          minute: "2-digit",
        });
      }
      if (d.getFullYear() === now.getFullYear()) {
        return `${d.getMonth() + 1}月${d.getDate()}日`;
      }
      return d.toLocaleDateString("ja-JP", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    })();

    return (
      <div
        data-file-item
        data-file-id={file.driveId}
        className={`group flex cursor-pointer select-none items-center gap-3 px-4 py-3 transition active:bg-gray-100 dark:active:bg-gray-700 ${
          selected ? "bg-[#cce8ff] dark:bg-blue-900/40" : ""
        } ${file.pending || file.uploading || isCut ? "opacity-50" : ""}`}
        onClick={handleMobileClick}
        onDoubleClick={handleMobileDoubleClick}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {multiSelectMode ? (
          <button
            type="button"
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 transition ${
              selected
                ? "border-blue-500 bg-blue-500 text-white"
                : "border-gray-300 bg-white text-transparent dark:border-gray-600 dark:bg-gray-700"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              useUIStore.getState().toggleSelectFile(file.driveId);
            }}
            aria-label={selected ? "選択を解除" : "選択"}
          >
            <span className="text-xs leading-none">✓</span>
          </button>
        ) : (
          <div className="relative shrink-0">
            {compactIcon}
            {file.isShared && (
              <SvgIcon
                title="共有中"
                className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-white text-blue-500"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                />
              </SvgIcon>
            )}
          </div>
        )}
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <input
              ref={inputRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={handleRenameKeyDown}
              onClick={(e) => e.stopPropagation()}
              maxLength={200}
              className="w-full rounded border border-blue-400 bg-white px-1 py-0.5 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-blue-300 dark:border-blue-500 dark:bg-gray-700 dark:text-gray-200"
            />
          ) : (
            <p className="flex min-w-0 text-sm font-medium text-gray-900 dark:text-gray-100">
              {(() => {
                const dotIdx = file.name.lastIndexOf(".");
                if (dotIdx > 0 && file.type === "file") {
                  return (
                    <>
                      <span className="truncate">
                        {file.name.slice(0, dotIdx)}
                      </span>
                      <span className="shrink-0">
                        {file.name.slice(dotIdx)}
                      </span>
                    </>
                  );
                }
                return <span className="truncate">{file.name}</span>;
              })()}
            </p>
          )}
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {file.type === "folder" ? "フォルダ" : formatSize(file.size)}
            <span className="mx-1">·</span>
            {compactDate}
          </p>
        </div>
        {!multiSelectMode && (
          <button
            type="button"
            className="shrink-0 rounded-full p-1.5 text-gray-400 active:bg-gray-200"
            onClick={(e) => {
              e.stopPropagation();
              openContextMenu(e.clientX, e.clientY, file);
            }}
            aria-label="メニュー"
          >
            <SvgIcon title="メニュー" className="h-5 w-5">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 5v.01M12 12v.01M12 19v.01"
              />
            </SvgIcon>
          </button>
        )}
      </div>
    );
  }

  if (viewMode === "grid") {
    const cachedPreview =
      file.type === "file" ? getCachedPreview(file.driveId) : null;
    const isImage = cachedPreview && getPreviewType(file.name) === "image";

    return (
      <div
        data-file-item
        data-file-id={file.driveId}
        data-selected={selected || undefined}
        draggable={!isRenaming}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`group relative flex cursor-pointer select-none flex-col items-center gap-2 rounded-lg border p-4 transition
          ${selected ? "border-blue-400 bg-blue-50 shadow-sm dark:bg-blue-900/20" : "border-gray-200 bg-white hover:border-blue-300 hover:shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:hover:border-blue-500"}
          ${dragOver ? "border-blue-500 bg-blue-100" : ""}
          ${file.pending || file.uploading || isCut ? "opacity-50" : ""}`}
        onMouseUp={handleMobileClick}
        onDoubleClick={handleMobileDoubleClick}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <button
          type="button"
          aria-label={
            selected ? `「${file.name}」の選択を解除` : `「${file.name}」を選択`
          }
          className={`absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded border transition
            ${selected ? "border-blue-500 bg-blue-500 text-white" : multiSelectMode ? "border-gray-300 bg-white text-transparent dark:border-gray-600 dark:bg-gray-700" : "border-gray-300 bg-white text-transparent opacity-0 group-hover:opacity-100"}`}
          onClick={(e) => {
            e.stopPropagation();
            selectFile(file.driveId, true);
          }}
        >
          <span aria-hidden="true" className="text-[10px] leading-none">
            ✓
          </span>
        </button>
        <div className="flex h-12 w-12 items-center justify-center">
          {file.type === "folder" ? (
            <SvgIcon
              title="フォルダ"
              className="h-12 w-12 text-blue-500"
              fill="currentColor"
              stroke="none"
            >
              <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
            </SvgIcon>
          ) : isImage ? (
            <img
              src={cachedPreview.blobUrl}
              alt={file.name}
              className="h-12 w-12 rounded object-cover"
            />
          ) : (
            <SvgIcon title="ファイル" className="h-12 w-12 text-gray-300">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </SvgIcon>
          )}
        </div>
        <div className="w-full min-w-0 px-1 text-center" title={file.name}>
          {gridNameDisplay}
        </div>
      </div>
    );
  }

  return (
    <tr
      data-file-item
      data-file-id={file.driveId}
      data-selected={selected || undefined}
      tabIndex={0}
      draggable={!isRenaming}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onKeyDown={handleItemKeyDown}
      className={`group cursor-pointer select-none transition
        ${selected ? "bg-[#cce8ff] dark:bg-blue-900/40" : "hover:bg-[#f5f9ff] dark:hover:bg-gray-800"}
        ${dragOver ? "bg-[#dcebff]" : ""}
        ${file.pending || file.uploading || isCut ? "opacity-50" : ""}`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      <td className="w-0 overflow-hidden px-4 py-2.5 align-middle">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            aria-label={
              selected
                ? `「${file.name}」の選択を解除`
                : `「${file.name}」を選択`
            }
            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition
              ${selected ? "border-blue-500 bg-blue-500 text-white" : "border-gray-300 bg-white text-transparent opacity-0 group-hover:opacity-100"}`}
            onClick={(e) => {
              e.stopPropagation();
              selectFile(file.driveId, true);
            }}
          >
            <span aria-hidden="true" className="text-[10px] leading-none">
              ✓
            </span>
          </button>
          <div className="relative shrink-0">
            {icon}
            {file.isShared && (
              <SvgIcon
                title="共有中"
                className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full bg-white text-blue-500"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                />
              </SvgIcon>
            )}
          </div>
          <div className="min-w-0 flex-1 overflow-hidden">{nameDisplay}</div>
        </div>
      </td>
      <td className="px-4 py-2.5 align-middle text-sm text-gray-500 dark:text-gray-400">
        {formatDate(file.modifiedTime)}
      </td>
      <td className="px-4 py-2.5 align-middle text-sm text-gray-500 dark:text-gray-400">
        {file.type === "folder"
          ? "ファイル フォルダー"
          : (() => {
              const dot = file.name.lastIndexOf(".");
              return dot > 0
                ? `${file.name.slice(dot + 1).toUpperCase()} ファイル`
                : "ファイル";
            })()}
      </td>
      <td className="px-4 py-2.5 align-middle text-right text-sm tabular-nums text-gray-500 dark:text-gray-400">
        {file.type === "file" ? formatSize(file.size) : "—"}
      </td>
    </tr>
  );
}
