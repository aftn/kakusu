import { decryptMetadata } from "@/crypto/decrypt";
import { encryptMetadata } from "@/crypto/encrypt";
import { buildShareURL } from "@/crypto/share";
import { encryptNameWithShareKey, unwrapShareKey } from "@/crypto/shareKey";
import { revokePermissionsBatch } from "@/drive/permissions";
import type { ShareMetaFile, ShareMetaSummary } from "@/drive/shareMeta";
import {
  deleteShareMetaFile,
  fetchShareMetaFile,
  listShareMetaFiles,
  parseShareMetaSummary,
  updateShareMetaFile,
  updateShareMetaStatus,
} from "@/drive/shareMeta";
import { TEXT_INPUT_MAX_LENGTH, sanitizeTextInput } from "@/drive/validation";
import { decode } from "@/utils/base64url";
import { writeClipboardText } from "@/utils/clipboard";
import { writeSegmentedAppProperty } from "@/utils/driveProperties";
import { create } from "zustand";
import { useVaultStore } from "./vaultStore";

export interface ShareLink {
  summary: ShareMetaSummary;
  /** Decrypted share name (populated after MEK_enc decrypt) */
  shareName: string;
}

interface ShareState {
  shareLinks: ShareLink[];
  loading: boolean;

  /** Load all share meta summaries from appProperties (no JSON fetch). */
  loadShareLinks: () => Promise<void>;

  /** Remove a share link (delete meta file). */
  removeShareLink: (metaFileId: string) => Promise<void>;

  /**
   * Remove a share link and revoke Drive permissions on shared files.
   * Skips files shared by other active shares.
   * @param onProgress called with (completed, total) counts
   */
  removeShareLinkWithRevoke: (
    metaFileId: string,
    onProgress?: (done: number, total: number) => void,
  ) => Promise<void>;

  /**
   * Remove multiple share links at once, optionally revoking permissions.
   */
  removeShareLinks: (
    metaFileIds: string[],
    revokePermissions: boolean,
    onProgress?: (done: number, total: number) => void,
  ) => Promise<void>;

  /** Disable a share link without deleting (updates appProperties only). */
  disableShareLink: (metaFileId: string) => Promise<void>;

  /** Rename a share link (updates meta file JSON + appProperties). */
  renameShareLink: (metaFileId: string, newName: string) => Promise<void>;

  /** Copy share URL to clipboard (fetches meta file to reconstruct URL). */
  copyShareLink: (metaFileId: string) => Promise<void>;

  /** Get all shared file IDs across all active shares (for badge display). */
  getSharedFileIds: () => Set<string>;

  /** Clear state (on vault lock). */
  clear: () => void;
}

