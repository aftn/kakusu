import { decryptMetadataFromProperties } from "@/crypto/decrypt";
import {
  deriveMEKs,
  generateNameKey,
  generateSalt,
  generateVaultKey,
  unwrapNameKey,
  unwrapVaultKey,
  wrapNameKey,
  wrapVaultKey,
} from "@/crypto/keys";
import { createVerifyData, verifyPassphrase } from "@/crypto/verify";
import * as driveApi from "@/drive/api";
import {
  createRootStructure,
  findRoot,
  findRootChildren,
  getVerifyFromMeta,
  listDataFiles,
  updateKakusuMetaSettings,
  uploadKakusuMeta,
} from "@/drive/files";
import type { SyncedSettings, VaultState } from "@/types";
import { clearPreviewCache } from "@/utils/previewCache";
import { create } from "zustand";
import { useUIStore } from "./uiStore";

let _wrappedVaultKey: Uint8Array | null = null;
let _wrappedNameKey: Uint8Array | null = null;

export function getWrappedVaultKey(): Uint8Array | null {
  return _wrappedVaultKey;
}

export function getWrappedNameKey(): Uint8Array | null {
  return _wrappedNameKey;
}

export function setWrappedKeys(
  wrappedVaultKey: Uint8Array,
  wrappedNameKey: Uint8Array,
): void {
  _wrappedVaultKey = wrappedVaultKey;
  _wrappedNameKey = wrappedNameKey;
}

/**
 * Sync a single setting to DO_NOT_DELETE appProperties.
 * Shows a success toast on completion, or an error toast on failure.
 */
export async function syncSettingToMeta(
  partial: SyncedSettings,
): Promise<void> {
  const { metaFileId } = useVaultStore.getState();
  if (!metaFileId) return;
  const { addToast } = useUIStore.getState();
  try {
    await updateKakusuMetaSettings(metaFileId, partial);
    addToast({ message: "設定を同期しました", type: "success" });
  } catch (e) {
    console.warn("Failed to sync setting to DO_NOT_DELETE", e);
    addToast({ message: "設定の同期に失敗しました", type: "error" });
  }
}

export const useVaultStore = create<VaultState>((set, get) => ({
  isSetup: null,
  isUnlocked: false,
  rootFolderId: null,
  rootFolderName: null,
  dataFolderId: null,
  shareFolderId: null,
  metaFileId: null,
  verifyIv: null,
  mekEnc: null,
  mekWrap: null,
  vaultKey: null,
  nameKey: null,
  salt: null,
  syncedSettings: null,

  checkSetup: async () => {
    const root = await findRoot();
    if (!root) {
      set({ isSetup: false });
      return;
    }

    const {
      dataId,
      shareId,
      salt,
      metaFileId,
      verifyIv,
      wrappedVaultKey,
      wrappedNameKey,
      syncedSettings,
    } = await findRootChildren(root.id);

    if (!dataId || !shareId || !salt) {
      set({ isSetup: false });
      return;
    }

    // Store wrapped keys for unlock to use
    _wrappedVaultKey = wrappedVaultKey;
    _wrappedNameKey = wrappedNameKey;

    set({
      isSetup: true,
      rootFolderId: root.id,
      rootFolderName: root.name,
      dataFolderId: dataId,
      shareFolderId: shareId,
      salt,
      metaFileId: metaFileId ?? undefined,
      verifyIv: verifyIv ?? undefined,
      syncedSettings,
    });
  },

  setup: async (passphrase: string) => {
    // Create folder structure
    const { rootId, dataId, shareId } = await createRootStructure();

    // Generate and upload salt
    const salt = generateSalt();

    // Derive keys
    const { mekEnc, mekWrap } = await deriveMEKs(passphrase, salt);

    // Generate Vault Key (wraps CEKs) and Name Key (encrypts filenames)
    const vaultKey = await generateVaultKey();
    const nameKey = await generateNameKey();
    const wrappedVK = await wrapVaultKey(mekWrap, vaultKey);
    const wrappedNK = await wrapNameKey(mekWrap, nameKey);

    // Create DO_NOT_DELETE (JSON body with all vault recovery data)
    const { ciphertext, iv } = await createVerifyData(mekEnc);
    const metaFileId = await uploadKakusuMeta(
      rootId,
      salt,
      ciphertext,
      iv,
      wrappedVK,
      wrappedNK,
    );

    set({
      isSetup: true,
      isUnlocked: true,
      rootFolderId: rootId,
      rootFolderName: "kakusu",
      dataFolderId: dataId,
      shareFolderId: shareId,
      mekEnc,
      mekWrap,
      vaultKey,
      nameKey,
      salt,
      metaFileId,
      verifyIv: iv,
    });
  },

  unlock: async (passphrase: string) => {
    const { rootFolderId, salt, dataFolderId, metaFileId, verifyIv } = get();
    if (!rootFolderId || !salt || !dataFolderId) return false;

    // Derive keys
    const { mekEnc, mekWrap } = await deriveMEKs(passphrase, salt);

    // Unwrap Vault Key & Name Key if present (Envelope Encryption mode)
    let vaultKey: CryptoKey | null = null;
    let nameKey: CryptoKey | null = null;
    if (_wrappedVaultKey) {
      try {
        vaultKey = await unwrapVaultKey(mekWrap, _wrappedVaultKey);
      } catch {
        return false;
      }
    }
    if (_wrappedNameKey) {
      try {
        nameKey = await unwrapNameKey(mekWrap, _wrappedNameKey);
      } catch {
        return false;
      }
    }

    // Try decrypting a file name first (faster than downloading DO_NOT_DELETE content)
    let verified = false;
    try {
      const files = await listDataFiles(dataFolderId);
      const encFile = files.find(
        (f) =>
          f.appProperties?.name_encrypted === "true" &&
          f.appProperties?.enc_name &&
          f.appProperties?.iv_meta,
      );
      if (encFile) {
        const appProperties = encFile.appProperties;
        if (!appProperties?.enc_name || !appProperties.iv_meta) {
          return false;
        }
        // Use NameKey for decryption (all files are v2)
        const decKey = nameKey ?? mekEnc;
        await decryptMetadataFromProperties(
          decKey,
          appProperties,
          "enc_name",
          "iv_meta",
        );
        verified = true;
      }
    } catch {
      // Decryption failed — fall through to verify
    }

    // Fallback: verify via DO_NOT_DELETE content
    if (!verified) {
      if (!metaFileId || !verifyIv) return false;
      const verifyData = await getVerifyFromMeta(metaFileId, verifyIv);
      const isValid = await verifyPassphrase(
        mekEnc,
        verifyData.ciphertext,
        verifyData.iv,
      );
      if (!isValid) return false;
    }

    set({
      isUnlocked: true,
      mekEnc,
      mekWrap,
      vaultKey,
      nameKey,
    });

    return true;
  },

  lock: () => {
    clearPreviewCache();
    set({
      isUnlocked: false,
      mekEnc: null,
      mekWrap: null,
      vaultKey: null,
      nameKey: null,
    });
  },

  renameRootFolder: async (newName: string) => {
    const { rootFolderId } = get();
    if (!rootFolderId) throw new Error("ルートフォルダが見つかりません");
    const trimmed = newName.trim();
    if (!trimmed) throw new Error("フォルダ名を入力してください");
    await driveApi.updateFileMetadata(rootFolderId, { name: trimmed });
    set({ rootFolderName: trimmed });
  },
}));
