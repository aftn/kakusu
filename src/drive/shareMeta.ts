import type { DriveFile } from "@/types";
import { writeSegmentedAppProperty } from "@/utils/driveProperties";
import * as api from "./api";
import { shareWithAnyone, shareWithUsers } from "./permissions";
import { assertSafeId } from "./validation";

/**
 * Share meta file item: one per shared file.
 */
export interface ShareMetaItem {
  fileId: string;
  wrappedCek: string; // base64url: CEK wrapped with ShareKey (AES-KW)
  encName: string; // base64url: file name encrypted with ShareKey (AES-GCM)
  ivName: string; // base64url: IV for file name encryption
  /** Relative path segments preserving folder structure (e.g. ["sub","nested"]) */
  path?: string[];
}

/**
 * Share meta file JSON structure (stored as file content in share/ folder).
 * Dates use Drive's createdTime/modifiedTime instead of self-managed fields.
 * Share name is encrypted with MEK_enc for owner-only visibility.
 * Status lives in appProperties only.
 */
export interface ShareMetaFile {
  version: 1;
  shareId: string;
  mode: "files" | "folder" | "mixed";
  folders: string[]; // Drive folder IDs (for future diff detection)
  wrappedShareKey: string; // base64url: ShareKey wrapped with MEK_wrap (AES-KW)
  encShareName: string; // base64url: share name encrypted with MEK_enc (AES-GCM)
  ivShareName: string; // base64url: IV for share name encryption
  /** Share name encrypted with ShareKey (AES-GCM) — readable by recipients */
  encShareNameByShareKey?: string; // base64url
  ivShareNameByShareKey?: string; // base64url
  items: ShareMetaItem[];
}

/** Summary info from appProperties (no JSON fetch needed for list view). */
export interface ShareMetaSummary {
  metaFileId: string;
  encShareName: string; // base64url
  ivShareName: string; // base64url
  status: "active" | "disabled";
  itemCount: number;
  createdTime: string; // Drive createdTime
  modifiedTime: string; // Drive modifiedTime
}

/**
 * Create a new share meta file in the share folder.
 * Sets appProperties for lightweight listing.
 * Returns the Drive file ID of the created meta file.
 */
export async function createShareMetaFile(
  shareFolderId: string,
  metaFile: ShareMetaFile,
  encShareName: string,
  ivShareName: string,
): Promise<string> {
  const content = new Blob([JSON.stringify(metaFile)], {
    type: "application/json",
  });
  const appProperties: Record<string, string> = {
    iv_share_name: ivShareName,
    status: "active",
    item_count: String(metaFile.items.length),
  };
  writeSegmentedAppProperty(appProperties, "enc_share_name", encShareName);
  const driveFile = await api.createFileMultipart(
    {
      name: `${metaFile.shareId}.json`,
      parents: [shareFolderId],
      mimeType: "application/json",
      appProperties,
    },
    content,
  );
  return driveFile.id;
}

/**
 * Fetch and parse a share meta file by its Drive file ID.
 */
export async function fetchShareMetaFile(
  metaFileId: string,
): Promise<ShareMetaFile> {
  const content = await api.getFileContent(metaFileId);
  // driveRequest may already parse JSON (content-type: application/json),
  // so handle both parsed object and raw ArrayBuffer.
  const parsed: ShareMetaFile =
    content instanceof ArrayBuffer
      ? (JSON.parse(new TextDecoder().decode(content)) as ShareMetaFile)
      : (content as unknown as ShareMetaFile);
  if (parsed.version !== 1) {
    throw new Error(
      `未対応のメタファイルバージョン: ${String(parsed.version)}`,
    );
  }
  return parsed;
}

/**
 * Update an existing share meta file (overwrite content + appProperties).
 */
