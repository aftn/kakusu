import { APP_SLUG, DRIVE_APP_PROPERTY_KEYS } from "@/config/app";
import { FOLDER_MIME } from "@/types";
import type { DriveFile, SyncedSettings } from "@/types";
import { fromBase64, toBase64 } from "@/utils/base64url";
import * as api from "./api";
import { assertSafeId } from "./validation";

/** Name of the master metadata file on Google Drive */
export const META_FILE_NAME = "DO_NOT_DELETE.json";

/**
 * Find the Kakusu root folder by appProperties marker.
 */
export async function findRoot(): Promise<DriveFile | null> {
  const files = await api.listAllFiles(
    `mimeType='application/vnd.google-apps.folder' and (appProperties has { key='${DRIVE_APP_PROPERTY_KEYS.rootMarker}' and value='true' }) and trashed=false`,
    "files(id,name,createdTime,appProperties)",
  );
  if (files.length === 0) return null;
  if (files.length === 1) return files[0]!;
  // 複数のルートフォルダが見つかった場合はもっとも新しいフォルダを使う
  files.sort((a, b) => {
    const ta = a.createdTime ? new Date(a.createdTime).getTime() : 0;
    const tb = b.createdTime ? new Date(b.createdTime).getTime() : 0;
    return tb - ta;
  });
  return files[0]!;
}

export type { SyncedSettings } from "@/types";

/**
 * Find data/, share/ subfolders and DO_NOT_DELETE under root in a single query.
 * Returns dataId, shareId, salt, optional verify metadata, and synced settings.
 */
export async function findRootChildren(rootId: string): Promise<{
  dataId: string | null;
  shareId: string | null;
  salt: Uint8Array | null;
  metaFileId: string | null;
  verifyIv: Uint8Array | null;
  wrappedVaultKey: Uint8Array | null;
  wrappedNameKey: Uint8Array | null;
  syncedSettings: SyncedSettings | null;
}> {
  assertSafeId(rootId);
  const files = await api.listAllFiles(
    `'${rootId}' in parents and trashed=false`,
    "files(id,name,mimeType,appProperties)",
  );

  let dataId: string | null = null;
  let shareId: string | null = null;
  let salt: Uint8Array | null = null;
  let metaFileId: string | null = null;
  let verifyIv: Uint8Array | null = null;
  let wrappedVaultKey: Uint8Array | null = null;
  let wrappedNameKey: Uint8Array | null = null;
  let syncedSettings: SyncedSettings | null = null;

  for (const f of files) {
    if (f.name === "data" && f.mimeType === FOLDER_MIME) dataId = f.id;
    else if (f.name === "share" && f.mimeType === FOLDER_MIME) shareId = f.id;
    else if (f.name === META_FILE_NAME) {
      metaFileId = f.id;
      const props = f.appProperties;
      const encodedSalt = props?.[DRIVE_APP_PROPERTY_KEYS.salt];
      if (encodedSalt) {
        salt = fromBase64(encodedSalt);
      }
      if (props?.verify_iv) {
        verifyIv = fromBase64(props.verify_iv);
      }
      if (props?.wrapped_vault_key) {
        wrappedVaultKey = fromBase64(props.wrapped_vault_key);
      }
      if (props?.wrapped_name_key) {
        wrappedNameKey = fromBase64(props.wrapped_name_key);
      }
      syncedSettings = parseSettingsFromProps(props);
    }
  }

  return {
    dataId,
    shareId,
    salt,
    metaFileId,
    verifyIv,
    wrappedVaultKey,
    wrappedNameKey,
    syncedSettings,
  };
}

function parseSettingsFromProps(
  props?: Record<string, string>,
): SyncedSettings | null {
  if (!props) return null;
  const has =
    props.s_encrypt_name ||
    props.s_meta_cache ||
    props.s_preview_cache ||
    props.s_auto_popup_login;
  if (!has) return null;
  return {
    encryptName:
      props.s_encrypt_name === "true"
        ? true
        : props.s_encrypt_name === "false"
          ? false
          : undefined,
    metadataCacheMode: props.s_meta_cache || undefined,
    previewCacheMode: props.s_preview_cache || undefined,
    autoPopupLogin:
      props.s_auto_popup_login === "true"
        ? true
        : props.s_auto_popup_login === "false"
          ? false
          : undefined,
  };
}

/**
 * Update synced settings in DO_NOT_DELETE appProperties.
 */
