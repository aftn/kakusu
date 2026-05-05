export const APP_NAME = "KaKuSu";
export const APP_SLUG = "kakusu";
export const APP_GITHUB_URL =
  (import.meta.env.VITE_GITHUB_URL as string)?.trim().replace(/\/$/, "") ||
  "https://github.com/aftn/kakusu";

const publicSiteUrl = (import.meta.env.VITE_PUBLIC_SITE_URL as string)
  ?.trim()
  .replace(/\/$/, "");
export const PUBLIC_SITE_ORIGIN = publicSiteUrl || "";
export const MECHANISM_URL = publicSiteUrl
  ? `${publicSiteUrl}/mechanism/`
  : "";
export const PRIVACY_POLICY_URL = publicSiteUrl
  ? `${publicSiteUrl}/privacy-policy/`
  : "";
export const TERMS_OF_SERVICE_URL = publicSiteUrl
  ? `${publicSiteUrl}/terms/`
  : "";
export const MULTIPART_BOUNDARY_PREFIX = "kakusu_boundary_";

// Upload / download thresholds
export const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 4 * 1024 * 1024; // 4MB
export const RESUMABLE_CHUNK_SIZE = 8 * 1024 * 1024; // 8MB (must be multiple of 256KB)
export const LARGE_FILE_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5MB
export const UPLOAD_CONCURRENCY_DEFAULT = 3;
export const MAX_RECURSION_DEPTH = 50;
export const MARKDOWN_PREVIEW_CODE_BLOCK_TOKEN_PREFIX = "%%KAKUSU_CODE_BLOCK_";
export const MARKDOWN_PREVIEW_INLINE_CODE_TOKEN_PREFIX =
  "%%KAKUSU_INLINE_CODE_";

export const DRIVE_APP_PROPERTY_KEYS = {
  rootMarker: "kakusu_root",
  rootVersion: "kakusu_version",
  salt: "kakusu_salt",
  shared: "kakusu_shared",
} as const;

export const SESSION_STORAGE_KEYS = {
  oauthSilentFailed: "kakusu_oauth_silent_failed",
  accessToken: "kakusu_access_token",
  expiresAt: "kakusu_expires_at",
  accessScope: "kakusu_access_scope",
  shareMetaId: "kakusu_share_meta_id",
  shareKey: "kakusu_share_key",
  shareTimestamp: "kakusu_share_ts",
} as const;

export const DATABASE_NAMES = {
  current: "kakusu-cache",
} as const;
