/**
 * Validate Drive file/folder ID format (alphanumeric + hyphens + underscores).
 * Prevents injection of arbitrary strings into Drive API query parameters.
 */
export function assertSafeId(id: string): void {
  if (!/^[\w-]+$/.test(id)) {
    throw new Error("Invalid Drive ID format");
  }
}

/** Google Drive ファイル名の最大バイト数 (UTF-8) */
export const DRIVE_NAME_MAX_BYTES = 255;

/** 共有名・フォルダ名など汎用テキスト入力の最大文字数 */
export const TEXT_INPUT_MAX_LENGTH = 200;

/** パスフレーズの最大文字数（PBKDF2 に渡す上限） */
export const PASSPHRASE_MAX_LENGTH = 1024;

/** 制御文字を除去し、先頭・末尾の空白をトリムする */
export function sanitizeTextInput(text: string): string {
  let sanitized = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 32 && code !== 127) {
      sanitized += char;
    }
  }
  return sanitized.trim();
}

/**
 * Google Drive フォルダ名として安全かを検証する。
 * UTF-8 で 255 バイト以内、制御文字なし。
 */
export function validateDriveFolderName(name: string): string | null {
  if (!name) return "名前を入力してください";
  const byteLen = new TextEncoder().encode(name).length;
  if (byteLen > DRIVE_NAME_MAX_BYTES) {
    return `名前が長すぎます（${byteLen}バイト、上限${DRIVE_NAME_MAX_BYTES}バイト）`;
  }
  return null;
}

/** カンマ区切りメールアドレスをパースし検証する。無効なエントリの一覧を返す。 */
export function validateEmails(input: string): {
  valid: string[];
  invalid: string[];
} {
  const raw = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const addr of raw) {
    if (emailRegex.test(addr) && addr.length <= 254) {
      valid.push(addr);
    } else {
      invalid.push(addr);
    }
  }
  return { valid, invalid };
}