export async function updateKakusuMetaSettings(
  metaFileId: string,
  settings: SyncedSettings,
): Promise<void> {
  assertSafeId(metaFileId);
  const appProperties: Record<string, string> = {};
  if (settings.encryptName !== undefined)
    appProperties.s_encrypt_name = String(settings.encryptName);
  if (settings.metadataCacheMode !== undefined)
    appProperties.s_meta_cache = settings.metadataCacheMode;
  if (settings.previewCacheMode !== undefined)
    appProperties.s_preview_cache = settings.previewCacheMode;
  if (settings.autoPopupLogin !== undefined)
    appProperties.s_auto_popup_login = String(settings.autoPopupLogin);
  await api.updateFileMetadata(metaFileId, { appProperties });
}

/**
 * Get verify ciphertext from a DO_NOT_DELETE file (JSON format).
 */
export async function getVerifyFromMeta(
  metaFileId: string,
  iv: Uint8Array,
): Promise<{ fileId: string; ciphertext: ArrayBuffer; iv: Uint8Array }> {
  assertSafeId(metaFileId);
  const raw = await api.getFileContent(metaFileId);
  const text = new TextDecoder().decode(raw);
  const json: VaultMetaJson = JSON.parse(text);
  return {
    fileId: metaFileId,
    ciphertext: fromBase64(json.verify_ciphertext).buffer,
    iv: json.verify_iv ? fromBase64(json.verify_iv) : iv,
  };
}

/**
 * Create the initial folder structure
 */
export async function createRootStructure(): Promise<{
  rootId: string;
  dataId: string;
  shareId: string;
}> {
  const appProperties: Record<string, string> = {};
  appProperties[DRIVE_APP_PROPERTY_KEYS.rootMarker] = "true";
  appProperties[DRIVE_APP_PROPERTY_KEYS.rootVersion] = "1";

  const root = await api.createFileMultipart({
    name: APP_SLUG,
    mimeType: FOLDER_MIME,
    appProperties,
  });

  // Create data/ and share/ subfolders
  const [dataFolder, shareFolder] = await Promise.all([
    api.createFileMultipart({
      name: "data",
      mimeType: FOLDER_MIME,
      parents: [root.id],
    }),
    api.createFileMultipart({
      name: "share",
      mimeType: FOLDER_MIME,
      parents: [root.id],
    }),
  ]);

  return {
    rootId: root.id,
    dataId: dataFolder.id,
    shareId: shareFolder.id,
  };
}

/**
 * JSON structure stored in DO_NOT_DELETE file body.
 * This is a backup so that manual Google Drive downloads include all
 * data needed for offline recovery.
 */
export interface VaultMetaJson {
  /** base64-encoded PBKDF2 salt */
  salt: string;
  /** base64-encoded verify ciphertext (AES-GCM encrypted legacy verification marker) */
  verify_ciphertext: string;
  /** base64-encoded verify IV (12 bytes) */
  verify_iv: string;
  /** base64-encoded AES-KW wrapped VaultKey */
  wrapped_vault_key?: string;
  /** base64-encoded AES-KW wrapped NameKey */
  wrapped_name_key?: string;
}

/**
 * Build the JSON body for the DO_NOT_DELETE meta file.
 */
function buildMetaJson(
  salt: Uint8Array,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  wrappedVaultKey?: Uint8Array,
  wrappedNameKey?: Uint8Array,
): string {
  const json: VaultMetaJson = {
    salt: toBase64(salt),
    verify_ciphertext: toBase64(ciphertext),
    verify_iv: toBase64(iv),
  };
  if (wrappedVaultKey) json.wrapped_vault_key = toBase64(wrappedVaultKey);
  if (wrappedNameKey) json.wrapped_name_key = toBase64(wrappedNameKey);
  return JSON.stringify(json, null, 2);
}

/**
 * Upload DO_NOT_DELETE: combined salt + verify file.
 * Salt and verify IV are stored in appProperties (fast metadata-only retrieval).
 * Full recovery data is stored as JSON in the file body (backup for manual download).
 */
export async function uploadKakusuMeta(
  rootId: string,
  salt: Uint8Array,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  wrappedVaultKey?: Uint8Array,
  wrappedNameKey?: Uint8Array,
): Promise<string> {
  const appProperties: Record<string, string> = {
    verify_iv: toBase64(iv),
  };
  appProperties[DRIVE_APP_PROPERTY_KEYS.salt] = toBase64(salt);
  if (wrappedVaultKey) {
    appProperties.wrapped_vault_key = toBase64(wrappedVaultKey);
  }
  if (wrappedNameKey) {
    appProperties.wrapped_name_key = toBase64(wrappedNameKey);
  }
  const jsonBody = buildMetaJson(
    salt,
    ciphertext,
    iv,
    wrappedVaultKey,
    wrappedNameKey,
  );
  const bodyBytes = new TextEncoder().encode(jsonBody);
  const file = await api.createFileMultipart(
    {
      name: META_FILE_NAME,
      parents: [rootId],
      mimeType: "application/json",
      appProperties,
    },
    bodyBytes,
  );
  return file.id;
}

