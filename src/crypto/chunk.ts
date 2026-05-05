import {
  CHUNK_VERSION_2,
  DEFAULT_CHUNK_SIZE,
  GCM_TAG_SIZE,
  HEADER_SIZE,
} from "@/types";
import { CryptoError } from "@/utils/errors";
import { decryptChunk } from "./decrypt";
import { encryptChunk } from "./encrypt";

const MAX_WORKER_CONCURRENCY = 8;

/**
 * Run an async task for each index [0, count) with bounded concurrency.
 * The `task` callback receives the chunk index and must store its own result.
 */
async function runConcurrent(
  count: number,
  task: (index: number) => Promise<void>,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const concurrency = Math.min(
    count,
    navigator.hardwareConcurrency ?? 4,
    MAX_WORKER_CONCURRENCY,
  );
  let nextIdx = 0;
  let doneCount = 0;

  async function worker(): Promise<void> {
    while (nextIdx < count) {
      const i = nextIdx++;
      await task(i);
      doneCount++;
      onProgress?.(doneCount, count);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

/**
 * Build a 12-byte chunk IV from base_iv (8B) and chunk_index (4B big-endian)
 */
export function buildChunkIV(
  baseIV: Uint8Array,
  chunkIndex: number,
): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(baseIV.slice(0, 8), 0);
  const view = new DataView(iv.buffer, 8, 4);
  view.setUint32(0, chunkIndex, false); // big-endian
  return iv;
}

/**
 * Generate a random 8-byte base IV for chunk encryption
 */
export function generateBaseIV(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(8));
}

/**
 * Create a v2 encrypted file header that embeds wrapped CEK for offline recovery.
 * Format: [1B version=0x02][4B chunk_size][8B base_iv][1B wcek_len][N bytes wrapped_cek]
 */
export function createHeaderV2(
  chunkSize: number,
  baseIV: Uint8Array,
  wrappedCek: Uint8Array,
): Uint8Array {
  const headerSize = HEADER_SIZE + 1 + wrappedCek.byteLength;
  const header = new Uint8Array(headerSize);
  header[0] = CHUNK_VERSION_2;
  const view = new DataView(header.buffer, 1, 4);
  view.setUint32(0, chunkSize, false);
  header.set(baseIV, 5);
  header[13] = wrappedCek.byteLength;
  header.set(wrappedCek, 14);
  return header;
}

/**
 * Parse the encrypted file header (v2 format).
 */
export function parseHeader(data: Uint8Array): {
  version: number;
  chunkSize: number;
  baseIV: Uint8Array;
  wrappedCek: Uint8Array;
  headerSize: number;
} {
  if (data.length < HEADER_SIZE) {
    throw new CryptoError("ファイル形式が不正です（ヘッダが短すぎます）");
  }
  const version = data[0]!;
  if (version !== CHUNK_VERSION_2) {
    throw new CryptoError(`未対応のファイルバージョンです: ${version}`);
  }
  const view = new DataView(data.buffer, data.byteOffset + 1, 4);
  const chunkSize = view.getUint32(0, false);
  if (chunkSize === 0 || chunkSize > 64 * 1024 * 1024) {
    throw new CryptoError(
      "ファイル形式が不正です（チャンクサイズが範囲外です）",
    );
  }
  const baseIV = data.slice(5, 13);

  if (data.length < HEADER_SIZE + 1) {
    throw new CryptoError("ファイル形式が不正です（v2ヘッダが短すぎます）");
  }
  const wcekLen = data[13]!;
  if (data.length < HEADER_SIZE + 1 + wcekLen) {
    throw new CryptoError("ファイル形式が不正です（wrapped CEK が不完全です）");
  }
  const wrappedCek = data.slice(14, 14 + wcekLen);
  return {
    version,
    chunkSize,
    baseIV,
    wrappedCek,
    headerSize: HEADER_SIZE + 1 + wcekLen,
  };
}

/**
 * Encrypt a file (Blob/ArrayBuffer) into the chunked encrypted format.
 * Returns the complete encrypted blob (header + encrypted chunks).
 */
export async function encryptFile(
  key: CryptoKey,
  plaintext: ArrayBuffer,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  onProgress?: (done: number, total: number) => void,
  wrappedCek?: Uint8Array,
): Promise<{ encrypted: Blob; baseIV: Uint8Array }> {
  const baseIV = generateBaseIV();
  const header = createHeaderV2(
    chunkSize,
    baseIV,
    wrappedCek ?? new Uint8Array(0),
  );
  const data = new Uint8Array(plaintext);

  const totalChunks = Math.max(1, Math.ceil(data.length / chunkSize));
  const results = new Array<ArrayBuffer>(totalChunks);

  await runConcurrent(
    totalChunks,
    async (i) => {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, data.length);
      const chunk = data.slice(start, end);
      const iv = buildChunkIV(baseIV, i);
      results[i] = await encryptChunk(key, iv, chunk);
    },
    onProgress,
  );

  const parts: BlobPart[] = [header, ...results];
  return { encrypted: new Blob(parts), baseIV };
}

