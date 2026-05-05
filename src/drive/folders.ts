import { FOLDER_MIME } from "@/types";
import type { DriveFile } from "@/types";
import * as api from "./api";
import { assertSafeId } from "./validation";

/**
 * Create a folder in Drive
 */
export async function createFolder(
  parentId: string,
  name: string,
  appProperties?: Record<string, string>,
): Promise<DriveFile> {
  assertSafeId(parentId);
  return api.createFileMultipart({
    name,
    mimeType: FOLDER_MIME,
    parents: [parentId],
    appProperties,
  });
}

/**
 * List subfolders
 */
export async function listFolders(parentId: string): Promise<DriveFile[]> {
  assertSafeId(parentId);
  return api.listAllFiles(
    `'${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
    "files(id,name,appProperties)",
  );
}
