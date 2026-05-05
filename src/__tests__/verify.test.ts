import { deriveMEKs, generateSalt } from "@/crypto/keys";
import {
  checkPassphraseStrength,
  createVerifyData,
  verifyPassphrase,
} from "@/crypto/verify";
import { describe, expect, it } from "vitest";

describe("verify", () => {
  it("createVerifyData + verifyPassphrase round-trip", async () => {
    const salt = generateSalt();
    const { mekEnc } = await deriveMEKs("my-pass", salt);
    const { ciphertext, iv } = await createVerifyData(mekEnc);
    expect(await verifyPassphrase(mekEnc, ciphertext, iv)).toBe(true);
  });

  it("wrong key returns false", async () => {
    const salt = generateSalt();
    const { mekEnc: enc1 } = await deriveMEKs("pass-1", salt);
    const { mekEnc: enc2 } = await deriveMEKs("pass-2", salt);
    const { ciphertext, iv } = await createVerifyData(enc1);
    expect(await verifyPassphrase(enc2, ciphertext, iv)).toBe(false);
  });
});

describe("checkPassphraseStrength", () => {
  it("empty passphrase => score 0", () => {
    const result = checkPassphraseStrength("");
    expect(result.score).toBe(0);
  });

  it("short passphrase => low score", () => {
    const result = checkPassphraseStrength("abc");
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("strong passphrase => high score", () => {
    const result = checkPassphraseStrength("C0mpl3x!P@ssW0rd#2024");
    expect(result.score).toBeGreaterThanOrEqual(3);
  });
});
