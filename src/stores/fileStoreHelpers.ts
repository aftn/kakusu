import {
  DRIVE_NAME_BLOCK_BYTES,
  buildEncryptedDriveName,
  encryptMetadata,
  estimateEncryptedDriveNameLength,
} from "@/crypto/encrypt";
import type { KakusuFile } from "@/types";
import {
  clearSegmentedAppProperty,
  writeSegmentedAppProperty,
} from "@/utils/driveProperties";
import { sanitizeFileName } from "@/utils/preview";

/** Run async tasks with a concurrency limit, reporting progress after each completion */
export async function pooledWithProgress<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  onProgress?: (completed: number, total: number) => void,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let idx = 0;
  let completed = 0;
  async function next(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        const task = tasks[i];
        if (!task) {
          continue;
        }
        results[i] = { status: "fulfilled", value: await task() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
      completed++;
      onProgress?.(completed, tasks.length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => next()),
  );
  return results;
}

export function formatSpeed(bytes: number, startedAt: number): string {
  const elapsed = (Date.now() - startedAt) / 1000;
  if (elapsed <= 0) return "";
  const bps = bytes / elapsed;
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function buildRelativePath(
  file: KakusuFile,
  rootFolderId: string,
  rootFolderName: string,
  filesById: Map<string, KakusuFile>,
): string {
  const parts: string[] = [sanitizeFileName(file.name)];
  let parentId = file.parentId;

  while (parentId && parentId !== rootFolderId) {
    const parent = filesById.get(parentId);
    if (!parent) {
      break;
    }
    parts.unshift(sanitizeFileName(parent.name));
    parentId = parent.parentId;
  }

  parts.unshift(sanitizeFileName(rootFolderName));
  return parts.join("/");
}

export function buildRestorePlan(
  allFiles: KakusuFile[],
  selectedFiles: KakusuFile[],
): KakusuFile[] {
  const filesById = new Map(allFiles.map((file) => [file.driveId, file]));
  const ordered: KakusuFile[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();

  const visit = (file: KakusuFile) => {
    const current = filesById.get(file.driveId) ?? file;
    if (seen.has(current.driveId) || visiting.has(current.driveId)) {
      return;
    }

    visiting.add(current.driveId);

    const parent = filesById.get(current.parentId);
    if (parent?.type === "folder") {
      visit(parent);
    }

    visiting.delete(current.driveId);
    seen.add(current.driveId);
    ordered.push(current);
  };

  for (const file of selectedFiles) {
    visit(file);
  }

  return ordered;
}

/**
 * Verify that the number of decrypted chunks matches the expected total.
 * Throws if the file appears truncated (e.g. interrupted upload).
 * No-op when totalChunks metadata is missing (legacy files).
 */
export function verifyChunkCount(
  actual: number,
  expected: number | undefined,
  fileName: string,
): void {
  if (expected != null && actual !== expected) {
    throw new Error(
      `「${fileName}」のチャンク数が一致しません（期待: ${expected}, 実際: ${actual}）。ファイルが破損または切り詰められている可能性があります。`,
    );
  }
}

type AppPropertyUpdate = Record<string, string | null>;

export async function buildEncryptedMetadataUpdate(
  mekEnc: CryptoKey,
  name: string,
  propertyKey: string,
  ivKey: string,
): Promise<{
  appProperties: AppPropertyUpdate;
  ivMeta: string;
  encNameFull: string;
}> {
  const { encNameFull, ivMeta } = await encryptMetadata(mekEnc, name);
  const appProperties: AppPropertyUpdate = {
    [ivKey]: ivMeta,
  };
  clearSegmentedAppProperty(appProperties, propertyKey);
  writeSegmentedAppProperty(
    appProperties as Record<string, string>,
    propertyKey,
    encNameFull,
  );
  return { appProperties, ivMeta, encNameFull };
}

export async function buildNameEncryptionUpdate(
  mekEnc: CryptoKey,
  name: string,
  encryptName: boolean,
  isFolder = false,
  useV2?: boolean,
): Promise<{ driveName: string; appProperties: AppPropertyUpdate }> {
  if (encryptName) {
    const estLen = estimateEncryptedDriveNameLength(name, isFolder);
    if (estLen > DRIVE_NAME_BLOCK_BYTES) {
      throw new Error(
        `名前が長すぎます（暗号化後 ${estLen} バイト、上限 ${DRIVE_NAME_BLOCK_BYTES}）。短くしてください。`,
      );
    }
    const { appProperties, ivMeta, encNameFull } =
      await buildEncryptedMetadataUpdate(mekEnc, name, "enc_name", "iv_meta");
    appProperties.name_encrypted = "true";
    if (useV2) appProperties.key_version = "2";
    return {
      driveName: buildEncryptedDriveName(ivMeta, encNameFull, isFolder),
      appProperties,
    };
  }

  const appProperties: AppPropertyUpdate = {
    name_encrypted: "false",
    iv_meta: null,
  };
  clearSegmentedAppProperty(appProperties, "enc_name");
  return {
    driveName: isFolder ? name : `${name}.enc`,
    appProperties,
  };
}
