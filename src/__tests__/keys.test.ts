import {
  deriveMEKs,
  generateCEK,
  generateNameKey,
  generateSalt,
  generateVaultKey,
  importAESKey,
  unwrapCEK,
  unwrapNameKey,
  unwrapVaultKey,
  wrapCEK,
  wrapNameKey,
  wrapVaultKey,
} from "@/crypto/keys";
import { describe, expect, it } from "vitest";

describe("generateSalt", () => {
  it("returns 16 bytes", () => {
    const salt = generateSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(16);
  });

  it("generates different salts", () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a).not.toEqual(b);
  });
});

describe("deriveMEKs", () => {
  it("derives two CryptoKey objects", async () => {
    const salt = generateSalt();
    const { mekEnc, mekWrap } = await deriveMEKs("test-passphrase", salt);
    expect(mekEnc).toBeInstanceOf(CryptoKey);
    expect(mekWrap).toBeInstanceOf(CryptoKey);
  });

  it("same passphrase + salt => same keys", async () => {
    const salt = generateSalt();
    const a = await deriveMEKs("same-pass", salt);
    const b = await deriveMEKs("same-pass", salt);
    // Can't compare CryptoKey directly, but we can encrypt/decrypt to verify
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("hello");
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      a.mekEnc,
      data,
    );
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      b.mekEnc,
      ct,
    );
    expect(new TextDecoder().decode(pt)).toBe("hello");
  });

  it("different passphrase => different keys", async () => {
    const salt = generateSalt();
    const a = await deriveMEKs("pass-a", salt);
    const b = await deriveMEKs("pass-b", salt);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("hello");
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      a.mekEnc,
      data,
    );
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, b.mekEnc, ct),
    ).rejects.toThrow();
  });
});

describe("CEK wrap/unwrap", () => {
  it("round-trips a CEK", async () => {
    const salt = generateSalt();
    const { mekWrap } = await deriveMEKs("test", salt);
    const cek = await generateCEK();

    const wrapped = await wrapCEK(mekWrap, cek);
    expect(wrapped).toBeInstanceOf(Uint8Array);
    // AES-KW wraps 32B key into 40B
    expect(wrapped.length).toBe(40);

    const unwrapped = await unwrapCEK(mekWrap, wrapped);
    expect(unwrapped).toBeInstanceOf(CryptoKey);

    // Verify the unwrapped key works
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("test data");
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cek, data);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      unwrapped,
      ct,
    );
    expect(new TextDecoder().decode(pt)).toBe("test data");
  });

  it("wrong key fails to unwrap", async () => {
    const salt = generateSalt();
    const { mekWrap: wrapA } = await deriveMEKs("keyA", salt);
    const { mekWrap: wrapB } = await deriveMEKs("keyB", salt);
    const cek = await generateCEK();
    const wrapped = await wrapCEK(wrapA, cek);
    await expect(unwrapCEK(wrapB, wrapped)).rejects.toThrow();
  });
});

describe("importAESKey", () => {
  it("imports a 32-byte key", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await importAESKey(raw);
    expect(key).toBeInstanceOf(CryptoKey);
  });
});

describe("VaultKey wrap/unwrap", () => {
  it("unwrapVaultKey defaults to non-extractable", async () => {
    const salt = generateSalt();
    const { mekWrap } = await deriveMEKs("test", salt);
    const vaultKey = await generateVaultKey();
    const wrapped = await wrapVaultKey(mekWrap, vaultKey);
    const unwrapped = await unwrapVaultKey(mekWrap, wrapped);
    await expect(crypto.subtle.exportKey("raw", unwrapped)).rejects.toThrow();
  });

  it("unwrapVaultKey with extractable=true allows export", async () => {
    const salt = generateSalt();
    const { mekWrap } = await deriveMEKs("test", salt);
    const vaultKey = await generateVaultKey();
    const wrapped = await wrapVaultKey(mekWrap, vaultKey);
    const unwrapped = await unwrapVaultKey(mekWrap, wrapped, true);
    const raw = await crypto.subtle.exportKey("raw", unwrapped);
    expect(new Uint8Array(raw).length).toBe(32);
  });

  it("non-extractable vaultKey can still wrapKey/unwrapKey", async () => {
    const salt = generateSalt();
    const { mekWrap } = await deriveMEKs("test", salt);
    const vaultKey = await generateVaultKey();
    const wrapped = await wrapVaultKey(mekWrap, vaultKey);
    const unwrapped = await unwrapVaultKey(mekWrap, wrapped);

    const cek = await generateCEK();
    const wrappedCek = await wrapCEK(unwrapped, cek);
    const unwrappedCek = await unwrapCEK(unwrapped, wrappedCek);
    expect(unwrappedCek).toBeInstanceOf(CryptoKey);
  });
});

