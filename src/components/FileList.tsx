import { useUIStore } from "@/stores/uiStore";
import type { KakusuFile } from "@/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import FileItem from "./FileItem";

interface FileListProps {
  files: KakusuFile[];
  viewMode: "list" | "grid";
  sortBy: "name" | "size" | "date" | "type";
  sortOrder: "asc" | "desc";
  onSort: (field: "name" | "size" | "date" | "type") => void;
}

type ColumnKey = "name" | "date" | "type" | "size";
type ColumnWidths = Record<ColumnKey, number>;

const COLUMN_WIDTHS_STORAGE_KEY = "kakusu:file-list-column-widths";
const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  name: 420,
  date: 190,
  type: 160,
  size: 110,
};
const MIN_COLUMN_WIDTHS: ColumnWidths = {
  name: 260,
  date: 176,
  type: 120,
  size: 96,
};

function loadColumnWidths(): ColumnWidths {
  if (typeof window === "undefined") {
    return DEFAULT_COLUMN_WIDTHS;
  }

  try {
    const raw = window.localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_COLUMN_WIDTHS;
    }

    const parsed = JSON.parse(raw) as Partial<ColumnWidths>;
    return {
      name:
        typeof parsed.name === "number" && Number.isFinite(parsed.name)
          ? Math.max(parsed.name, MIN_COLUMN_WIDTHS.name)
          : DEFAULT_COLUMN_WIDTHS.name,
      date:
        typeof parsed.date === "number" && Number.isFinite(parsed.date)
          ? Math.max(parsed.date, MIN_COLUMN_WIDTHS.date)
          : DEFAULT_COLUMN_WIDTHS.date,
      type:
        typeof parsed.type === "number" && Number.isFinite(parsed.type)
          ? Math.max(parsed.type, MIN_COLUMN_WIDTHS.type)
          : DEFAULT_COLUMN_WIDTHS.type,
      size:
        typeof parsed.size === "number" && Number.isFinite(parsed.size)
          ? Math.max(parsed.size, MIN_COLUMN_WIDTHS.size)
          : DEFAULT_COLUMN_WIDTHS.size,
    };
  } catch {
    return DEFAULT_COLUMN_WIDTHS;
  }
}

