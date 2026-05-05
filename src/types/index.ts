// ファイルツリーのノード
export interface KakusuFile {
  driveId: string;
  parentId: string;
  name: string; // 復号済みファイル名
  nameEncrypted: boolean;
  type: "file" | "folder";
  size?: number;
  modifiedTime: string;
  // appProperties（暗号化されたまま保持するメタデータ）
  encName?: string;
  encName2?: string;
  ivMeta?: string;
  wrappedCek?: string;
  ivBody?: string;
  keyVersion?: string;
  totalChunks?: number;
  // 共有
  isShared?: boolean;
  // 仮想フォルダ（未同期）
  pending?: boolean;
  // アップロード中（一時エントリ）
  uploading?: boolean;
}

// IndexedDB キャッシュ
export interface CachedFile {
  driveId: string;
  parentId: string;
  nameEncrypted: boolean;
  driveName: string;
  encName?: string;
  encName2?: string;
  ivMeta?: string;
  wrappedCek?: string;
  ivBody?: string;
  keyVersion?: string;
  totalChunks?: number;
  size: number;
  mimeType: string;
  driveModifiedTime: string;
  syncedAt: number;
  isShared?: boolean;
}

// Drive API 型
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  createdTime?: string;
  description?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  trashed?: boolean;
}

export interface DriveFileList {
  files: DriveFile[];
  nextPageToken?: string;
}

export interface DrivePermission {
  id: string;
  type: "anyone" | "user" | "domain";
  role: "reader" | "writer" | "owner";
  emailAddress?: string;
  expirationTime?: string;
}

// Zustand ストア型
export interface AuthState {
  accessToken: string | null;
  expiresAt: number | null;
  scope: string | null;
  user: { email?: string; name?: string; picture?: string } | null;
  authError: string | null;
  login: (
    prompt?: "select_account" | "consent",
    scopeOverride?: string,
  ) => Promise<void>;
  handleCallback: (payload: {
    accessToken: string;
    expiresIn: number;
    scope: string | null;
  }) => Promise<void>;
  logout: () => void;
  isTokenValid: () => boolean;
  getToken: () => Promise<string>;
  trySilentRefresh: () => void;
}

export type CacheMetadataMode = "off" | "session" | "24h" | "7d" | "unlimited";
export type PreviewCacheMode = "off" | "memory";
export type ThemeMode = "system" | "light" | "dark";
export type UserIconDisplay = "none" | "icon" | "name-icon" | "name-email-icon";
export type BulkUploadBehavior = "ask" | "direct" | "zip";
export type ParallelFileCount = "auto" | 1 | 2 | 4 | 6 | 8 | 12 | 16 | 20;

export interface SyncedSettings {
  encryptName?: boolean;
  metadataCacheMode?: string;
  previewCacheMode?: string;
  autoPopupLogin?: boolean;
}

export interface VaultState {
  isSetup: boolean | null;
  isUnlocked: boolean;
  rootFolderId: string | null;
  rootFolderName: string | null;
  dataFolderId: string | null;
  shareFolderId: string | null;
  metaFileId: string | null;
  verifyIv: Uint8Array | null;
  mekEnc: CryptoKey | null;
  mekWrap: CryptoKey | null;
  vaultKey: CryptoKey | null;
  nameKey: CryptoKey | null;
  salt: Uint8Array | null;
  syncedSettings: SyncedSettings | null;
  unlock: (passphrase: string) => Promise<boolean>;
  setup: (passphrase: string) => Promise<void>;
  lock: () => void;
  checkSetup: () => Promise<void>;
  renameRootFolder: (newName: string) => Promise<void>;
}

export interface OperationProgress {
  message: string;
  percent: number;
  startedAt: number;
}