/**
 * Compute the total encrypted file size without performing encryption.
 * Useful for pre-calculating the size for resumable upload sessions.
 */
export function computeEncryptedSize(
  plaintextSize: number,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  wrappedCekLen = 0,
): number {
  const totalChunks = Math.max(1, Math.ceil(plaintextSize / chunkSize));
  const hdrSize = HEADER_SIZE + 1 + wrappedCekLen;
  return hdrSize + plaintextSize + totalChunks * GCM_TAG_SIZE;
}

/**
 * Streaming file encryption — reads from a File using File.slice() to avoid
 * loading the entire file into memory. Yields encrypted chunks one at a time.
 * The baseIV must be pre-generated so callers can include it in metadata
 * before the stream is consumed.
 */
export async function* encryptFileStreaming(
  key: CryptoKey,
  file: File,
  baseIV: Uint8Array,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  onProgress?: (done: number, total: number) => void,
  wrappedCek?: Uint8Array,
): AsyncGenerator<Uint8Array> {
  const header = createHeaderV2(
    chunkSize,
    baseIV,
    wrappedCek ?? new Uint8Array(0),
  );
  yield header;

  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const slice = file.slice(start, end);
    const plainChunk = new Uint8Array(await slice.arrayBuffer());
    const iv = buildChunkIV(baseIV, i);
    const encrypted = await encryptChunk(key, iv, plainChunk);
    yield encrypted;
    onProgress?.(i + 1, totalChunks);
  }
}

/**
 * Decrypt a file from the chunked encrypted format.
 * Returns the decrypted data.
 */