describe("VaultKey wrap/unwrap (pinning)", () => {
  it("round-trips a VaultKey: wrapped CEK works identically", async () => {
    const salt = generateSalt();
    const { mekWrap } = await deriveMEKs("test", salt);
    const vaultKey = await generateVaultKey();
    const wrapped = await wrapVaultKey(mekWrap, vaultKey);
    // AES-KW wraps 32-byte key into 40 bytes
    expect(wrapped.length).toBe(40);

    const unwrapped = await unwrapVaultKey(mekWrap, wrapped, false);
    // Verify functionality: wrap/unwrap a CEK with the restored VaultKey
    const cek = await generateCEK();
    const cekWrapped = await crypto.subtle.wrapKey(
      "raw",
      cek,
      vaultKey,
      "AES-KW",
    );
    const cekUnwrapped = await crypto.subtle.unwrapKey(
      "raw",
      cekWrapped,
      unwrapped,
      "AES-KW",
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      cek,
      new Uint8Array([1, 2, 3]),
    );
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      cekUnwrapped,
      ct,
    );
    expect(new Uint8Array(pt)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("wrong mekWrap fails to unwrap VaultKey", async () => {
    const salt = generateSalt();
    const { mekWrap: wrapA } = await deriveMEKs("keyA", salt);
    const { mekWrap: wrapB } = await deriveMEKs("keyB", salt);
    const vaultKey = await generateVaultKey();
    const wrapped = await wrapVaultKey(wrapA, vaultKey);
    await expect(unwrapVaultKey(wrapB, wrapped)).rejects.toThrow();
  });
});

describe("NameKey wrap/unwrap (pinning)", () => {
  it("round-trips a NameKey: encrypt/decrypt works identically", async () => {
    const salt = generateSalt();
    const { mekWrap } = await deriveMEKs("test", salt);
    const nameKey = await generateNameKey();
    const wrapped = await wrapNameKey(mekWrap, nameKey);
    expect(wrapped.length).toBe(40);

    const unwrapped = await unwrapNameKey(mekWrap, wrapped, false);
    // Verify: encrypt with original, decrypt with restored
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("ファイル名.txt");
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      nameKey,
      data,
    );
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      unwrapped,
      ct,
    );
    expect(new TextDecoder().decode(pt)).toBe("ファイル名.txt");
  });

  it("wrong mekWrap fails to unwrap NameKey", async () => {
    const salt = generateSalt();
    const { mekWrap: wrapA } = await deriveMEKs("keyA", salt);
    const { mekWrap: wrapB } = await deriveMEKs("keyB", salt);
    const nameKey = await generateNameKey();
    const wrapped = await wrapNameKey(wrapA, nameKey);
    await expect(unwrapNameKey(wrapB, wrapped)).rejects.toThrow();
  });
});

describe("NameKey wrap/unwrap", () => {
  it("unwrapNameKey defaults to non-extractable", async () => {
    const salt = generateSalt();
    const { mekWrap } = await deriveMEKs("test", salt);
    const nameKey = await generateNameKey();
    const wrapped = await wrapNameKey(mekWrap, nameKey);
    const unwrapped = await unwrapNameKey(mekWrap, wrapped);
    await expect(crypto.subtle.exportKey("raw", unwrapped)).rejects.toThrow();
  });

  it("unwrapNameKey with extractable=true allows export", async () => {
    const salt = generateSalt();
    const { mekWrap } = await deriveMEKs("test", salt);
    const nameKey = await generateNameKey();
    const wrapped = await wrapNameKey(mekWrap, nameKey);
    const unwrapped = await unwrapNameKey(mekWrap, wrapped, true);
    const raw = await crypto.subtle.exportKey("raw", unwrapped);
    expect(new Uint8Array(raw).length).toBe(32);
  });

  it("non-extractable nameKey can still encrypt/decrypt", async () => {
    const salt = generateSalt();
    const { mekWrap } = await deriveMEKs("test", salt);
    const nameKey = await generateNameKey();
    const wrapped = await wrapNameKey(mekWrap, nameKey);
    const unwrapped = await unwrapNameKey(mekWrap, wrapped);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("test-filename");
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      unwrapped,
      data,
    );
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      unwrapped,
      ct,
    );
    expect(new TextDecoder().decode(pt)).toBe("test-filename");
  });
});
