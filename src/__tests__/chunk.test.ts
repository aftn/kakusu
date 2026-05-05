import {
  buildChunkIV,
  decryptFile,
  encryptFile,
  parseHeader,
} from "@/crypto/chunk";
import { importAESKey } from "@/crypto/keys";
import { HEADER_SIZE } from "@/types";
import { describe, expect, it } from "vitest";

describe("buildChunkIV", () => {
  it("creates a 12-byte IV", () => {
    const base = crypto.getRandomValues(new Uint8Array(8));
    const iv = buildChunkIV(base, 0);
    expect(iv.length).toBe(12);
    expect(iv.slice(0, 8)).toEqual(base);
  });

  it("different indices give different IVs", () => {
    const base = crypto.getRandomValues(new Uint8Array(8));
    const iv0 = buildChunkIV(base, 0);
    const iv1 = buildChunkIV(base, 1);
    expect(iv0).not.toEqual(iv1);
  });

  it("index is big-endian in last 4 bytes", () => {
    const base = new Uint8Array(8);
    const iv = buildChunkIV(base, 256);
    const view = new DataView(iv.buffer, 8, 4);
    expect(view.getUint32(0, false)).toBe(256);
  });
});

describe("encryptFile / decryptFile", () => {
  it("round-trips small data", async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await importAESKey(rawKey);
    const plaintext = new TextEncoder().encode("Hello, KaKuSu!");
    const { encrypted } = await encryptFile(key, plaintext.buffer);

    // Check header — v2 format
    const encArray = new Uint8Array(await encrypted.arrayBuffer());
    expect(encArray[0]).toBe(0x02); // version 2
    expect(encArray.length).toBeGreaterThan(HEADER_SIZE);

    const decrypted = await decryptFile(key, await encrypted.arrayBuffer());
    expect(decrypted).toEqual(plaintext);
  });

  it("round-trips data larger than one chunk", async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await importAESKey(rawKey);
    // Use small chunk size for testing
    const plaintext = crypto.getRandomValues(new Uint8Array(5000));
    const { encrypted } = await encryptFile(key, plaintext.buffer, 1024);

    const decrypted = await decryptFile(key, await encrypted.arrayBuffer());
    expect(decrypted).toEqual(plaintext);
  });

  it("round-trips empty data", async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await importAESKey(rawKey);
    const plaintext = new Uint8Array(0);
    const { encrypted } = await encryptFile(key, plaintext.buffer);
    const decrypted = await decryptFile(key, await encrypted.arrayBuffer());
    expect(decrypted).toEqual(plaintext);
  });

  it("wrong key fails to decrypt", async () => {
    const key1 = await importAESKey(crypto.getRandomValues(new Uint8Array(32)));
    const key2 = await importAESKey(crypto.getRandomValues(new Uint8Array(32)));
    const plaintext = new TextEncoder().encode("secret");
    const { encrypted } = await encryptFile(key1, plaintext.buffer);
    await expect(
      decryptFile(key2, await encrypted.arrayBuffer()),
    ).rejects.toThrow();
  });
});

describe("parseHeader", () => {
  it("parses a valid v2 header", () => {
    // v2 header: [version=0x02][4B chunkSize][8B baseIV][1B wcekLen=4][4B wrappedCek]
    const wcek = new Uint8Array([10, 20, 30, 40]);
    const header = new Uint8Array(HEADER_SIZE + 1 + wcek.length);
    header[0] = 0x02;
    const view = new DataView(header.buffer, 1, 4);
    view.setUint32(0, 1048576, false);
    header.set(crypto.getRandomValues(new Uint8Array(8)), 5);
    header[13] = wcek.length;
    header.set(wcek, 14);
    const parsed = parseHeader(header);
    expect(parsed.version).toBe(2);
    expect(parsed.chunkSize).toBe(1048576);
    expect(parsed.baseIV.length).toBe(8);
    expect(parsed.wrappedCek).toEqual(wcek);
  });

  it("rejects short data", () => {
    expect(() => parseHeader(new Uint8Array(5))).toThrow();
  });

  it("rejects wrong version", () => {
    const header = new Uint8Array(HEADER_SIZE + 1);
    header[0] = 0x01; // v1 is no longer supported
    expect(() => parseHeader(header)).toThrow();
  });

  it("rejects zero chunkSize", () => {
    const header = new Uint8Array(HEADER_SIZE + 1);
    header[0] = 0x02;
    header[13] = 0; // wcek_len = 0
    // chunkSize = 0
    expect(() => parseHeader(header)).toThrow("チャンクサイズが範囲外です");
  });

  it("rejects chunkSize exceeding 64MB", () => {
    const header = new Uint8Array(HEADER_SIZE + 1);
    header[0] = 0x02;
    const view = new DataView(header.buffer, 1, 4);
    view.setUint32(0, 128 * 1024 * 1024, false); // 128MB
    header[13] = 0; // wcek_len = 0
    expect(() => parseHeader(header)).toThrow("チャンクサイズが範囲外です");
  });
});
