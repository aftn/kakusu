import {
  decodeShareKey,
  encodeShareKey,
  parseShareFragment,
} from "@/crypto/share";
import { describe, expect, it } from "vitest";

function generateShareKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

describe("ShareKey encoding", () => {
  it("encode/decode round-trip", () => {
    const key = generateShareKey();
    expect(key.length).toBe(32);
    const encoded = encodeShareKey(key);
    const decoded = decodeShareKey(encoded);
    expect(decoded).toEqual(key);
  });

  it("encodeShareKey produces URL-safe string", () => {
    const key = generateShareKey();
    const encoded = encodeShareKey(key);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("parseShareFragment", () => {
  it("parses a valid v2 fragment", () => {
    const key = generateShareKey();
    const encoded = encodeShareKey(key);
    const hash = `#m=metaFile123&k=${encoded}`;
    const parsed = parseShareFragment(hash);
    expect(parsed).not.toBeNull();
    expect(parsed?.metaFileId).toBe("metaFile123");
    expect(parsed?.shareKey).toEqual(key);
  });

  it("returns null for empty hash", () => {
    expect(parseShareFragment("")).toBeNull();
  });

  it("returns null for missing metaFileId", () => {
    const key = generateShareKey();
    const encoded = encodeShareKey(key);
    expect(parseShareFragment(`#k=${encoded}`)).toBeNull();
  });

  it("returns null for missing key", () => {
    expect(parseShareFragment("#m=abc")).toBeNull();
  });

  it("returns null for invalid key length", () => {
    expect(parseShareFragment("#m=abc&k=short")).toBeNull();
  });

  it("returns null for oversized fields", () => {
    const key = generateShareKey();
    const encoded = encodeShareKey(key);
    const huge = "a".repeat(5000);
    expect(parseShareFragment(`#m=${huge}&k=${encoded}`)).toBeNull();
  });
});