export const useShareStore = create<ShareState>((set) => ({
  shareLinks: [],
  loading: false,

  loadShareLinks: async () => {
    const vault = useVaultStore.getState();
    if (!vault.shareFolderId || !vault.mekEnc) return;

    set({ loading: true });
    try {
      const driveFiles = await listShareMetaFiles(vault.shareFolderId);

      // Decrypt share names in parallel
      const results = await Promise.allSettled(
        driveFiles.map(async (df): Promise<ShareLink | null> => {
          const summary = parseShareMetaSummary(df);
          if (!summary) return null;
          const shareName = await decryptMetadata(
            vault.mekEnc!,
            summary.encShareName,
            undefined,
            summary.ivShareName,
          );
          return { summary, shareName };
        }),
      );
      const links: ShareLink[] = results
        .filter(
          (r): r is PromiseFulfilledResult<ShareLink | null> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value)
        .filter((v): v is ShareLink => v !== null);

      set({ shareLinks: links, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  removeShareLink: async (metaFileId: string) => {
    await deleteShareMetaFile(metaFileId);
    set((s) => ({
      shareLinks: s.shareLinks.filter(
        (l) => l.summary.metaFileId !== metaFileId,
      ),
    }));
  },

  removeShareLinkWithRevoke: async (metaFileId: string, onProgress?) => {
    // 1. Fetch meta to get file IDs
    const meta = await fetchShareMetaFile(metaFileId);
    const fileIds = meta.items.map((i) => i.fileId);
    const allIds = [...fileIds, ...meta.folders];

    // 2. Collect file IDs used by OTHER active shares (to skip revoking) — in parallel
    const otherShares = useShareStore
      .getState()
      .shareLinks.filter(
        (l) =>
          l.summary.metaFileId !== metaFileId && l.summary.status === "active",
      );
    const protectedIds = new Set<string>();
    try {
      const otherMetas = await Promise.all(
        otherShares.map((other) =>
          fetchShareMetaFile(other.summary.metaFileId),
        ),
      );
      for (const otherMeta of otherMetas) {
        for (const item of otherMeta.items) protectedIds.add(item.fileId);
        for (const fId of otherMeta.folders) protectedIds.add(fId);
      }
    } catch {
      // Cannot determine protected files — abort revocation to prevent data loss.
      await deleteShareMetaFile(metaFileId);
      set((s) => ({
        shareLinks: s.shareLinks.filter(
          (l) => l.summary.metaFileId !== metaFileId,
        ),
      }));
      throw new Error(
        "他の共有情報の取得に失敗したため、権限の無効化を中止しました。共有リンクは削除済みです。",
      );
    }

    // 3. Revoke permissions on unprotected files — batch with concurrency
    const toRevoke = allIds.filter((id) => !protectedIds.has(id));
    await revokePermissionsBatch(toRevoke, 8, onProgress);

    // 4. Delete meta file
    await deleteShareMetaFile(metaFileId);
    set((s) => ({
      shareLinks: s.shareLinks.filter(
        (l) => l.summary.metaFileId !== metaFileId,
      ),
    }));
  },

  removeShareLinks: async (
    metaFileIds: string[],
    revoke: boolean,
    onProgress?,
  ) => {
    if (revoke) {
      // Collect ALL file IDs across all targets first — in parallel
      const targetSet = new Set(metaFileIds);
      const metaResults = await Promise.allSettled(
        metaFileIds.map(async (mfId) => ({
          metaFileId: mfId,
          meta: await fetchShareMetaFile(mfId),
        })),
      );
      const allMetas = metaResults
        .filter(
          (
            r,
          ): r is PromiseFulfilledResult<{
            metaFileId: string;
            meta: ShareMetaFile;
          }> => r.status === "fulfilled",
        )
        .map((r) => r.value);

      // Protected: files used by shares NOT being deleted — fetch in parallel
      const otherShares = useShareStore
        .getState()
        .shareLinks.filter(
          (l) =>
            !targetSet.has(l.summary.metaFileId) &&
            l.summary.status === "active",
        );
      const protectedIds = new Set<string>();
      let protectedFetchFailed = false;
      try {
        const otherMetas = await Promise.all(
          otherShares.map((other) =>
            fetchShareMetaFile(other.summary.metaFileId),
          ),
        );
        for (const otherMeta of otherMetas) {
          for (const item of otherMeta.items) protectedIds.add(item.fileId);
          for (const fId of otherMeta.folders) protectedIds.add(fId);
        }
      } catch {
        protectedFetchFailed = true;
      }

      // If we couldn't verify protected files, skip revocation to prevent data loss
      if (protectedFetchFailed) {
        // Delete meta files only, without revoking any permissions
        for (const { metaFileId } of allMetas) {
          try {
            await deleteShareMetaFile(metaFileId);
          } catch {
            /* skip */
          }
        }
        set((s) => ({
          shareLinks: s.shareLinks.filter(
            (l) => !metaFileIds.includes(l.summary.metaFileId),
          ),
        }));
        throw new Error(
          "他の共有情報の取得に失敗したため、権限の無効化を中止しました。共有リンクは削除済みです。",
        );
      }

      // Deduplicate file IDs across all target metas
      const seen = new Set<string>();
      const toRevoke: string[] = [];
      for (const { meta } of allMetas) {
        for (const item of meta.items) {
          if (!protectedIds.has(item.fileId) && !seen.has(item.fileId)) {
            seen.add(item.fileId);
            toRevoke.push(item.fileId);
          }
        }
        for (const fId of meta.folders) {
          if (!protectedIds.has(fId) && !seen.has(fId)) {
            seen.add(fId);
            toRevoke.push(fId);
          }
        }
      }

      await revokePermissionsBatch(toRevoke, 8, onProgress);

      // Delete meta files in parallel
      await Promise.allSettled(
        allMetas.map(({ metaFileId }) => deleteShareMetaFile(metaFileId)),
      );
    } else {
      // Just delete meta files without revoking permissions — in parallel
      const results = await Promise.allSettled(
        metaFileIds.map((mfId) => deleteShareMetaFile(mfId)),
      );
      const failedIds = metaFileIds.filter(
        (_, i) => results[i]?.status === "rejected",
      );
      if (failedIds.length > 0 && failedIds.length === metaFileIds.length) {
        throw new Error("共有リンクの削除に失敗しました");
      }
      // Remove only successfully deleted items from state
      const failedSet = new Set(failedIds);
      set((s) => ({
        shareLinks: s.shareLinks.filter(
          (l) =>
            failedSet.has(l.summary.metaFileId) ||
            !metaFileIds.includes(l.summary.metaFileId),
        ),
      }));
      if (failedIds.length > 0) {
        throw new Error(
          `${metaFileIds.length}件中${failedIds.length}件の削除に失敗しました`,
        );
      }
      return;
    }

    set((s) => ({
      shareLinks: s.shareLinks.filter(
        (l) => !metaFileIds.includes(l.summary.metaFileId),
      ),
    }));
  },

  disableShareLink: async (metaFileId: string) => {
    await updateShareMetaStatus(metaFileId, "disabled");
    set((s) => ({
      shareLinks: s.shareLinks.map((l) =>
        l.summary.metaFileId === metaFileId
          ? { ...l, summary: { ...l.summary, status: "disabled" } }
          : l,
      ),
    }));
  },

  renameShareLink: async (metaFileId: string, newName: string) => {
    const sanitized = sanitizeTextInput(newName);
    if (!sanitized || sanitized.length > TEXT_INPUT_MAX_LENGTH) {
      throw new Error("共有名が無効です");
    }
    const vault = useVaultStore.getState();
    if (!vault.mekEnc || !vault.mekWrap) throw new Error("Vault is locked");

    // 1. Fetch full meta file to get wrappedShareKey and existing content
    const meta = await fetchShareMetaFile(metaFileId);

    // 2. Re-encrypt share name with MEK_enc (owner-only)
    const { encNameFull: encShareName, ivMeta: ivShareName } =
      await encryptMetadata(vault.mekEnc, sanitized);

    // 3. Re-encrypt share name with ShareKey (recipient-visible)
    const wrappedShareKeyBytes = decode(meta.wrappedShareKey);
    const shareKeyBytes = await unwrapShareKey(
      vault.mekWrap,
      wrappedShareKeyBytes,
    );
    const { encName: encShareNameByShareKey, ivName: ivShareNameByShareKey } =
      await encryptNameWithShareKey(shareKeyBytes, sanitized);

    // 4. Update meta file JSON
    const updatedMeta: ShareMetaFile = {
      ...meta,
      encShareName,
      ivShareName,
      encShareNameByShareKey,
      ivShareNameByShareKey,
    };

    // 5. Build appProperties update
    const appProps: Record<string, string> = { iv_share_name: ivShareName };
    writeSegmentedAppProperty(appProps, "enc_share_name", encShareName);

    // 6. Write both JSON content and appProperties
    await updateShareMetaFile(metaFileId, updatedMeta, appProps);

    // 7. Update local state
    set((s) => ({
      shareLinks: s.shareLinks.map((l) =>
        l.summary.metaFileId === metaFileId
          ? {
              ...l,
              shareName: sanitized,
              summary: { ...l.summary, encShareName, ivShareName },
            }
          : l,
      ),
    }));
  },

  copyShareLink: async (metaFileId: string) => {
    const vault = useVaultStore.getState();
    if (!vault.mekWrap) throw new Error("Vault is locked");

    const urlPromise = (async () => {
      const meta = await fetchShareMetaFile(metaFileId);
      // Ensure we use the base64url decode instead of fromBase64
      const wrappedShareKeyBytes = decode(meta.wrappedShareKey);
      const shareKeyBytes = await unwrapShareKey(
        vault.mekWrap!,
        wrappedShareKeyBytes,
      );
      return buildShareURL(metaFileId, shareKeyBytes);
    })();

    await writeClipboardText(urlPromise);
  },

  getSharedFileIds: () => {
    // This is a lightweight summary-based store. Shared file IDs require
    // fetching the full meta file, which is done separately.
    return new Set<string>();
  },

  clear: () => set({ shareLinks: [], loading: false }),
}));
