import { DRIVE_APP_PROPERTY_KEYS, MAX_RECURSION_DEPTH } from "@/config/app";
import { decryptMetadataFromProperties } from "@/crypto/decrypt";
import { FOLDER_MIME } from "@/types";
import type { DriveFile, KakusuFile } from "@/types";
import { readSegmentedAppProperty } from "@/utils/driveProperties";
import { DriveAPIError } from "@/utils/errors";
import {
  listDataFiles as listDriveDataFiles,
  listTrashedKakusuFiles,
} from "./files";

/**
 * Convert Drive metadata into a Kakusu file entry.
 * nameKey is used for key_version="2" files; mekEnc for legacy files.
 */
export async function driveFileToKakusuFile(
  driveFile: DriveFile,
  mekEnc: CryptoKey,
  nameKey?: CryptoKey | null,
): Promise<KakusuFile> {
  const props = driveFile.appProperties || {};
  const isFolder = driveFile.mimeType === FOLDER_MIME;
  const nameEncrypted = props.name_encrypted === "true";
  const isShared = props?.[DRIVE_APP_PROPERTY_KEYS.shared] === "true";
  const kv = props.key_version;

  // Choose the correct decryption key based on key_version
  const decKey = kv === "2" && nameKey ? nameKey : mekEnc;

  let name: string;
  if (nameEncrypted && props.enc_name && props.iv_meta) {
    name =
      (await decryptMetadataFromProperties(
        decKey,
        props,
        "enc_name",
        "iv_meta",
      )) || driveFile.name;
  } else if (isShared && props.owner_enc_name && props.owner_iv_meta) {
    // Shared files: decrypt owner-encrypted filename with the appropriate key
    try {
      name =
        (await decryptMetadataFromProperties(
          decKey,
          props,
          "owner_enc_name",
          "owner_iv_meta",
        )) || driveFile.name;
    } catch {
      // Fallback: strip .enc extension
      name = driveFile.name.endsWith(".enc")
        ? driveFile.name.slice(0, -4)
        : driveFile.name;
    }
  } else if (isFolder) {
    // Remove .enc extension from unencrypted folders (new naming format)
    name = driveFile.name.endsWith(".enc")
      ? driveFile.name.slice(0, -4)
      : driveFile.name;
  } else {
    // Remove .enc extension
    name = driveFile.name.endsWith(".enc")
      ? driveFile.name.slice(0, -4)
      : driveFile.name;
  }

  return {
    driveId: driveFile.id,
    parentId: driveFile.parents?.[0] ?? "",
    name,
    nameEncrypted,
    type: isFolder ? "folder" : "file",
    size: driveFile.size ? Number(driveFile.size) : undefined,
    modifiedTime: driveFile.modifiedTime ?? new Date().toISOString(),
    encName: readSegmentedAppProperty(props, "enc_name"),
    encName2: props.enc_name_2,
    ivMeta: props.iv_meta,
    wrappedCek: props.wrapped_cek,
    ivBody: props.iv_body,
    keyVersion: kv,
    totalChunks: props.total_chunks ? Number(props.total_chunks) : undefined,
    isShared,
  };
}

/**
 * Sync file tree for a given folder
 */
export async function syncFileTree(
  folderId: string,
  mekEnc: CryptoKey,
  nameKey?: CryptoKey | null,
): Promise<KakusuFile[]> {
  const driveFiles = await listDriveDataFiles(folderId);

  const kakusuFiles = await Promise.all(
    driveFiles.map((f) => driveFileToKakusuFile(f, mekEnc, nameKey)),
  );

  return kakusuFiles;
}

/**
 * Recursively sync all files from data/
 */
export async function syncAllFiles(
  dataFolderId: string,
  mekEnc: CryptoKey,
  nameKey?: CryptoKey | null,
): Promise<KakusuFile[]> {
  const allFiles: KakusuFile[] = [];
  const queue: Array<{ id: string; depth: number }> = [
    { id: dataFolderId, depth: 0 },
  ];

  while (queue.length > 0) {
    const { id: folderId, depth } = queue.shift()!;
    if (depth > MAX_RECURSION_DEPTH) {
      throw new DriveAPIError(
        `Sync depth exceeded ${MAX_RECURSION_DEPTH}`,
        400,
      );
    }
    const files = await syncFileTree(folderId, mekEnc, nameKey);
    allFiles.push(...files);

    // Queue subfolders
    for (const file of files) {
      if (file.type === "folder") {
        queue.push({ id: file.driveId, depth: depth + 1 });
      }
    }
  }

  return allFiles;
}

/**
 * Sync trashed Kakusu files
 */
export async function syncTrashedFiles(
  mekEnc: CryptoKey,
  nameKey?: CryptoKey | null,
): Promise<KakusuFile[]> {
  const driveFiles = await listTrashedKakusuFiles();

  const results = await Promise.allSettled(
    driveFiles.map((f) => driveFileToKakusuFile(f, mekEnc, nameKey)),
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<KakusuFile> => r.status === "fulfilled",
    )
    .map((r) => r.value);
}
