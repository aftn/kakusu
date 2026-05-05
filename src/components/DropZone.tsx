import { type ReactNode, useCallback, useRef, useState } from "react";

export interface FolderEntry {
  file: File;
  relativePath: string;
}

interface DropZoneProps {
  onDrop: (files: File[]) => void;
  onDropFolder?: (entries: FolderEntry[]) => void;
  children: ReactNode;
}

/**
 * Check if a drag event is an external file drop (from OS) vs an internal move.
 * Internal moves set 'text/plain' with a driveId; external drops contain 'Files'.
 */
function isExternalFileDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes("Files");
}

/**
 * Recursively read all files from a FileSystemDirectoryEntry
 */
function readDirectoryEntries(
  dirEntry: FileSystemDirectoryEntry,
): Promise<FolderEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: FolderEntry[] = [];
    const reader = dirEntry.createReader();
    const readBatch = () => {
      reader.readEntries(async (batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        for (const entry of batch) {
          if (entry.isFile) {
            const fileEntry = entry as FileSystemFileEntry;
            const file = await new Promise<File>((res, rej) =>
              fileEntry.file(res, rej),
            );
            entries.push({
              file,
              relativePath: entry.fullPath.replace(/^\//, ""),
            });
          } else if (entry.isDirectory) {
            const subEntries = await readDirectoryEntries(
              entry as FileSystemDirectoryEntry,
            );
            entries.push(...subEntries);
          }
        }
        // readEntries may return results in batches
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

export default function DropZone({
  onDrop,
  onDropFolder,
  children,
}: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      // Only handle external file drops; let internal moves bubble through
      if (!isExternalFileDrag(e)) return;

      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragging(false);

      // Check for folder entries via webkitGetAsEntry
      const items = e.dataTransfer.items;
      if (onDropFolder && items && items.length > 0) {
        const folderEntries: FolderEntry[] = [];
        const plainFiles: File[] = [];
        let hasFolders = false;

        const entryPromises: Promise<void>[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (!item || item.kind !== "file") continue;
          const entry = item.webkitGetAsEntry?.();
          if (entry?.isDirectory) {
            hasFolders = true;
            entryPromises.push(
              readDirectoryEntries(entry as FileSystemDirectoryEntry).then(
                (entries) => {
                  folderEntries.push(...entries);
                },
              ),
            );
          } else {
            const file = item.getAsFile();
            if (file) plainFiles.push(file);
          }
        }

        if (hasFolders) {
          await Promise.all(entryPromises);
          if (folderEntries.length > 0) {
            onDropFolder(folderEntries);
          }
          // Also upload any plain files dropped alongside
          if (plainFiles.length > 0) {
            onDrop(plainFiles);
          }
          return;
        }
      }

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        onDrop(files);
      }
    },
    [onDrop, onDropFolder],
  );

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={`relative min-h-[400px] rounded-lg transition ${
        isDragging
          ? "border-2 border-dashed border-blue-400 bg-blue-50 dark:bg-blue-900/20"
          : "border-2 border-transparent"
      }`}
    >
      {children}
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg bg-blue-50/90 dark:bg-blue-900/80">
          <div className="text-center">
            <svg
              className="mx-auto mb-2 h-12 w-12 text-blue-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <title>ファイルをドロップ</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
              />
            </svg>
            <p className="text-lg font-medium text-blue-600">
              ここにドロップしてアップロード（フォルダも可）
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
