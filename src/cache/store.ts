import type { CachedFile, KakusuFile } from "@/types";
import { fromBase64, toBase64 } from "@/utils/base64url";
import { clearDatabase, getDB } from "./db";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isCachedKakusuFile(value: unknown): value is KakusuFile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.driveId === "string" &&
    typeof candidate.parentId === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.nameEncrypted === "boolean" &&
    (candidate.type === "file" || candidate.type === "folder") &&
    typeof candidate.modifiedTime === "string" &&
    (candidate.size === undefined || typeof candidate.size === "number") &&
    (candidate.encName === undefined ||
      typeof candidate.encName === "string") &&
    (candidate.encName2 === undefined ||
      typeof candidate.encName2 === "string") &&
    (candidate.ivMeta === undefined || typeof candidate.ivMeta === "string") &&
    (candidate.wrappedCek === undefined ||
      typeof candidate.wrappedCek === "string") &&
    (candidate.ivBody === undefined || typeof candidate.ivBody === "string") &&
    (candidate.isShared === undefined ||
      typeof candidate.isShared === "boolean") &&
    (candidate.pending === undefined || typeof candidate.pending === "boolean")
  );
}

async function encryptFolderListing(
  files: KakusuFile[],
  mekEnc: CryptoKey,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(files));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    mekEnc,
    plaintext,
  );

  return {
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    iv: toBase64(iv),
  };
}

async function decryptFolderListing(
  ciphertext: string,
  iv: string,
  mekEnc: CryptoKey,
): Promise<KakusuFile[] | null> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    mekEnc,
    fromBase64(ciphertext),
  );
  const parsed = JSON.parse(decoder.decode(decrypted));
  if (!Array.isArray(parsed)) return null;
  const files = parsed.filter(isCachedKakusuFile);
  return files.length === parsed.length ? files : null;
}

export async function putFile(file: CachedFile): Promise<void> {
  const db = await getDB();
  await db.put("files", file);
}

export async function getFile(
  driveId: string,
): Promise<CachedFile | undefined> {
  const db = await getDB();
  return db.get("files", driveId);
}

export async function getFilesByParent(
  parentId: string,
): Promise<CachedFile[]> {
  const db = await getDB();
  return db.getAllFromIndex("files", "by-parent", parentId);
}

export async function deleteFile(driveId: string): Promise<void> {
  const db = await getDB();
  await db.delete("files", driveId);
}

export async function getAllFiles(): Promise<CachedFile[]> {
  const db = await getDB();
  return db.getAll("files");
}

export async function clearAllFiles(): Promise<void> {
  await clearDatabase();
}

export async function getLastChangeToken(): Promise<string | null> {
  const db = await getDB();
  const value = await db.get("meta", "lastChangeToken");
  return value ?? null;
}

export async function setLastChangeToken(token: string): Promise<void> {
  const db = await getDB();
  await db.put("meta", token, "lastChangeToken");
}

// ── Folder listing cache ──

export async function getCachedFolderListing(
  folderId: string,
  mekEnc: CryptoKey,
  maxAgeMs: number,
): Promise<KakusuFile[] | null> {
  try {
    if (maxAgeMs <= 0) return null;
    const db = await getDB();
    const entry = await db.get("folderListings", folderId);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > maxAgeMs) {
      await db.delete("folderListings", folderId);
      return null;
    }
    return await decryptFolderListing(entry.files, entry.iv, mekEnc);
  } catch (e) {
    console.warn("Cache: failed to read folder listing", e);
    return null;
  }
}

export async function setCachedFolderListing(
  folderId: string,
  files: KakusuFile[],
  mekEnc: CryptoKey,
): Promise<void> {
  try {
    const db = await getDB();
    const encrypted = await encryptFolderListing(files, mekEnc);
    await db.put("folderListings", {
      folderId,
      files: encrypted.ciphertext,
      iv: encrypted.iv,
      cachedAt: Date.now(),
    });
  } catch (e) {
    console.warn("Cache: failed to write folder listing", e);
  }
}

export async function deleteCachedFolderListing(
  folderId: string,
): Promise<void> {
  try {
    const db = await getDB();
    await db.delete("folderListings", folderId);
  } catch (e) {
    console.warn("Cache: failed to delete folder listing", e);
  }
}
