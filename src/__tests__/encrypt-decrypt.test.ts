import {
  decryptChunk,
  decryptMetadata,
  decryptMetadataWithKey,
} from "@/crypto/decrypt";
import {
  buildEncryptedDriveName,
  encryptChunk,
  encryptMetadata,
  encryptMetadataWithKey,
  estimateEncryptedDriveNameLength,
} from "@/crypto/encrypt";
import { deriveMEKs, generateSalt, importAESKey } from "@/crypto/keys";
import { describe, expect, it } from "vitest";

describe("metadata encryption", () => {
  it("encrypts and decrypts a short file name", async () => {
    const salt = generateSalt();
    const { mekEnc } = await deriveMEKs("test-pass", salt);
    const name = "report.pdf";
    const { encName, encName2, ivMeta } = await encryptMetadata(mekEnc, name);
    expect(encName.length).toBeGreaterThan(0);
    expect(encName2).toBeUndefined();
    const decrypted = await decryptMetadata(mekEnc, encName, encName2, ivMeta);
    expect(decrypted).toBe(name);
  });

  it("handles long file names with split enc_name", async () => {
    const salt = generateSalt();
    const { mekEnc } = await deriveMEKs("test-pass", salt);
    // Base64 化後の暗号文が 124 文字を超える長い名前を使う。
    const name = `${"これはとても長いファイル名です".repeat(5)}.txt`;
    const { encName, encName2, encNameFull, encNameParts, ivMeta } =
      await encryptMetadata(mekEnc, name);
    expect(encName.length + "enc_name".length).toBeLessThanOrEqual(124);
    expect(
      encNameParts.every((part, index) => {
        const key = index === 0 ? "enc_name" : `enc_name_${index + 1}`;
        return part.length + key.length <= 124;
      }),
    ).toBe(true);
    expect(encName2).toBeDefined();
    const decrypted = await decryptMetadata(
      mekEnc,
      encNameFull,
      undefined,
      ivMeta,
    );
    expect(decrypted).toBe(name);
  });

  it("supports file names that require more than two appProperties parts", async () => {
    const salt = generateSalt();
    const { mekEnc } = await deriveMEKs("test-pass", salt);
    const name = `${"長い名前".repeat(40)}.bin`;
    const { encNameFull, encNameParts, ivMeta } = await encryptMetadata(
      mekEnc,
      name,
    );
    expect(encNameParts.length).toBeGreaterThan(2);
    const decrypted = await decryptMetadata(
      mekEnc,
      encNameFull,
      undefined,
      ivMeta,
    );
    expect(decrypted).toBe(name);
  });

  it("omits .enc for encrypted folder drive names", async () => {
    const salt = generateSalt();
    const { mekEnc } = await deriveMEKs("test-pass", salt);
    const { encNameFull, ivMeta } = await encryptMetadata(
      mekEnc,
      "新しいフォルダ",
    );
    const driveName = buildEncryptedDriveName(ivMeta, encNameFull, true);
    expect(driveName.endsWith(".enc")).toBe(false);
    const driveNameBytes = new TextEncoder().encode(driveName).length;
    expect(estimateEncryptedDriveNameLength("新しいフォルダ", true)).toBe(
      driveNameBytes,
    );
  });

  it("wrong key fails to decrypt", async () => {
    const salt = generateSalt();
    const { mekEnc: enc1 } = await deriveMEKs("pass-1", salt);
    const { mekEnc: enc2 } = await deriveMEKs("pass-2", salt);
    const { encName, encName2, ivMeta } = await encryptMetadata(
      enc1,
      "secret.txt",
    );
    await expect(
      decryptMetadata(enc2, encName, encName2, ivMeta),
    ).rejects.toThrow();
  });

  it("ShareKey based encrypt/decrypt", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await importAESKey(raw);
    const { encName, ivMeta } = await encryptMetadataWithKey(key, "shared.pdf");
    const decrypted = await decryptMetadataWithKey(key, encName, ivMeta);
    expect(decrypted).toBe("shared.pdf");
  });
});

describe("chunk encryption", () => {
  it("encrypts and decrypts a chunk", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await importAESKey(raw);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = crypto.getRandomValues(new Uint8Array(1024));
    const ciphertext = await encryptChunk(key, iv, plaintext);
    // 暗号文は平文に 16 バイトの認証タグが付いた長さになる。
    expect(ciphertext.length).toBe(1024 + 16);
    const decrypted = await decryptChunk(key, iv, ciphertext);
    expect(decrypted).toEqual(plaintext);
  });
});