export async function updateShareMetaFile(
  metaFileId: string,
  metaFile: ShareMetaFile,
  appPropsUpdate?: Record<string, string>,
): Promise<void> {
  const content = new Blob([JSON.stringify(metaFile)], {
    type: "application/json",
  });
  const metadata: Partial<DriveFile> = {};
  if (appPropsUpdate) {
    metadata.appProperties = appPropsUpdate;
  }
  await api.updateFileWithContent(metaFileId, metadata, content);
}

/**
 * Update only the appProperties of a share meta file (no content change).
 */
export async function updateShareMetaStatus(
  metaFileId: string,
  status: "active" | "disabled",
): Promise<void> {
  await api.updateFileMetadata(metaFileId, {
    appProperties: { status },
  });
}

/**
 * Delete a share meta file (permanent delete).
 */
export async function deleteShareMetaFile(metaFileId: string): Promise<void> {
  await api.deleteFile(metaFileId);
}

/**
 * List all share meta files with appProperties for lightweight listing.
 * Returns Drive file metadata including appProperties.
 */
export async function listShareMetaFiles(
  shareFolderId: string,
): Promise<DriveFile[]> {
  assertSafeId(shareFolderId);
  return api.listAllFiles(
    `'${shareFolderId}' in parents and trashed = false and mimeType = 'application/json'`,
    "files(id,name,size,modifiedTime,createdTime,appProperties)",
  );
}

/**
 * Parse Drive file metadata into ShareMetaSummary (no JSON fetch needed).
 */
export function parseShareMetaSummary(
  driveFile: DriveFile,
): ShareMetaSummary | null {
  const ap = driveFile.appProperties;
  if (!ap?.iv_share_name || !ap.status) return null;
  const encShareName = readSegmentedShareName(ap);
  if (!encShareName) return null;
  return {
    metaFileId: driveFile.id,
    encShareName,
    ivShareName: ap.iv_share_name,
    status: ap.status === "disabled" ? "disabled" : "active",
    itemCount: Number(ap.item_count ?? "0"),
    createdTime:
      (driveFile as { createdTime?: string }).createdTime ??
      driveFile.modifiedTime ??
      "",
    modifiedTime: driveFile.modifiedTime ?? "",
  };
}

/** Read segmented enc_share_name from appProperties. */
function readSegmentedShareName(ap: Record<string, string>): string | null {
  let result = ap.enc_share_name;
  if (!result) return null;
  for (let i = 2; i <= 10; i++) {
    const part = ap[`enc_share_name_${i}`];
    if (!part) break;
    result += part;
  }
  return result;
}

/**
 * Set up public read permission on a share meta file
 * so recipients can access it with the URL.
 */
export async function setShareMetaPermission(
  metaFileId: string,
  mode: "link" | "email",
  email?: string,
  expirationTime?: string,
): Promise<void> {
  if (mode === "link") {
    await shareWithAnyone(metaFileId, expirationTime);
  } else if (mode === "email" && email) {
    const emails = email
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    await shareWithUsers(metaFileId, emails, expirationTime);
  }
}

/**
 * Set up read permission on data files referenced in the meta file.
 * Recipients need to be able to download the encrypted file content.
 */
export async function setShareDataPermissions(
  items: ShareMetaItem[],
  folders: string[],
  mode: "link" | "email",
  email?: string,
  expirationTime?: string,
): Promise<void> {
  const fileIds = items.map((item) => item.fileId);
  const allIds = [...fileIds, ...folders];

  const emails = email
    ? email
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean)
    : [];

  const CONCURRENCY = 8;
  const tasks = allIds.map((id) => async () => {
    if (mode === "link") {
      await shareWithAnyone(id, expirationTime);
    } else if (mode === "email" && emails.length > 0) {
      await shareWithUsers(id, emails, expirationTime);
    }
  });

  // Run permission grants in parallel with bounded concurrency
  const executing = new Set<Promise<void>>();
  for (const task of tasks) {
    const p = task().then(() => {
      executing.delete(p);
    });
    executing.add(p);
    if (executing.size >= CONCURRENCY) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}
