import { encode } from "@/utils/base64url";
import { splitAppPropertyValue } from "@/utils/driveProperties";
import { CryptoError } from "@/utils/errors";

/**
 * Build a self-describing Drive filename from iv_meta and encrypted name.
 * Files use `[iv]_[ciphertext].enc`; folders use `[iv]_[ciphertext]`.
 *
 * This embeds both IV and ciphertext in the filename so that manually
 * downloaded files can be decrypted without appProperties.
 */
export function buildEncryptedDriveName(
  ivMeta: string,
  encNameFull: string,
  isFolder = false,
): string {
  return `${ivMeta}_${encNameFull}${isFolder ? "" : ".enc"}`;
}

/** Google Drive filename byte limit */
export const DRIVE_NAME_MAX_BYTES = 255;

/**
 * Estimate the byte length of the encrypted Drive filename for a given
 * plaintext filename.
 *
 * Format: [base64url(12B IV) = 16 chars] _ [base64url(ciphertext)] [.enc]
 * Ciphertext = UTF-8(plaintext) + 16 (GCM tag)
 * base64url length (no padding) = groups*4 + (remainder===0?0:remainder===1?2:3)
 */
export function estimateEncryptedDriveNameLength(
  plaintext: string,
  isFolder = false,
): number {
  const utf8Len = new TextEncoder().encode(plaintext).length;
  const ciphertextLen = utf8Len + 16; // AES-GCM tag
  const groups = Math.floor(ciphertextLen / 3);
  const remainder = ciphertextLen % 3;
  const base64urlLen = groups * 4 + (remainder === 0 ? 0 : remainder === 1 ? 2 : 3);
  return 16 + 1 + base64urlLen + (isFolder ? 0 : 4);
}

/** Warn threshold for encrypted Drive filename length */
export const DRIVE_NAME_WARN_BYTES = 200;
/** Block threshold for encrypted Drive filename length */
export const DRIVE_NAME_BLOCK_BYTES = 250;

/**
 * Core AES-GCM encryption for metadata strings.
 * Used internally by both encryptMetadata and encryptMetadataWithKey.
 */
async function encryptMetadataRaw(
  key: CryptoKey,
  plaintext: string,
): Promise<{ encNameFull: string; encNameParts: string[]; ivMeta: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );

  const encNameFull = encode(new Uint8Array(ciphertext));
  const ivMeta = encode(iv);
  const encNameParts = splitAppPropertyValue("enc_name", encNameFull);

  return { encNameFull, encNameParts, ivMeta };
}

/**
 * Encrypt metadata (file name / folder name) with AES-GCM using MEK_enc
 */
export async function encryptMetadata(
  mekEnc: CryptoKey,
  plaintext: string,
): Promise<{
  encName: string;
  encName2?: string;
  encNameFull: string;
  encNameParts: string[];
  ivMeta: string;
}> {
  const result = await encryptMetadataRaw(mekEnc, plaintext);
  const encName = result.encNameParts[0];
  if (!encName) throw new Error("encryptMetadata failed: empty encNameParts");
  return {
    encName,
    encName2: result.encNameParts[1],
    ...result,
  };
}

/**
 * Encrypt metadata with a raw key (for ShareKey)
 */
export async function encryptMetadataWithKey(
  key: CryptoKey,
  plaintext: string,
): Promise<{ encName: string; encNameParts: string[]; ivMeta: string }> {
  const result = await encryptMetadataRaw(key, plaintext);
  return {
    encName: result.encNameFull,
    encNameParts: result.encNameParts,
    ivMeta: result.ivMeta,
  };
}

/**
 * Encrypt a chunk of data using AES-GCM
 */
export async function encryptChunk(
  key: CryptoKey,
  chunkIV: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: chunkIV },
      key,
      plaintext,
    );
    return new Uint8Array(ciphertext);
  } catch (e) {
    throw new CryptoError(
      `暗号化に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
