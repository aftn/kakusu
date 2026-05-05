import { decode, encode, fromBase64, toBase64 } from "@/utils/base64url";
import { describe, expect, it } from "vitest";

describe("base64url", () => {
  it("encode/decode round-trip for empty buffer", () => {
    const data = new Uint8Array(0);
    expect(decode(encode(data))).toEqual(data);
  });

  it("encode/decode round-trip for 1 byte", () => {
    const data = new Uint8Array([0xff]);
    expect(decode(encode(data))).toEqual(data);
  });

  it("encode/decode round-trip for 2 bytes", () => {
    const data = new Uint8Array([0xab, 0xcd]);
    expect(decode(encode(data))).toEqual(data);
  });

  it("encode/decode round-trip for 3 bytes", () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(decode(encode(data))).toEqual(data);
  });

  it("encode/decode round-trip for 32 bytes", () => {
    const data = crypto.getRandomValues(new Uint8Array(32));
    expect(decode(encode(data))).toEqual(data);
  });

  it("encode produces URL-safe characters only", () => {
    const data = crypto.getRandomValues(new Uint8Array(100));
    const encoded = encode(data);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
  });

  it("encode does not produce padding", () => {
    const data = new Uint8Array([1, 2]);
    const encoded = encode(data);
    expect(encoded).not.toContain("=");
  });
});

describe("standard base64", () => {
  it("toBase64/fromBase64 round-trip", () => {
    const data = crypto.getRandomValues(new Uint8Array(48));
    const encoded = toBase64(data);
    const decoded = fromBase64(encoded);
    expect(decoded).toEqual(data);
  });

  it("toBase64 uses standard alphabet", () => {
    const data = crypto.getRandomValues(new Uint8Array(100));
    const encoded = toBase64(data);
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]*$/);
  });
});
