import { CryptoError } from "@/utils/errors";

const PBKDF2_ITERATIONS = 600_000;
const SALT_SIZE = 16;
const HKDF_INFO_META_ENCRYPTION = new TextEncoder().encode(
  "veld-meta-encryption",
);
const HKDF_INFO_KEY_WRAPPING = new TextEncoder().encode("veld-key-wrapping");

/**
 * Generate a random salt for PBKDF2
 */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_SIZE));
}

/**
 * Derive KEK from passphrase via PBKDF2-SHA256
 */
async function deriveKEK(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const kekBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    256,
  );

  // Import as HKDF key for sub-key derivation
  return crypto.subtle.importKey("raw", kekBits, "HKDF", false, ["deriveBits"]);
}

/**
 * Derive sub-key using HKDF-SHA256
 *
 * Salt is intentionally empty (zero-length). Per RFC 5869, HKDF does not
 * strictly require a random salt when the input keying material (IKM) already
 * has high entropy. Our IKM is the output of PBKDF2 (600k iterations + 16-byte
 * random salt), so it is a full-entropy 256-bit key. Domain separation between
 * sub-keys is achieved via distinct legacy compatibility `info` strings.
 *
 * Changing the salt value would silently break decryption for every existing
 * vault, so this MUST remain `new Uint8Array(0)` for backward compatibility.
 */
async function deriveSubKey(
  kek: CryptoKey,
  info: Uint8Array,
  algorithm: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info,
    },
    kek,
    256,
  );

  return crypto.subtle.importKey(
    "raw",
    bits,
    { name: algorithm },
    false,
    usages,
  );
}

/**
 * Derive MEK_enc and MEK_wrap from passphrase + salt
 * Returns both CryptoKey objects (extractable: false)
 */
export async function deriveMEKs(
  passphrase: string,
  salt: Uint8Array,
): Promise<{ mekEnc: CryptoKey; mekWrap: CryptoKey }> {
  try {
    const kek = await deriveKEK(passphrase, salt);

    const [mekEnc, mekWrap] = await Promise.all([
      deriveSubKey(kek, HKDF_INFO_META_ENCRYPTION, "AES-GCM", [
        "encrypt",
        "decrypt",
      ]),
      deriveSubKey(kek, HKDF_INFO_KEY_WRAPPING, "AES-KW", [
        "wrapKey",
        "unwrapKey",
      ]),
    ]);

    return { mekEnc, mekWrap };
  } catch (e) {
    throw new CryptoError(
      `鍵導出に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Generate a random CEK (Content Encryption Key) for file encryption
 */
export async function generateCEK(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

// ── Internal wrap/unwrap helpers ──────────────────────────────

async function wrapKeyRaw(
  wrappingKey: CryptoKey,
  keyToWrap: CryptoKey,
  errorLabel: string,
): Promise<Uint8Array> {
  try {
    const wrapped = await crypto.subtle.wrapKey(
      "raw",
      keyToWrap,
      wrappingKey,
      "AES-KW",
    );
    return new Uint8Array(wrapped);
  } catch (e) {
    throw new CryptoError(
      `${errorLabel}のラップに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function unwrapKeyRaw(
  unwrappingKey: CryptoKey,
  wrappedKey: Uint8Array,
  algorithm: AesKeyGenParams,
  usages: KeyUsage[],
  extractable: boolean,
  errorMessage: string,
): Promise<CryptoKey> {
  try {
    return await crypto.subtle.unwrapKey(
      "raw",
      wrappedKey,
      unwrappingKey,
      "AES-KW",
      algorithm,
      extractable,
      usages,
    );
  } catch (e) {
    throw new CryptoError(errorMessage, { cause: e });
  }
}

// ── CEK (Content Encryption Key) ─────────────────────────────

/**
 * Wrap CEK with MEK_wrap using AES-KW
 */
export async function wrapCEK(
  mekWrap: CryptoKey,
  cek: CryptoKey,
): Promise<Uint8Array> {
  return wrapKeyRaw(mekWrap, cek, "CEK");
}

/**
 * Unwrap CEK with MEK_wrap using AES-KW
 */
export async function unwrapCEK(
  mekWrap: CryptoKey,
  wrappedCek: Uint8Array,
  extractable = false,
): Promise<CryptoKey> {
  return unwrapKeyRaw(
    mekWrap,
    wrappedCek,
    { name: "AES-GCM", length: 256 },
    ["encrypt", "decrypt"],
    extractable,
    "ファイルの鍵が破損しています",
  );
}

/**
 * Import raw bytes as an AES-GCM key (for ShareKey)
 */
export async function importAESKey(
  rawKey: Uint8Array,
  usages: KeyUsage[] = ["encrypt", "decrypt"],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

// ── Vault Key (Envelope Encryption) ──────────────────────────

/**
 * Generate a random 256-bit Vault Key for CEK wrapping.
 * The Vault Key itself is wrapped by MEK_wrap and stored in DO_NOT_DELETE.
 */
export async function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, true, [
    "wrapKey",
    "unwrapKey",
  ]);
}

/**
 * Wrap (encrypt) the Vault Key with MEK_wrap using AES-KW.
 */
export async function wrapVaultKey(
  mekWrap: CryptoKey,
  vaultKey: CryptoKey,
): Promise<Uint8Array> {
  return wrapKeyRaw(mekWrap, vaultKey, "Vault Key");
}

/**
 * Unwrap (decrypt) the Vault Key with MEK_wrap using AES-KW.
 */
export async function unwrapVaultKey(
  mekWrap: CryptoKey,
  wrappedVaultKey: Uint8Array,
  extractable = false,
): Promise<CryptoKey> {
  return unwrapKeyRaw(
    mekWrap,
    wrappedVaultKey,
    { name: "AES-KW", length: 256 },
    ["wrapKey", "unwrapKey"],
    extractable,
    "Vault Keyの復元に失敗しました",
  );
}

// ── Name Key (Envelope Encryption for filenames) ─────────────

/**
 * Generate a random 256-bit Name Key for filename encryption.
 * The Name Key is wrapped by MEK_wrap and stored in DO_NOT_DELETE.
 */
export async function generateNameKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Wrap (encrypt) the Name Key with MEK_wrap using AES-KW.
 */
export async function wrapNameKey(
  mekWrap: CryptoKey,
  nameKey: CryptoKey,
): Promise<Uint8Array> {
  return wrapKeyRaw(mekWrap, nameKey, "Name Key");
}

/**
 * Unwrap (decrypt) the Name Key with MEK_wrap using AES-KW.
 */
export async function unwrapNameKey(
  mekWrap: CryptoKey,
  wrappedNameKey: Uint8Array,
  extractable = false,
): Promise<CryptoKey> {
  return unwrapKeyRaw(
    mekWrap,
    wrappedNameKey,
    { name: "AES-GCM", length: 256 },
    ["encrypt", "decrypt"],
    extractable,
    "Name Keyの復元に失敗しました",
  );
}
