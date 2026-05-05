const VERIFY_PLAINTEXT = "veld-ok";

// Passphrase strength thresholds
const MIN_PASSPHRASE_LENGTH = 8;
const MEDIUM_PASSPHRASE_LENGTH = 12;
const STRONG_PASSPHRASE_LENGTH = 16;
const MIN_CHAR_CATEGORIES = 3;
const ALL_CHAR_CATEGORIES = 4;

/**
 * Create verify.enc data with the legacy compatibility marker.
 */
export async function createVerifyData(
  mekEnc: CryptoKey,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const data = encoder.encode(VERIFY_PLAINTEXT);

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    mekEnc,
    data,
  );

  return {
    ciphertext: new Uint8Array(encrypted),
    iv,
  };
}

/**
 * Verify passphrase by decrypting verify.enc
 * Returns true if passphrase is correct
 */
export async function verifyPassphrase(
  mekEnc: CryptoKey,
  ciphertext: ArrayBuffer,
  iv: Uint8Array,
): Promise<boolean> {
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      mekEnc,
      ciphertext,
    );
    const text = new TextDecoder().decode(decrypted);
    return text === VERIFY_PLAINTEXT;
  } catch {
    return false;
  }
}

/**
 * Check passphrase strength
 * Returns { score: 0-4, feedback: string[] }
 */
export function checkPassphraseStrength(passphrase: string): {
  score: number;
  feedback: string[];
} {
  const feedback: string[] = [];
  let score = 0;

  if (passphrase.length >= MIN_PASSPHRASE_LENGTH) score++;
  else feedback.push("8文字以上にしてください");

  if (passphrase.length >= MEDIUM_PASSPHRASE_LENGTH) score++;

  const hasUpper = /[A-Z]/.test(passphrase);
  const hasLower = /[a-z]/.test(passphrase);
  const hasDigit = /[0-9]/.test(passphrase);
  const hasSymbol = /[^A-Za-z0-9]/.test(passphrase);

  const categories = [hasUpper, hasLower, hasDigit, hasSymbol].filter(
    Boolean,
  ).length;
  if (categories >= MIN_CHAR_CATEGORIES) score++;
  else
    feedback.push("英大文字・小文字・数字・記号のうち3種以上を含めてください");

  if (
    categories === ALL_CHAR_CATEGORIES &&
    passphrase.length >= STRONG_PASSPHRASE_LENGTH
  )
    score++;

  // Common patterns check
  const commonPatterns = [
    /^(password|passphrase|12345|qwerty|abc123)/i,
    /^(.)\1{4,}/,
    /^(012|123|234|345|456|567|678|789)/,
  ];
  if (commonPatterns.some((p) => p.test(passphrase))) {
    score = Math.max(0, score - 1);
    feedback.push("よく使われるパターンは避けてください");
  }

  return { score, feedback };
}
