import { decode, encode } from "@/utils/base64url";
import { CryptoError } from "@/utils/errors";

const SHARE_KEY_SIZE = 32; // 256bit

/**
 * Generate a random ShareKey (256-bit)
 */
export function generateShareKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SHARE_KEY_SIZE));
}

/**
 * Wrap ShareKey with MEK_wrap (AES-KW) for owner storage in meta file.
 */
export async function wrapShareKey(
  mekWrap: CryptoKey,
  shareKey: Uint8Array,
): Promise<Uint8Array> {
  try {
    // Import the raw shareKey as a CryptoKey so we can use wrapKey
    const shareKeyObj = await crypto.subtle.importKey(
      "raw",
      shareKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const wrapped = await crypto.subtle.wrapKey(
      "raw",
      shareKeyObj,
      mekWrap,
      "AES-KW",
    );
    return new Uint8Array(wrapped);
  } catch (e) {
    throw new CryptoError(
      `ShareKeyのラップに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Unwrap ShareKey with MEK_wrap (AES-KW) to recover the raw ShareKey bytes.
 */
export async function unwrapShareKey(
  mekWrap: CryptoKey,
  wrappedShareKey: Uint8Array,
): Promise<Uint8Array> {
  try {
    const key = await crypto.subtle.unwrapKey(
      "raw",
      wrappedShareKey,
      mekWrap,
      "AES-KW",
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const raw = await crypto.subtle.exportKey("raw", key);
    return new Uint8Array(raw);
  } catch (e) {
    throw new CryptoError("ShareKeyのアンラップに失敗しました", { cause: e });
  }
}

/**
 * Re-wrap a file's CEK from MEK_wrap to ShareKey in a single step.
 *
 * Internally unwraps with MEK_wrap (extractable: true), immediately re-wraps
 * with the ShareKey, and lets the extractable CryptoKey go out of scope so the
 * browser's key store can reclaim it. This avoids exposing an extractable
 * CryptoKey to callers.
 *
 * Returns base64url-encoded wrapped CEK.
 */
export async function rewrapCEKForShare(
  mekWrap: CryptoKey,
  wrappedCek: Uint8Array,
  shareKey: Uint8Array,
): Promise<string> {
  try {
    // Unwrap CEK as extractable – kept strictly local.
    let cek: CryptoKey | null = await crypto.subtle.unwrapKey(
      "raw",
      wrappedCek,
      mekWrap,
      "AES-KW",
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const shareWrapKey = await crypto.subtle.importKey(
      "raw",
      shareKey,
      "AES-KW",
      false,
      ["wrapKey"],
    );
    const wrapped = await crypto.subtle.wrapKey(
      "raw",
      cek,
      shareWrapKey,
      "AES-KW",
    );
    // Release extractable key reference immediately.
    cek = null;
    return encode(new Uint8Array(wrapped));
  } catch (e) {
    throw new CryptoError(
      `CEKの再ラップに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Unwrap a file's CEK with ShareKey using AES-KW.
 * Input is base64url-encoded wrapped CEK.
 */
export async function unwrapCEKWithShareKey(
  shareKey: Uint8Array,
  wrappedCekB64: string,
): Promise<CryptoKey> {
  try {
    const wrapKeyObj = await crypto.subtle.importKey(
      "raw",
      shareKey,
      "AES-KW",
      false,
      ["unwrapKey"],
    );
    const wrappedCek = decode(wrappedCekB64);
    return await crypto.subtle.unwrapKey(
      "raw",
      wrappedCek,
      wrapKeyObj,
      "AES-KW",
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch (e) {
    throw new CryptoError("CEKのShareKeyアンラップに失敗しました", {
      cause: e,
    });
  }
}

/**
 * Encrypt a file name with ShareKey using AES-GCM.
 * Returns base64url-encoded encrypted name and IV.
 */
export async function encryptNameWithShareKey(
  shareKey: Uint8Array,
  name: string,
): Promise<{ encName: string; ivName: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    "raw",
    shareKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const encoded = new TextEncoder().encode(name);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  return {
    encName: encode(new Uint8Array(ciphertext)),
    ivName: encode(iv),
  };
}

/**
 * Decrypt a file name with ShareKey using AES-GCM.
 * Input is base64url-encoded encrypted name and IV.
 */
export async function decryptNameWithShareKey(
  shareKey: Uint8Array,
  encNameB64: string,
  ivNameB64: string,
): Promise<string> {
  try {
    const iv = decode(ivNameB64);
    const ciphertext = decode(encNameB64);
    const key = await crypto.subtle.importKey(
      "raw",
      shareKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch (e) {
    throw new CryptoError("ファイル名の復号に失敗しました", { cause: e });
  }
}