export type ToastType = "progress" | "success" | "error" | "info";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  percent?: number;
  startedAt?: number;
  /** 完了後に自動で閉じるまでの時間（ミリ秒） */
  autoDismiss?: number;
  /** 操作を中止するためのコールバック */
  onCancel?: () => void;
  /** 転送速度の表示文字列 例: "1.2 MB/s" */
  speed?: string;
  /** 現在の処理段階。進捗バーの色分けに使う */
  phase?: "encrypting" | "uploading" | "downloading" | "decrypting";
  /** コピー可能なURLを表示するためのフィールド */
  copyableUrl?: string;
}

export interface PreviewState {
  file: KakusuFile;
  blobUrl: string;
  mimeType: string;
}

export interface FileState {
  files: KakusuFile[];
  currentFolderId: string | null;
  folderPath: Array<{ id: string; name: string }>;
  loading: boolean;
  browseMode: "data" | "share" | "trash";
  canGoBack: boolean;
  canGoForward: boolean;
  /** @internal Navigation history for goBack/goForward */
  _navHistory: Array<{
    folderId: string | null;
    folderPath: Array<{ id: string; name: string }>;
    browseMode: "data" | "share" | "trash";
  }>;
  _navIndex: number;
  _navigatingFromHistory: boolean;
  navigate: (folderId: string | null, folderName?: string) => void;
  goBack: () => void;
  goForward: () => void;
  setBrowseMode: (mode: "data" | "share" | "trash") => void;
  refresh: () => Promise<void>;
  upload: (
    file: File,
    encryptName: boolean,
    options?: { refreshAfterUpload?: boolean; suppressToast?: boolean },
  ) => Promise<void>;
  uploadFolder: (
    entries: Array<{ file: File; relativePath: string }>,
    encryptName: boolean,
  ) => Promise<void>;
  download: (file: KakusuFile) => Promise<void>;
  downloadFolder: (folder: KakusuFile) => Promise<void>;
  downloadFileAsBlob: (file: KakusuFile) => Promise<Blob>;
  createFolder: (name: string, encryptName: boolean) => Promise<string | null>;
  addPendingFolder: () => string;
  confirmPendingFolder: (
    tempId: string,
    name: string,
    encryptName: boolean,
  ) => Promise<void>;
  removePendingFolder: (tempId: string) => void;
  rename: (file: KakusuFile, newName: string) => Promise<void>;
  applyNameEncryptionToAll: (encryptName: boolean) => Promise<void>;
  remove: (file: KakusuFile) => Promise<void>;
  moveFile: (
    fileId: string,
    newParentId: string,
    oldParentId: string,
  ) => Promise<void>;
  moveFiles: (
    moves: { fileId: string; newParentId: string; oldParentId: string }[],
  ) => Promise<void>;
  pasteFiles: (
    clipboard: ClipboardState,
    destFolderId: string,
  ) => Promise<void>;
  removeMultiple: (files: KakusuFile[]) => Promise<void>;
  downloadMultiple: (files: KakusuFile[]) => Promise<void>;
  restoreFile: (file: KakusuFile) => Promise<void>;
  restoreMultiple: (files: KakusuFile[]) => Promise<void>;
  permanentDelete: (file: KakusuFile) => Promise<void>;
  permanentDeleteMultiple: (files: KakusuFile[]) => Promise<void>;
  emptyTrash: () => Promise<void>;
}

export type ContextMenuState =
  | { x: number; y: number; type: "file"; file: KakusuFile }
  | { x: number; y: number; type: "background" }
  | null;

export interface ClipboardState {
  action: "copy" | "cut";
  files: KakusuFile[];
  sourceFolderId: string | null;
}

