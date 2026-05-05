import { decode } from "@/utils/base64url";
import { readSegmentedAppProperty } from "@/utils/driveProperties";
import { CryptoError } from "@/utils/errors";

/**
 * Core AES-GCM decryption for metadata strings.
 */
async function decryptMetadataRaw(
  key: CryptoKey,
  ciphertextB64: string,
  ivMeta: string,
  errorMessage: string,
): Promise<string> {
  const iv = decode(ivMeta);
  if (iv.length !== 12) throw new CryptoError("IVの長さが不正です");
  const ciphertext = decode(ciphertextB64);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch (e) {
    throw new CryptoError(errorMessage, { cause: e });
  }
}

/**
 * Decrypt metadata (file name / folder name) with AES-GCM using MEK_enc
 */
export async function decryptMetadata(
  mekEnc: CryptoKey,
  encName: string,
  encName2: string | undefined,
  ivMeta: string,
): Promise<string> {
  const fullEncName = encName2 ? encName + encName2 : encName;
  return decryptMetadataRaw(
    mekEnc,
    fullEncName,
    ivMeta,
    "メタデータの復号に失敗しました（パスフレーズが違うか、データが破損しています）",
  );
}

export async function decryptMetadataFromProperties(
  mekEnc: CryptoKey,
  props: Record<string, string> | undefined,
  baseKey: string,
  ivKey: string,
): Promise<string | null> {
  const encName = readSegmentedAppProperty(props, baseKey);
  const ivMeta = props?.[ivKey];
  if (!encName || !ivMeta) {
    return null;
  }
  return decryptMetadata(mekEnc, encName, undefined, ivMeta);
}

/**
 * Decrypt metadata with a raw key (for ShareKey)
 */
export async function decryptMetadataWithKey(
  key: CryptoKey,
  encName: string,
  ivMeta: string,
): Promise<string> {
  return decryptMetadataRaw(
    key,
    encName,
    ivMeta,
    "共有データの復号に失敗しました",
  );
}

/**
 * Decrypt a chunk of data using AES-GCM
 */
export async function decryptChunk(
  key: CryptoKey,
  chunkIV: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: chunkIV },
      key,
      ciphertext,
    );
    return new Uint8Array(plaintext);
  } catch (e) {
    throw new CryptoError(
      "ファイルが改ざんされているか、鍵が正しくありません",
      { cause: e },
    );
  }
}
