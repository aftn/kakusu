import { useFileStore } from "@/stores/fileStore";
import type { KakusuFile } from "@/types";
import { useCallback } from "react";

export function useDownload() {
  const download = useFileStore((s) => s.download);
  const downloadFolder = useFileStore((s) => s.downloadFolder);

  const handleDownload = useCallback(
    (file: KakusuFile) => {
      // Fire-and-forget: toast handles progress/errors
      if (file.type === "folder") {
        downloadFolder(file);
      } else {
        download(file);
      }
    },
    [download, downloadFolder],
  );

  return { handleDownload };
}
