import { useFileStore } from "@/stores/fileStore";
import { useVaultStore } from "@/stores/vaultStore";
import { useEffect, useRef, useState } from "react";

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
  const single = e.dataTransfer.getData("text/plain");
  return single ? [single] : [];
}

export default function Breadcrumb() {
  const folderPath = useFileStore((s) => s.folderPath);
  const navigate = useFileStore((s) => s.navigate);
  const moveFile = useFileStore((s) => s.moveFile);
  const moveFiles = useFileStore((s) => s.moveFiles);
  const currentFolderId = useFileStore((s) => s.currentFolderId);
  const browseMode = useFileStore((s) => s.browseMode);
  const setBrowseMode = useFileStore((s) => s.setBrowseMode);
  const dataFolderId = useVaultStore((s) => s.dataFolderId);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    const keyboardHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowDropdown(false);
      }
    };
    if (showDropdown) {
      document.addEventListener("mousedown", handler);
      window.addEventListener("keydown", keyboardHandler);
    }
    return () => {
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", keyboardHandler);
    };
  }, [showDropdown]);

  const handleDragOver = (e: React.DragEvent, id: string) => {
    if (browseMode === "trash") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverId(id);
  };

  const handleDragLeave = () => setDragOverId(null);

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOverId(null);
    if (browseMode === "trash") return;
    const ids = getDraggedFileIds(e);
    if (ids.length === 0) return;
    const filteredIds = ids.filter((id) => id !== targetId);
    if (filteredIds.length === 0) return;
    const oldParentId = currentFolderId || dataFolderId || "";
    if (filteredIds.length === 1) {
      moveFile(filteredIds[0]!, targetId, oldParentId);
    } else {
      const files = useFileStore.getState().files;
      const moves = filteredIds.map((id) => ({
        fileId: id,
        newParentId: targetId,
        oldParentId: files.find((f) => f.driveId === id)?.parentId ?? oldParentId,
      }));
      moveFiles(moves);
    }
  };

  const rootId = dataFolderId || "";
  const rootLabel =
    browseMode === "trash"
      ? "ゴミ箱"
      : browseMode === "share"
        ? "共有フォルダ"
        : "マイファイル";
  const rootActive = folderPath.length === 0;
  const rootHighlighted = dragOverId === rootId || rootActive;

  const rootIcon =
    browseMode === "trash" ? (
      <svg
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <title>ゴミ箱</title>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
        />
      </svg>
    ) : browseMode === "share" ? (
      <svg
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <title>共有フォルダ</title>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
        />
      </svg>
    ) : (
      <svg
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <title>マイファイル</title>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
        />
      </svg>
    );

  return (
    <nav className="flex min-w-0 items-center gap-1.5 text-sm">
      <div
        className="relative flex shrink-0 items-center gap-1"
        ref={dropdownRef}
      >
        <button
          type="button"
          onClick={() => navigate(null)}
          onDragOver={(e) => handleDragOver(e, rootId)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, rootId)}
          className={`flex items-center gap-2 rounded-full border px-3 py-1.5 transition ${dragOverId === rootId ? "border-blue-300 bg-blue-100 text-blue-700 ring-2 ring-blue-300" : rootActive ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-400" : "border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-600 dark:hover:bg-gray-700"}`}
          aria-current={rootActive ? "page" : undefined}
        >
          {rootIcon}
          <span className="max-w-28 truncate sm:max-w-none">{rootLabel}</span>
        </button>
        <button
          type="button"
          onClick={() => setShowDropdown(!showDropdown)}
          className={`rounded-full border bg-white p-1.5 transition dark:bg-gray-800 ${rootHighlighted ? "border-blue-200 text-blue-600 dark:border-blue-800 dark:text-blue-400" : "border-gray-200 text-gray-500 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"}`}
          aria-label="表示先を切り替える"
          aria-expanded={showDropdown}
        >
          <svg
            className={`h-3.5 w-3.5 transition ${showDropdown ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <title>表示先を切り替える</title>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </button>
        {showDropdown && (
          <div className="absolute left-0 top-full z-50 mt-2 w-44 rounded-2xl border border-gray-200 bg-white py-1.5 shadow-lg dark:border-gray-700 dark:bg-gray-800">
            <button
              type="button"
              onClick={() => {
                setBrowseMode("data");
                setShowDropdown(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700 ${browseMode === "data" ? "font-medium text-blue-600 dark:text-blue-400" : "text-gray-700 dark:text-gray-300"}`}
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <title>マイファイル</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                />
              </svg>
              マイファイル
            </button>
            <button
              type="button"
              onClick={() => {
                setBrowseMode("share");
                setShowDropdown(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700 ${browseMode === "share" ? "font-medium text-blue-600 dark:text-blue-400" : "text-gray-700 dark:text-gray-300"}`}
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <title>共有フォルダ</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                />
              </svg>
              共有フォルダ
            </button>
            <button
              type="button"
              onClick={() => {
                setBrowseMode("trash");
                setShowDropdown(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700 ${browseMode === "trash" ? "font-medium text-blue-600 dark:text-blue-400" : "text-gray-700 dark:text-gray-300"}`}
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <title>ゴミ箱</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
              ゴミ箱
            </button>
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {folderPath.map((item, i) => (
          <span key={item.id} className="inline-flex items-center gap-1">
            <span className="text-gray-400 dark:text-gray-600">/</span>
            {i < folderPath.length - 1 ? (
              <button
                type="button"
                onClick={() => navigate(item.id)}
                onDragOver={(e) => handleDragOver(e, item.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, item.id)}
                className={`rounded px-1 text-blue-600 hover:underline dark:text-blue-400 ${dragOverId === item.id ? "bg-blue-100 ring-2 ring-blue-400" : ""}`}
              >
                {item.name}
              </button>
            ) : (
              <span className="font-medium text-gray-800 dark:text-gray-200">
                {item.name}
              </span>
            )}
          </span>
        ))}
      </div>
    </nav>
  );
}
