export class KakusuError extends Error {
  constructor(
    message: string,
    public code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KakusuError";
  }
}

export class DriveAPIError extends KakusuError {
  constructor(
    message: string,
    public status: number,
    public retryAfterMs?: number,
    public reason?: string,
  ) {
    super(message, "DRIVE_API_ERROR");
    this.name = "DriveAPIError";
  }
}

export class CryptoError extends KakusuError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "CRYPTO_ERROR", options);
    this.name = "CryptoError";
  }
}

export class AuthError extends KakusuError {
  constructor(message: string) {
    super(message, "AUTH_ERROR");
    this.name = "AuthError";
  }
}

export function isRetryableStatus(status: number): boolean {
  return [429, 500, 502, 503].includes(status);
}

/** 403 rate-limit reasons that should be retried like a 429 */
const RETRYABLE_403_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
  "sharingRateLimitExceeded",
]);

export function isRetryableDriveError(error: unknown): boolean {
  if (!(error instanceof DriveAPIError)) return false;
  if (isRetryableStatus(error.status)) return true;
  if (
    error.status === 403 &&
    error.reason &&
    RETRYABLE_403_REASONS.has(error.reason)
  )
    return true;
  return false;
}

/**
 * Format a user-facing error message with context about what went wrong.
 * @param context A description of the operation that failed (e.g. "アップロード失敗")
 * @param error The caught error
 */
export function formatUserError(context: string, error: unknown): string {
  if (error instanceof DriveAPIError) {
    const statusInfo = describeHttpStatus(error.status);
    const detail = error.message || statusInfo;
    return `${context}: ${detail}`;
  }
  if (error instanceof CryptoError) {
    return `${context}: 暗号処理エラー — ${error.message}`;
  }
  if (error instanceof KakusuError) {
    return `${context}: ${error.message}`;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return `${context}: 操作が中止されました`;
  }
  if (error instanceof Error) {
    return `${context}: ${error.message}`;
  }
  return context;
}

function describeHttpStatus(status: number): string {
  switch (status) {
    case 401:
      return "認証の有効期限切れ（再ログインが必要）";
    case 403:
      return "アクセス権限がありません";
    case 404:
      return "ファイルが見つかりません（削除または移動された可能性）";
    case 429:
      return "リクエスト回数の上限に達しました（しばらく待ってからやり直してください）";
    case 500:
    case 502:
    case 503:
      return "Google Driveサーバーエラー（しばらく待ってからやり直してください）";
    default:
      return `HTTP ${status}`;
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries) throw error;
      if (isRetryableDriveError(error)) {
        const driveErr = error as DriveAPIError;
        const backoff = baseDelay * 2 ** i + Math.random() * 1000;
        const delay = driveErr.retryAfterMs
          ? Math.max(driveErr.retryAfterMs, backoff)
          : backoff;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error("Unreachable");
}
