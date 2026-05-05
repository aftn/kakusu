import type {
  BulkUploadBehavior,
  CacheMetadataMode,
  ParallelFileCount,
  PreviewCacheMode,
  ThemeMode,
  UserIconDisplay,
} from "@/types";

const METADATA_CACHE_MODE_KEY = "kakusu_cache_metadata_mode";
const PREVIEW_CACHE_MODE_KEY = "kakusu_cache_preview_mode";
const THEME_MODE_KEY = "kakusu_theme_mode";
const USER_ICON_DISPLAY_KEY = "kakusu_user_icon_display";
const AUTO_POPUP_LOGIN_KEY = "kakusu_auto_popup_login";
const BULK_UPLOAD_BEHAVIOR_KEY = "kakusu_bulk_upload_behavior";
const PARALLEL_FILE_COUNT_KEY = "kakusu_parallel_file_count";

const VALID_METADATA_MODES: CacheMetadataMode[] = [
  "off",
  "session",
  "24h",
  "7d",
  "unlimited",
];
const DEFAULT_METADATA_CACHE_MODE: CacheMetadataMode = "24h";
const DEFAULT_PREVIEW_CACHE_MODE: PreviewCacheMode = "memory";

function readSetting(key: string): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(key);
}

function writeSetting(key: string, value: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, value);
}

export function loadMetadataCacheMode(): CacheMetadataMode {
  const value = readSetting(METADATA_CACHE_MODE_KEY);
  return VALID_METADATA_MODES.includes(value as CacheMetadataMode)
    ? (value as CacheMetadataMode)
    : DEFAULT_METADATA_CACHE_MODE;
}

export function saveMetadataCacheMode(mode: CacheMetadataMode): void {
  writeSetting(METADATA_CACHE_MODE_KEY, mode);
}

export function loadPreviewCacheMode(): PreviewCacheMode {
  const value = readSetting(PREVIEW_CACHE_MODE_KEY);
  return value === "off" || value === "memory"
    ? value
    : DEFAULT_PREVIEW_CACHE_MODE;
}

export function savePreviewCacheMode(mode: PreviewCacheMode): void {
  writeSetting(PREVIEW_CACHE_MODE_KEY, mode);
}

/**
 * CacheMetadataMode に対応する maxAge ミリ秒を返す。
 * "off" → 0, "session" / "unlimited" → Infinity,
 * "24h" / "7d" → 対応する期間。
 * "session" は Infinity を返すが、ページ起動時に clearAllFiles() で破棄する想定。
 */
export function getCacheMaxAgeMs(mode: CacheMetadataMode): number {
  switch (mode) {
    case "off":
      return 0;
    case "session":
    case "unlimited":
      return Number.POSITIVE_INFINITY;
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
  }
}

// ── Theme / Display ──────────────────────────

const VALID_THEME_MODES: ThemeMode[] = ["system", "light", "dark"];
const VALID_ICON_DISPLAYS: UserIconDisplay[] = [
  "none",
  "icon",
  "name-icon",
  "name-email-icon",
];

export function loadThemeMode(): ThemeMode {
  const value = readSetting(THEME_MODE_KEY);
  return VALID_THEME_MODES.includes(value as ThemeMode)
    ? (value as ThemeMode)
    : "system";
}

export function saveThemeMode(mode: ThemeMode): void {
  writeSetting(THEME_MODE_KEY, mode);
}

export function loadUserIconDisplay(): UserIconDisplay {
  const value = readSetting(USER_ICON_DISPLAY_KEY);
  return VALID_ICON_DISPLAYS.includes(value as UserIconDisplay)
    ? (value as UserIconDisplay)
    : "icon";
}

export function saveUserIconDisplay(display: UserIconDisplay): void {
  writeSetting(USER_ICON_DISPLAY_KEY, display);
}

export function loadAutoPopupLogin(): boolean {
  return readSetting(AUTO_POPUP_LOGIN_KEY) === "true";
}

export function saveAutoPopupLogin(enabled: boolean): void {
  writeSetting(AUTO_POPUP_LOGIN_KEY, String(enabled));
}

// ── Bulk Upload ──────────────────────────

const VALID_BULK_UPLOAD: BulkUploadBehavior[] = ["ask", "direct", "zip"];

export function loadBulkUploadBehavior(): BulkUploadBehavior {
  const value = readSetting(BULK_UPLOAD_BEHAVIOR_KEY);
  return VALID_BULK_UPLOAD.includes(value as BulkUploadBehavior)
    ? (value as BulkUploadBehavior)
    : "ask";
}

export function saveBulkUploadBehavior(behavior: BulkUploadBehavior): void {
  writeSetting(BULK_UPLOAD_BEHAVIOR_KEY, behavior);
}

// ── Parallel File Count ──────────────────────────

const VALID_PARALLEL_COUNTS: ParallelFileCount[] = [
  "auto",
  1,
  2,
  4,
  6,
  8,
  12,
  16,
  20,
];

export function loadParallelFileCount(): ParallelFileCount {
  const value = readSetting(PARALLEL_FILE_COUNT_KEY);
  if (value === "auto") return "auto";
  const num = Number(value);
  return VALID_PARALLEL_COUNTS.includes(num as ParallelFileCount)
    ? (num as ParallelFileCount)
    : "auto";
}

export function saveParallelFileCount(count: ParallelFileCount): void {
  writeSetting(PARALLEL_FILE_COUNT_KEY, String(count));
}

/**
 * ユーザー設定に基づいた実効並列数を返すヘルパー。
 * "auto" の場合は hardwareConcurrency を基準に算出。
 * maxCap で上限を指定可能。
 */
export function getEffectiveParallelCount(maxCap = 20): number {
  const setting = loadParallelFileCount();
  if (setting === "auto") {
    const hw =
      typeof navigator !== "undefined"
        ? (navigator.hardwareConcurrency ?? 4)
        : 4;
    return Math.min(hw, maxCap);
  }
  return Math.min(setting, maxCap);
}
