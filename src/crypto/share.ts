import { decode, encode } from "@/utils/base64url";

const MAX_SHARE_FRAGMENT_LENGTH = 12_000;
const MAX_SHARE_FILE_ID_LENGTH = 256;
const MAX_SHARE_KEY_LENGTH = 128;

/**
 * Encode ShareKey to base64url for URL fragment
 */
export function encodeShareKey(key: Uint8Array): string {
  return encode(key);
}

/**
 * Decode ShareKey from base64url
 */
export function decodeShareKey(encoded: string): Uint8Array {
  return decode(encoded);
}

/**
 * Build share URL for meta-file approach.
 * Format: /share#m=<metaFileId>&k=<ShareKey(Base64URL)>
 */
export function buildShareURL(
  metaFileId: string,
  shareKey: Uint8Array,
): string {
  const keyStr = encodeShareKey(shareKey);
  const params = new URLSearchParams({
    m: metaFileId,
    k: keyStr,
  });
  return `${window.location.origin}/share#${params.toString()}`;
}

/** Share fragment data */
export interface ShareFragmentData {
  metaFileId: string;
  shareKey: Uint8Array;
}

/**
 * Parse share URL fragment.
 * Format: #m=<metaFileId>&k=<ShareKey(Base64URL)>
 */
export function parseShareFragment(hash: string): ShareFragmentData | null {
  if (!hash || hash.length < 2) return null;
  if (hash.length > MAX_SHARE_FRAGMENT_LENGTH) return null;

  const params = new URLSearchParams(hash.slice(1));

  const metaFileId = params.get("m");
  const shareKeyB64 = params.get("k");
  if (!metaFileId || !shareKeyB64) return null;
  if (
    metaFileId.length > MAX_SHARE_FILE_ID_LENGTH ||
    shareKeyB64.length > MAX_SHARE_KEY_LENGTH
  ) {
    return null;
  }
  if (!/^[\w-]+$/.test(metaFileId)) return null;
  try {
    const shareKey = decodeShareKey(shareKeyB64);
    if (shareKey.length !== 32) return null;
    return { metaFileId, shareKey };
  } catch {
    return null;
  }
}
