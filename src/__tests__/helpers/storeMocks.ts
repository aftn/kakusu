import { vi } from "vitest";
/**
 * Default mock states for all Zustand stores.
 * Component tests import and override these as needed.
 */
import type {
  ClipboardState,
  ContextMenuState,
  KakusuFile,
  PreviewState,
  Toast,
} from "./storeTypes";

// ── VaultStore ──
export function defaultVaultState() {
  return {
    isSetup: true,
    isUnlocked: true,
    rootFolderId: "root-id",
    rootFolderName: "kakusu",
    dataFolderId: "data-folder-id",
    shareFolderId: "share-folder-id",
    metaFileId: "meta-file-id",
    verifyIv: null as Uint8Array | null,
    mekEnc: null as CryptoKey | null,
    mekWrap: null as CryptoKey | null,
    vaultKey: null as CryptoKey | null,
    nameKey: null as CryptoKey | null,
    salt: null as Uint8Array | null,
    syncedSettings: null as Record<string, unknown> | null,
    unlock: vi.fn(async () => true),
    setup: vi.fn(),
    lock: vi.fn(),
    checkSetup: vi.fn(),
    renameRootFolder: vi.fn(),
  };
}

// ── FileStore ──
export function defaultFileState() {
  return {
    files: [] as KakusuFile[],
    currentFolderId: null as string | null,
    folderPath: [] as Array<{ id: string; name: string }>,
    loading: false,
    browseMode: "data" as "data" | "share" | "trash",
    canGoBack: false,
    canGoForward: false,
    navigate: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    setBrowseMode: vi.fn(),
    refresh: vi.fn(),
    upload: vi.fn(),
    uploadFolder: vi.fn(),
    download: vi.fn(),
    downloadFolder: vi.fn(),
    downloadFileAsBlob: vi.fn(),
    createFolder: vi.fn(),
    addPendingFolder: vi.fn(() => "pending-id"),
    confirmPendingFolder: vi.fn(),
    removePendingFolder: vi.fn(),
    rename: vi.fn(),
    applyNameEncryptionToAll: vi.fn(),
    remove: vi.fn(),
    moveFile: vi.fn(),
    moveFiles: vi.fn(),
    pasteFiles: vi.fn(),
    removeMultiple: vi.fn(),
    downloadMultiple: vi.fn(),
    restoreFile: vi.fn(),
    restoreMultiple: vi.fn(),
    permanentDelete: vi.fn(),
    permanentDeleteMultiple: vi.fn(),
    emptyTrash: vi.fn(),
  };
}

// ── UIStore ──
export function defaultUIState() {
  return {
    loading: false,
    error: null as string | null,
    showSettings: false,
    showShareDialog: false,
    showPasswordChange: false,
    showSharedFiles: false,
    shareTargets: [] as KakusuFile[],
    viewMode: "list" as "list" | "grid",
    defaultEncryptName: true,
    autoPopupLogin: false,
    bulkUploadBehavior: "ask" as "ask" | "direct" | "zip",
    parallelFileCount: "auto" as "auto" | 1 | 2 | 4 | 6 | 8 | 12 | 16,
    themeMode: "system" as "system" | "light" | "dark",
    userIconDisplay: "icon" as
      | "none"
      | "icon"
      | "name-icon"
      | "name-email-icon",
    contextMenu: null as ContextMenuState,
    selectedIds: new Set<string>(),
    lastSelectedId: null as string | null,
    renamingFileId: null as string | null,
    multiSelectMode: false,
    toasts: new Map<string, Toast>(),
    preview: null as PreviewState | null,
    clipboard: null as ClipboardState | null,
    confirmDialog: null as { message: string; onConfirm: () => void } | null,
    setLoading: vi.fn(),
    setError: vi.fn(),
    openSettings: vi.fn(),
    closeSettings: vi.fn(),
    toggleSettings: vi.fn(),
    openShareDialog: vi.fn(),
    closeShareDialog: vi.fn(),
    openPasswordChange: vi.fn(),
    closePasswordChange: vi.fn(),
    togglePasswordChange: vi.fn(),
    toggleSharedFiles: vi.fn(),
    setViewMode: vi.fn(),
    setDefaultEncryptName: vi.fn(),
    setAutoPopupLogin: vi.fn(),
    setBulkUploadBehavior: vi.fn(),
    setParallelFileCount: vi.fn(),
    setThemeMode: vi.fn(),
    setUserIconDisplay: vi.fn(),
    openContextMenu: vi.fn(),
    openBackgroundMenu: vi.fn(),
    closeContextMenu: vi.fn(),
    selectFile: vi.fn(),
    toggleSelectFile: vi.fn(),
    selectRange: vi.fn(),
    selectAll: vi.fn(),
    setSelectedIds: vi.fn(),
    clearSelection: vi.fn(),
    setMultiSelectMode: vi.fn(),
    exitMultiSelectMode: vi.fn(),
    startRename: vi.fn(),
    cancelRename: vi.fn(),
    openConfirmDialog: vi.fn(),
    closeConfirmDialog: vi.fn(),
    addToast: vi.fn(() => "toast-1"),
    updateToast: vi.fn(),
    removeToast: vi.fn(),
    setPreview: vi.fn(),
    setClipboard: vi.fn(),
    isDragSelecting: false,
    setDragSelecting: vi.fn(),
  };
}

// ── AuthStore ──
export function defaultAuthState() {
  return {
    accessToken: "mock-access-token",
    expiresAt: Date.now() + 3600_000,
    scope: "openid profile email https://www.googleapis.com/auth/drive.file",
    user: {
      email: "user@example.com",
      name: "Test User",
      picture: "https://lh3.googleusercontent.com/test",
    } as { email?: string; name?: string; picture?: string } | null,
    login: vi.fn(),
    handleCallback: vi.fn(),
    logout: vi.fn(),
    isTokenValid: vi.fn(() => true),
    getToken: vi.fn(async () => "mock-access-token"),
    trySilentRefresh: vi.fn(),
  };
}

// ── ShareStore ──
export interface MockShareLink {
  shareName: string;
  summary: {
    metaFileId: string;
    itemCount: number;
    createdTime: string;
    status: string;
  };
}

export function defaultShareState() {
  return {
    shareLinks: [] as MockShareLink[],
    loading: false,
    loadShareLinks: vi.fn(),
    renameShareLink: vi.fn(),
    removeShareLinks: vi.fn(),
    copyShareLink: vi.fn(),
    createShareLink: vi.fn(),
  };
}

// ── CacheSettingsStore ──
export function defaultCacheSettingsState() {
  return {
    metadataCacheMode: "off" as string,
    previewCacheMode: "off" as string,
    setMetadataCacheMode: vi.fn(),
    setPreviewCacheMode: vi.fn(),
  };
}

/**
 * Helper: create a mock Zustand hook from a state object.
 * Supports both `useStore()` and `useStore(selector)` calling patterns,
 * plus `useStore.getState()`.
 */
export type ZustandMockHook<T> = ReturnType<typeof vi.fn> & {
  getState: () => T;
  setState: (partial: Partial<T>) => void;
  subscribe: () => () => void;
};

export function createMockHook<T extends Record<string, unknown>>(state: T) {
  const hook = vi.fn((selector?: (s: T) => unknown) =>
    selector ? selector(state) : state,
  ) as ZustandMockHook<T>;
  hook.getState = vi.fn(() => state);
  hook.setState = vi.fn();
  hook.subscribe = vi.fn(() => () => {});
  return hook;
}