export interface UIState {
  loading: boolean;
  error: string | null;
  showSettings: boolean;
  showShareDialog: boolean;
  showPasswordChange: boolean;
  showSharedFiles: boolean;
  shareTargets: KakusuFile[];
  viewMode: "list" | "grid";
  defaultEncryptName: boolean;
  autoPopupLogin: boolean;
  bulkUploadBehavior: BulkUploadBehavior;
  parallelFileCount: ParallelFileCount;
  themeMode: ThemeMode;
  userIconDisplay: UserIconDisplay;
  contextMenu: ContextMenuState;
  selectedIds: Set<string>;
  lastSelectedId: string | null;
  renamingFileId: string | null;
  multiSelectMode: boolean;
  toasts: Map<string, Toast>;
  preview: PreviewState | null;
  clipboard: ClipboardState | null;
  isDragSelecting: boolean;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  openSettings: () => void;
  closeSettings: () => void;
  toggleSettings: () => void;
  openShareDialog: (files: KakusuFile[]) => void;
  closeShareDialog: () => void;
  openPasswordChange: () => void;
  closePasswordChange: () => void;
  togglePasswordChange: () => void;
  toggleSharedFiles: () => void;
  setViewMode: (mode: "list" | "grid") => void;
  setDefaultEncryptName: (value: boolean) => void;
  setAutoPopupLogin: (value: boolean) => void;
  setBulkUploadBehavior: (value: BulkUploadBehavior) => void;
  setParallelFileCount: (value: ParallelFileCount) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setUserIconDisplay: (display: UserIconDisplay) => void;
  openContextMenu: (x: number, y: number, file: KakusuFile) => void;
  openBackgroundMenu: (x: number, y: number) => void;
  closeContextMenu: () => void;
  selectFile: (id: string, multi: boolean) => void;
  toggleSelectFile: (id: string) => void;
  selectRange: (ids: string[], additive: boolean) => void;
  selectAll: (ids: string[]) => void;
  setSelectedIds: (ids: Set<string>) => void;
  clearSelection: () => void;
  setMultiSelectMode: (mode: boolean) => void;
  exitMultiSelectMode: () => void;
  startRename: (fileId: string) => void;
  cancelRename: () => void;
  confirmDialog: {
    message: string;
    onConfirm: () => void;
    confirmLabel?: string;
    secondaryLabel?: string;
    onSecondary?: () => void;
    checkboxLabel?: string;
    onConfirmWithCheckbox?: (checked: boolean) => void;
    onSecondaryWithCheckbox?: (checked: boolean) => void;
    variant?: "destructive" | "info";
  } | null;
  openConfirmDialog: (
    message: string,
    onConfirm: () => void,
    options?: {
      confirmLabel?: string;
      secondaryLabel?: string;
      onSecondary?: () => void;
      checkboxLabel?: string;
      onConfirmWithCheckbox?: (checked: boolean) => void;
      onSecondaryWithCheckbox?: (checked: boolean) => void;
      variant?: "destructive" | "info";
    },
  ) => void;
  closeConfirmDialog: () => void;
  addToast: (toast: Omit<Toast, "id">) => string;
  updateToast: (id: string, updates: Partial<Omit<Toast, "id">>) => void;
  removeToast: (id: string) => void;
  setPreview: (preview: PreviewState | null) => void;
  setClipboard: (clipboard: ClipboardState | null) => void;
  setDragSelecting: (active: boolean) => void;
}

// チャンク暗号化フォーマット
/** v2 format: header includes wrapped CEK for offline recovery */
export const CHUNK_VERSION_2 = 0x02;
export const DEFAULT_CHUNK_SIZE = 1_048_576; // 1MB
export const GCM_TAG_SIZE = 16;
/** v2 header: 1B version + 4B chunk_size + 8B base_iv + 1B wcek_len + N bytes wrapped_cek */
export const HEADER_SIZE = 13;

// Google Drive MIME type for folders
export const FOLDER_MIME = "application/vnd.google-apps.folder";

// OAuth2 設定
export const OAUTH_CONFIG = {
  clientId: (import.meta.env.VITE_GOOGLE_CLIENT_ID as string) || "",
  redirectUri:
    (import.meta.env.VITE_REDIRECT_URI as string) ||
    (typeof window !== "undefined" ? `${window.location.origin}/callback` : ""),
  authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revokeEndpoint: "https://oauth2.googleapis.com/revoke",
  scope: "openid profile email https://www.googleapis.com/auth/drive.file",
} as const;

export const DRIVE_API_BASE = "https://www.googleapis.com";