export async function decryptFile(
  key: CryptoKey,
  ciphertext: ArrayBuffer,
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const data = new Uint8Array(ciphertext);
  const { chunkSize, baseIV, headerSize } = parseHeader(data);

  // Use a view into the original buffer instead of copying to save memory
  const encryptedData = new Uint8Array(
    data.buffer,
    data.byteOffset + headerSize,
    data.byteLength - headerSize,
  );
  const encChunkSize = chunkSize + GCM_TAG_SIZE;
  const totalChunks = Math.max(
    1,
    Math.ceil(encryptedData.length / encChunkSize),
  );

  const decryptedChunks = new Array<Uint8Array>(totalChunks);

  await runConcurrent(
    totalChunks,
    async (i) => {
      const start = i * encChunkSize;
      const end = Math.min(start + encChunkSize, encryptedData.length);
      const chunk = new Uint8Array(
        encryptedData.buffer,
        encryptedData.byteOffset + start,
        end - start,
      );
      const iv = buildChunkIV(baseIV, i);
      decryptedChunks[i] = await decryptChunk(key, iv, chunk);
    },
    onProgress,
  );

  const totalSize = decryptedChunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of decryptedChunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Streaming file decryption — yields decrypted chunks one at a time
 * instead of buffering all chunks in memory. Useful for large files
 * when writing to a File System Access API writable stream.
 */
export async function* decryptFileStreaming(
  key: CryptoKey,
  ciphertext: ArrayBuffer,
  onProgress?: (done: number, total: number) => void,
): AsyncGenerator<Uint8Array> {
  const data = new Uint8Array(ciphertext);
  const { chunkSize, baseIV, headerSize } = parseHeader(data);

  const encryptedData = new Uint8Array(
    data.buffer,
    data.byteOffset + headerSize,
    data.byteLength - headerSize,
  );
  const encChunkSize = chunkSize + GCM_TAG_SIZE;
  const totalChunks = Math.max(
    1,
    Math.ceil(encryptedData.length / encChunkSize),
  );

  for (let i = 0; i < totalChunks; i++) {
    const start = i * encChunkSize;
    const end = Math.min(start + encChunkSize, encryptedData.length);
    const chunk = new Uint8Array(
      encryptedData.buffer,
      encryptedData.byteOffset + start,
      end - start,
    );
    const iv = buildChunkIV(baseIV, i);
    const decrypted = await decryptChunk(key, iv, chunk);
    yield decrypted;
    onProgress?.(i + 1, totalChunks);
  }
}

/**
 * Decrypt a file directly from a ReadableStream without buffering the
 * entire ciphertext in memory. Reads the 13-byte header first, then
 * accumulates exactly one encrypted chunk at a time, decrypts it, and
 * yields the plaintext chunk.
 *
 * Peak memory: ~2× one encrypted chunk (read buffer + decrypt output).
 */
export async function* decryptFileFromStream(
  key: CryptoKey,
  stream: ReadableStream<Uint8Array>,
  totalEncryptedSize: number,
  onProgress?: (done: number, total: number) => void,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();

  // ── Buffered reader helper ──
  // Use a list of pending fragments to avoid O(n²) copying on each network read.
  let fragments: Uint8Array[] = [];
  let fragmentsLen = 0;
  let streamDone = false;

  async function fillAtLeast(n: number): Promise<void> {
    while (fragmentsLen < n && !streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        streamDone = true;
        return;
      }
      fragments.push(value);
      fragmentsLen += value.length;
    }
  }

  /** Merge fragments into a single contiguous buffer (only called once per chunk). */
  function flatten(): Uint8Array {
    if (fragments.length === 0) return new Uint8Array(0);
    if (fragments.length === 1) return fragments[0]!;
    const merged = new Uint8Array(fragmentsLen);
    let pos = 0;
    for (const f of fragments) {
      merged.set(f, pos);
      pos += f.length;
    }
    fragments = [merged];
    return merged;
  }

  function consume(n: number): Uint8Array {
    const flat = flatten();
    const out = flat.slice(0, n);
    if (n >= fragmentsLen) {
      fragments = [];
      fragmentsLen = 0;
    } else {
      fragments = [flat.subarray(n)];
      fragmentsLen -= n;
    }
    return out;
  }

  // ── 1. Read header ──
  // Read the minimum header first, then determine v2 extended header size
  await fillAtLeast(HEADER_SIZE);
  if (fragmentsLen < HEADER_SIZE) {
    throw new CryptoError("ファイル形式が不正です（ヘッダが短すぎます）");
  }

  // Need at least 14 bytes to read wcek_len
  await fillAtLeast(HEADER_SIZE + 1);
  if (fragmentsLen < HEADER_SIZE + 1) {
    throw new CryptoError("ファイル形式が不正です（v2ヘッダが短すぎます）");
  }
  const wcekLen = flatten()[13]!;
  const actualHeaderSize = HEADER_SIZE + 1 + wcekLen;
  await fillAtLeast(actualHeaderSize);
  if (fragmentsLen < actualHeaderSize) {
    throw new CryptoError("ファイル形式が不正です（wrapped CEK が不完全です）");
  }

  const headerBytes = consume(actualHeaderSize);
  const { chunkSize, baseIV, headerSize: hdrSize } = parseHeader(headerBytes);

  const encChunkSize = chunkSize + GCM_TAG_SIZE;
  const encDataSize = totalEncryptedSize > 0 ? totalEncryptedSize - hdrSize : 0;
  const totalChunks =
    encDataSize > 0 ? Math.max(1, Math.ceil(encDataSize / encChunkSize)) : 0;

  // ── 2. Decrypt chunk by chunk ──
  let chunkIndex = 0;
  try {
    for (;;) {
      // Determine expected size of next encrypted chunk
      const remaining =
        encDataSize > 0
          ? encDataSize - chunkIndex * encChunkSize
          : encChunkSize; // If totalSize unknown, try to read a full chunk
      const wantBytes = Math.min(encChunkSize, remaining);

      await fillAtLeast(wantBytes);

      // No more data → we're done
      if (fragmentsLen === 0 && streamDone) break;

      // Take up to one encrypted chunk
      const take = Math.min(fragmentsLen, wantBytes);
      if (take === 0) break;
      const encChunk = consume(take);

      const iv = buildChunkIV(baseIV, chunkIndex);
      const decrypted = await decryptChunk(key, iv, encChunk);
      yield decrypted;

      chunkIndex++;
      onProgress?.(chunkIndex, totalChunks || chunkIndex);

      if (streamDone && fragmentsLen === 0) break;
    }
  } finally {
    reader.releaseLock();
  }
}