/**
 * Update verify data in DO_NOT_DELETE file.
 * Updates both appProperties and JSON body.
 */
export async function uploadVerify(
  rootId: string,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  existingFileId?: string,
  /** Extra appProperties to include (e.g. re-wrapped keys) */
  extraAppProperties?: Record<string, string>,
): Promise<string> {
  const ivBase64 = toBase64(iv);

  if (existingFileId) {
    // Read existing file to preserve salt and wrapped keys in JSON
    let salt: string | undefined;
    let wrappedVK: string | undefined;
    let wrappedNK: string | undefined;
    try {
      const raw = await api.getFileContent(existingFileId);
      const text = new TextDecoder().decode(raw);
      const existing: VaultMetaJson = JSON.parse(text);
      salt = existing.salt;
      wrappedVK = existing.wrapped_vault_key;
      wrappedNK = existing.wrapped_name_key;
    } catch {
      // File may not exist yet or be empty; salt/keys will be empty
    }

    // Use extra properties (re-wrapped keys from password change) if provided
    const appProps: Record<string, string> = {
      verify_iv: ivBase64,
      ...extraAppProperties,
    };

    // Build updated JSON body
    const json: VaultMetaJson = {
      salt: salt ?? "",
      verify_ciphertext: toBase64(ciphertext),
      verify_iv: ivBase64,
    };
    // Prefer freshly wrapped keys from extraAppProperties, fall back to existing
    json.wrapped_vault_key = extraAppProperties?.wrapped_vault_key ?? wrappedVK;
    json.wrapped_name_key = extraAppProperties?.wrapped_name_key ?? wrappedNK;

    const jsonBody = new TextEncoder().encode(JSON.stringify(json, null, 2));
    await api.updateFileWithContent(
      existingFileId,
      { appProperties: appProps },
      jsonBody,
    );
    return existingFileId;
  }

  // This path should not normally be reached for new vaults (uploadKakusuMeta handles creation)
  const file = await api.createFileMultipart(
    {
      name: META_FILE_NAME,
      parents: [rootId],
      mimeType: "application/json",
    },
    ciphertext,
  );
  return file.id;
}

/**
 * List files in a data folder (recursive option)
 */
export async function listDataFiles(folderId: string): Promise<DriveFile[]> {
  assertSafeId(folderId);
  return api.listAllFiles(
    `'${folderId}' in parents and trashed=false`,
    "files(id,name,mimeType,size,modifiedTime,parents,appProperties)",
  );
}

/**
 * List shared files
 */
export async function listShareFiles(folderId: string): Promise<DriveFile[]> {
  assertSafeId(folderId);
  return api.listAllFiles(
    `'${folderId}' in parents and trashed=false`,
    "files(id,name,mimeType,size,modifiedTime,appProperties)",
  );
}

/**
 * List trashed Kakusu files.
 * Includes both regular files (with name_encrypted) and shared files.
 */
export async function listTrashedKakusuFiles(): Promise<DriveFile[]> {
  // Drive API requires both key and value for appProperties has.
  // Regular Kakusu files have name_encrypted='true' or 'false'.
  // Shared files may not have name_encrypted.
  const [encTrue, encFalse, sharedTrue] = await Promise.all([
    api.listAllFiles(
      "appProperties has { key='name_encrypted' and value='true' } and trashed=true",
      "files(id,name,mimeType,size,modifiedTime,parents,appProperties)",
    ),
    api.listAllFiles(
      "appProperties has { key='name_encrypted' and value='false' } and trashed=true",
      "files(id,name,mimeType,size,modifiedTime,parents,appProperties)",
    ),
    api.listAllFiles(
      `(appProperties has { key='${DRIVE_APP_PROPERTY_KEYS.shared}' and value='true' }) and trashed=true`,
      "files(id,name,mimeType,size,modifiedTime,parents,appProperties)",
    ),
  ]);

  // Deduplicate by file ID (shared files that also have name_encrypted may appear in multiple queries)
  const seen = new Set<string>();
  const result: DriveFile[] = [];
  for (const file of [...encTrue, ...encFalse, ...sharedTrue]) {
    if (!seen.has(file.id)) {
      seen.add(file.id);
      result.push(file);
    }
  }
  return result;
}
