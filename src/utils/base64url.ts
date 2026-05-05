const BASE64URL_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Pre-computed reverse lookup table (created once at module load)
const BASE64URL_LOOKUP = /* @__PURE__ */ (() => {
  const table = new Uint8Array(128);
  for (let i = 0; i < BASE64URL_CHARS.length; i++) {
    table[BASE64URL_CHARS.charCodeAt(i)] = i;
  }
  return table;
})();

export function encode(data: Uint8Array): string {
  let result = "";
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i]!;
    const b1 = data[i + 1];
    const b2 = data[i + 2];

    result += BASE64URL_CHARS[b0 >> 2];
    result += BASE64URL_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) {
      result += BASE64URL_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    }
    if (b2 !== undefined) {
      result += BASE64URL_CHARS[b2 & 0x3f];
    }
  }
  return result;
}

export function decode(str: string): Uint8Array {
  const len = str.length;
  const outLen = Math.floor((len * 3) / 4);
  const out = new Uint8Array(outLen);

  let j = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = BASE64URL_LOOKUP[str.charCodeAt(i)]!;
    const c1 = BASE64URL_LOOKUP[str.charCodeAt(i + 1)]!;
    const c2 = i + 2 < len ? BASE64URL_LOOKUP[str.charCodeAt(i + 2)]! : 0;
    const c3 = i + 3 < len ? BASE64URL_LOOKUP[str.charCodeAt(i + 3)]! : 0;

    out[j++] = (c0 << 2) | (c1 >> 4);
    if (i + 2 < len) out[j++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (i + 3 < len) out[j++] = ((c2 & 0x03) << 6) | c3;
  }

  return out.slice(0, j);
}

// Standard Base64 (for appProperties)
export function toBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

export function fromBase64(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
