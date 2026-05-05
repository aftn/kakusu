import { getEffectiveParallelCount } from "@/cache/settings";
import { RESUMABLE_UPLOAD_THRESHOLD_BYTES } from "@/config/app";
import { computeEncryptedSize } from "@/crypto/chunk";
import { useFileStore } from "@/stores/fileStore";
import { useUIStore } from "@/stores/uiStore";
import { useCallback } from "react";

/** Run promises with a concurrency limit, propagating the first error */
async function pooled<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<void> {
  const errors: unknown[] = [];
  let idx = 0;
  async function next(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        await tasks[i]?.();
      } catch (reason) {
        errors.push(reason);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => next()),
  );
  // Individual upload() calls already show error toasts.
  // Re-throw the first non-abort error so callers know the operation failed.
  const realError = errors.find(
    (e) =>
      !(e instanceof DOMException && (e as DOMException).name === "AbortError"),
  );
  if (realError) throw realError;
}

export function useUpload() {
  const upload = useFileStore((s) => s.upload);
  const refresh = useFileStore((s) => s.refresh);
  const defaultEncryptName = useUIStore((s) => s.defaultEncryptName);

  const handleUpload = useCallback(
    async (files: FileList | File[], encryptName?: boolean) => {
      const enc = encryptName ?? defaultEncryptName;
      const fileArray = Array.from(files);
      if (fileArray.length === 0) {
        return;
      }

      const isBatch = fileArray.length >= 3;
      const { addToast, updateToast } = useUIStore.getState();

      let batchTid: string | undefined;
      if (isBatch) {
        batchTid = addToast({
          message: `${fileArray.length}件のファイルをアップロード中... (0/${fileArray.length})`,
          type: "progress",
          percent: 0,
          startedAt: Date.now(),
        });
      }

      // Split files into large (resumable/streaming) and small (multipart) groups
      // so they can be processed with different concurrency strategies simultaneously.
      const largeFiles = fileArray.filter(
        (f) => computeEncryptedSize(f.size) > RESUMABLE_UPLOAD_THRESHOLD_BYTES,
      );
      const smallFiles = fileArray.filter(
        (f) => computeEncryptedSize(f.size) <= RESUMABLE_UPLOAD_THRESHOLD_BYTES,
      );

      const effectiveParallel = getEffectiveParallelCount(20);
      // HTTP/2 multiplexing allows many concurrent streams.
      // encryption (CPU) runs freely in parallel; API calls are globally
      // rate-limited by the token bucket in api.ts, so raising the
      // concurrency limit beyond 6 no longer risks quota errors.
      const smallConcurrency = Math.min(
        smallFiles.length,
        Math.max(4, Math.min(20, effectiveParallel * 2)),
      );

      let uploadedCount = 0;
      let failedCount = 0;
      let batchError: unknown = null;

      const onFileComplete = (success: boolean) => {
        if (success) uploadedCount++;
        else failedCount++;
        if (isBatch && batchTid) {
          const done = uploadedCount + failedCount;
          const percent = Math.round((done / fileArray.length) * 100);
          updateToast(batchTid, {
            message: `${fileArray.length}件のファイルをアップロード中... (${done}/${fileArray.length})`,
            percent,
          });
        }
      };

      try {
        // Run both pipelines simultaneously:
        // - Small files: concurrent (up to smallConcurrency)
        // - Large files: serial (1 at a time, streaming resumable upload)
        const pipelines: Promise<void>[] = [];

        if (smallFiles.length > 0) {
          pipelines.push(
            pooled(
              smallFiles.map((file) => async () => {
                try {
                  await upload(file, enc, {
                    refreshAfterUpload: false,
                    suppressToast: isBatch,
                  });
                  onFileComplete(true);
                } catch {
                  onFileComplete(false);
                  throw new Error("upload failed");
                }
              }),
              smallConcurrency,
            ),
          );
        }

        if (largeFiles.length > 0) {
          pipelines.push(
            pooled(
              largeFiles.map((file) => async () => {
                try {
                  await upload(file, enc, {
                    refreshAfterUpload: false,
                    suppressToast: isBatch,
                  });
                  onFileComplete(true);
                } catch {
                  onFileComplete(false);
                  throw new Error("upload failed");
                }
              }),
              1,
            ),
          );
        }

        const results = await Promise.allSettled(pipelines);
        const rejected = results.find((r) => r.status === "rejected") as
          | PromiseRejectedResult
          | undefined;
        if (rejected) {
          throw rejected.reason;
        }
      } catch (error) {
        batchError = error;
      }

      await refresh();

      if (isBatch && batchTid) {
        if (failedCount === 0) {
          updateToast(batchTid, {
            message: `${uploadedCount}件のファイルをアップロードしました`,
            type: "success",
            percent: 100,
          });
        } else {
          updateToast(batchTid, {
            message: `${uploadedCount}件成功、${failedCount}件失敗`,
            type: failedCount === fileArray.length ? "error" : "success",
            percent: 100,
          });
        }
      }

      if (batchError) {
        throw batchError;
      }
    },
    [upload, refresh, defaultEncryptName],
  );

  return { handleUpload };
}