export default function FileList({
  files,
  viewMode,
  sortBy,
  sortOrder,
  onSort,
}: FileListProps) {
  const selectedIds = useUIStore((s) => s.selectedIds);
  const selectFile = useUIStore((s) => s.selectFile);
  const selectAll = useUIStore((s) => s.selectAll);
  const clearSelection = useUIStore((s) => s.clearSelection);
  const selectRange = useUIStore((s) => s.selectRange);
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(() =>
    loadColumnWidths(),
  );

  const allSelected =
    files.length > 0 && files.every((f) => selectedIds.has(f.driveId));

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      COLUMN_WIDTHS_STORAGE_KEY,
      JSON.stringify(columnWidths),
    );
  }, [columnWidths]);

  const totalTableWidth = useMemo(
    () =>
      Object.values(columnWidths).reduce((total, width) => total + width, 0),
    [columnWidths],
  );

  const handleSelectAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (allSelected) {
      clearSelection();
    } else {
      selectAll(files.map((f) => f.driveId));
    }
  };

  const handleSelect = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey) {
      const { lastSelectedId } = useUIStore.getState();
      if (lastSelectedId) {
        const startIdx = files.findIndex((f) => f.driveId === lastSelectedId);
        const endIdx = files.findIndex((f) => f.driveId === id);
        if (startIdx >= 0 && endIdx >= 0) {
          const [from, to] = [
            Math.min(startIdx, endIdx),
            Math.max(startIdx, endIdx),
          ];
          const rangeIds = files.slice(from, to + 1).map((f) => f.driveId);
          selectRange(rangeIds, e.ctrlKey || e.metaKey);
          return;
        }
      }
    }
    selectFile(id, e.ctrlKey || e.metaKey);
  };

  const sortIndicator = (field: "name" | "size" | "date" | "type") => {
    if (sortBy !== field) return null;
    return (
      <span className="ml-1 text-[10px] text-gray-700">
        {sortOrder === "asc" ? "▲" : "▼"}
      </span>
    );
  };

  const adjustColumnWidth = useCallback((column: ColumnKey, delta: number) => {
    setColumnWidths((current) => {
      const nextWidth = Math.max(
        MIN_COLUMN_WIDTHS[column],
        current[column] + delta,
      );
      return current[column] === nextWidth
        ? current
        : { ...current, [column]: nextWidth };
    });
  }, []);

  const startResize = useCallback(
    (column: ColumnKey, event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = columnWidths[column];
      const minWidth = MIN_COLUMN_WIDTHS[column];
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const nextWidth = Math.max(minWidth, startWidth + deltaX);
        setColumnWidths((current) =>
          current[column] === nextWidth
            ? current
            : { ...current, [column]: nextWidth },
        );
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    },
    [columnWidths],
  );

  const handleResizeKeyDown = useCallback(
    (column: ColumnKey, event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      adjustColumnWidth(column, event.key === "ArrowLeft" ? -16 : 16);
    },
    [adjustColumnWidth],
  );

  const renderResizeHandle = (column: ColumnKey) => (
    <button
      type="button"
      className="absolute inset-y-0 right-0 z-10 flex w-2.5 cursor-col-resize touch-none items-center justify-center"
      onPointerDown={(event) => startResize(column, event)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => handleResizeKeyDown(column, event)}
      aria-label={`${column}列の幅を変更`}
    >
      <span className="h-5 w-px rounded-full bg-gray-300 transition group-hover:bg-gray-500 dark:bg-gray-600 dark:group-hover:bg-gray-400" />
    </button>
  );

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-400 dark:text-gray-500">
        <svg
          className="mb-4 h-16 w-16"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <title>空のフォルダ</title>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1}
            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
          />
        </svg>
        <p>ファイルがありません</p>
        <p className="text-sm">
          ドラッグ&ドロップ または アップロードボタンでファイルを追加
        </p>
      </div>
    );
  }

  if (viewMode === "grid") {
    return (
      <div
        data-file-list
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
      >
        {files.map((file) => (
          <FileItem
            key={file.driveId}
            file={file}
            viewMode="grid"
            selected={selectedIds.has(file.driveId)}
            onSelect={handleSelect}
          />
        ))}
      </div>
    );
  }

  return (
    <div data-file-list>
      {/* モバイル：コンパクトリスト */}
      <div className="divide-y divide-gray-100 overflow-hidden rounded-md border border-gray-200 bg-white sm:hidden dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800">
        {files.map((file) => (
          <FileItem
            key={file.driveId}
            file={file}
            viewMode="list"
            selected={selectedIds.has(file.driveId)}
            onSelect={handleSelect}
            compact
          />
        ))}
      </div>
      {/* デスクトップ：テーブル */}
      <div className="hidden overflow-hidden rounded-md border border-gray-300 bg-white sm:block dark:border-gray-700 dark:bg-gray-800">
        <div className="overflow-x-auto">
          <table
            className="w-full table-fixed border-separate border-spacing-0"
            style={{ minWidth: `${Math.max(totalTableWidth, 760)}px` }}
          >
            <colgroup>
              <col style={{ width: columnWidths.name }} />
              <col style={{ width: columnWidths.date }} />
              <col style={{ width: columnWidths.type }} />
              <col style={{ width: columnWidths.size }} />
            </colgroup>
            <thead className="text-left text-[13px] font-normal text-gray-700 dark:text-gray-300">
              <tr>
                <th className="group relative border-b border-gray-300 bg-white px-4 py-2.5 dark:border-gray-700 dark:bg-gray-800">
                  <div className="flex items-center gap-3 pr-3">
                    <button
                      type="button"
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition ${
                        allSelected
                          ? "border-blue-500 bg-blue-500 text-white"
                          : "border-gray-300 bg-white text-transparent hover:border-gray-500 dark:border-gray-600 dark:bg-gray-700 dark:hover:border-gray-400"
                      }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleSelectAll(event);
                      }}
                      aria-label={
                        allSelected ? "すべての選択を解除" : "すべて選択"
                      }
                    >
                      <span
                        aria-hidden="true"
                        className="text-[10px] leading-none"
                      >
                        ✓
                      </span>
                    </button>
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-[13px] font-normal text-gray-700 dark:text-gray-300 transition group-hover:text-black"
                      onClick={() => onSort("name")}
                    >
                      <span className="select-none">
                        名前{sortIndicator("name")}
                      </span>
                    </button>
                  </div>
                  {renderResizeHandle("name")}
                </th>
                <th className="group relative border-b border-gray-300 bg-white px-4 py-2.5 dark:border-gray-700 dark:bg-gray-800">
                  <button
                    type="button"
                    className="w-full select-none pr-3 text-left text-[13px] font-normal text-gray-700 dark:text-gray-300 transition group-hover:text-black"
                    onClick={() => onSort("date")}
                  >
                    更新日時{sortIndicator("date")}
                  </button>
                  {renderResizeHandle("date")}
                </th>
                <th className="group relative border-b border-gray-300 bg-white px-4 py-2.5 dark:border-gray-700 dark:bg-gray-800">
                  <button
                    type="button"
                    className="w-full select-none pr-3 text-left text-[13px] font-normal text-gray-700 dark:text-gray-300 transition group-hover:text-black"
                    onClick={() => onSort("type")}
                  >
                    種類{sortIndicator("type")}
                  </button>
                  {renderResizeHandle("type")}
                </th>
                <th className="group relative border-b border-gray-300 bg-white px-4 py-2.5 dark:border-gray-700 dark:bg-gray-800 text-right">
                  <button
                    type="button"
                    className="w-full select-none pr-3 text-right text-[13px] font-normal text-gray-700 transition group-hover:text-black dark:text-gray-300 dark:group-hover:text-white"
                    onClick={() => onSort("size")}
                  >
                    サイズ{sortIndicator("size")}
                  </button>
                  {renderResizeHandle("size")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {files.map((file) => (
                <FileItem
                  key={file.driveId}
                  file={file}
                  viewMode="list"
                  selected={selectedIds.has(file.driveId)}
                  onSelect={handleSelect}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
