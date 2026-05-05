/**
 * Sanitize a ZIP entry path to prevent directory traversal attacks.
 * Removes "..", ".", leading slashes, and backslashes.
 */
function sanitizeZipPath(path: string): string {
  return path
    .split(/[/\\]/)
    .filter((p) => p && p !== "." && p !== "..")
    .join("/");
}

/**
 * Build a ZIP file from an array of { path, data } entries.
 * Uses STORE (no compression) for simplicity and speed.
 * Supports paths with '/' separators for directory structure.
 */
export function buildZip(
  entries: Array<{ path: string; data: Uint8Array }>,
): Blob {
  const localHeaders: Uint8Array[] = [];
  const centralHeaders: Uint8Array[] = [];
  let offset = 0;
  const utf8Flag = 1 << 11;

  for (const entry of entries) {
    const safePath = sanitizeZipPath(entry.path);
    if (!safePath) continue; // Skip entries with empty paths after sanitization
    const pathBytes = new TextEncoder().encode(safePath);
    const crc = crc32(entry.data);
    const size = entry.data.byteLength;

    // Local file header (30 + pathBytes.length + data)
    const localHeader = new ArrayBuffer(30 + pathBytes.length);
    const lv = new DataView(localHeader);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, utf8Flag, true); // flags (UTF-8 filename)
    lv.setUint16(8, 0, true); // compression: STORE
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true); // crc32
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, pathBytes.length, true); // filename length
    lv.setUint16(28, 0, true); // extra field length
    new Uint8Array(localHeader).set(pathBytes, 30);

    localHeaders.push(new Uint8Array(localHeader));
    localHeaders.push(entry.data);

    // Central directory header (46 + pathBytes.length)
    const centralHeader = new ArrayBuffer(46 + pathBytes.length);
    const cv = new DataView(centralHeader);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, utf8Flag, true); // flags (UTF-8 filename)
    cv.setUint16(10, 0, true); // compression
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true); // crc32
    cv.setUint32(20, size, true); // compressed size
    cv.setUint32(24, size, true); // uncompressed size
    cv.setUint16(28, pathBytes.length, true); // filename length
    cv.setUint16(30, 0, true); // extra field length
    cv.setUint16(32, 0, true); // file comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal file attributes
    cv.setUint32(38, 0, true); // external file attributes
    cv.setUint32(42, offset, true); // relative offset of local header
    new Uint8Array(centralHeader).set(pathBytes, 46);

    centralHeaders.push(new Uint8Array(centralHeader));

    offset += 30 + pathBytes.length + size;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const h of centralHeaders) centralDirSize += h.byteLength;

  // End of central directory record (22 bytes)
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true); // signature
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // central dir disk
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralDirSize, true); // size of central directory
  ev.setUint32(16, centralDirOffset, true); // offset of central directory
  ev.setUint16(20, 0, true); // comment length

  const blobParts = [
    ...localHeaders,
    ...centralHeaders,
    new Uint8Array(eocd),
  ].map((part) => new Uint8Array(part));

  return new Blob(blobParts, {
    type: "application/zip",
  });
}

/**
 * CRC-32 lookup table
 */
const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index masked to 0-255 range
    crc = crc32Table[(crc ^ (data[i] ?? 0)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Incremental CRC-32 calculator for streaming data.
 */
class CRC32Stream {
  private crc = 0xffffffff;

  update(data: Uint8Array): void {
    let c = this.crc;
    for (let i = 0; i < data.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: index masked to 0-255 range
      c = crc32Table[(c ^ (data[i] ?? 0)) & 0xff]! ^ (c >>> 8);
    }
    this.crc = c;
  }

  finish(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}

interface CentralEntry {
  pathBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

/**
 * Streaming ZIP writer that processes one file at a time.
 *
 * For WritableStream output (File System Access API):
 * writes directly, keeping only ~1 file's data in memory at a time.
 *
 * For Blob output (fallback):
 * accumulates BlobParts but callers can release their references early.
 */
export class ZipWriter {
  private centralEntries: CentralEntry[] = [];
  private offset = 0;
  private readonly utf8Flag = 1 << 11;

  // WritableStream mode
  private writable: WritableStreamDefaultWriter<Uint8Array> | null = null;
  // Blob mode
  private blobParts: BlobPart[] | null = null;

  private constructor() {}

  /**
   * Create a ZipWriter that writes directly to a WritableStream.
   * Only one file's data is in memory at a time.
   */
  static forStream(
    writable: WritableStreamDefaultWriter<Uint8Array>,
  ): ZipWriter {
    const w = new ZipWriter();
    w.writable = writable;
    return w;
  }

  /**
   * Create a ZipWriter that accumulates BlobParts.
   * Use when WritableStream is not available.
   */
  static forBlob(): ZipWriter {
    const w = new ZipWriter();
    w.blobParts = [];
    return w;
  }

  /**
   * Add a complete file entry (non-streaming).
   */
  async addEntry(path: string, data: Uint8Array): Promise<void> {
    const safePath = sanitizeZipPath(path);
    if (!safePath) return;
    const pathBytes = new TextEncoder().encode(safePath);
    const crcVal = crc32(data);
    const size = data.byteLength;

    const localHeader = this.buildLocalHeader(pathBytes, crcVal, size);
    await this.write(localHeader);
    await this.write(data);

    this.centralEntries.push({
      pathBytes,
      crc: crcVal,
      size,
      offset: this.offset,
    });
    this.offset += localHeader.byteLength + size;
  }

  /**
   * Add a file entry from an async iterable of chunks.
   * Uses data descriptors so CRC/size are computed and written after the data.
   * This keeps memory usage to one chunk at a time.
   */
  async addEntryStreaming(
    path: string,
    chunks: AsyncIterable<Uint8Array>,
    knownSize?: number,
  ): Promise<void> {
    const safePath = sanitizeZipPath(path);
    if (!safePath) return;
    const pathBytes = new TextEncoder().encode(safePath);

    // Local file header with data descriptor flag (bit 3).
    // CRC and sizes are 0 here; real values follow the data.
    const localHeader = this.buildLocalHeader(pathBytes, 0, 0, true);
    await this.write(localHeader);

    const crcStream = new CRC32Stream();
    let size = 0;
    for await (const chunk of chunks) {
      crcStream.update(chunk);
      size += chunk.byteLength;
      await this.write(chunk);
    }
    const crcVal = crcStream.finish();

    if (knownSize !== undefined && size !== knownSize) {
      throw new Error(
        `ZIP entry size mismatch: expected ${knownSize}, got ${size}`,
      );
    }

    // Data descriptor (no signature variant is 12 bytes,
    // but the common 16-byte form with signature is more compatible)
    const dd = new ArrayBuffer(16);
    const dv = new DataView(dd);
    dv.setUint32(0, 0x08074b50, true); // data descriptor signature
    dv.setUint32(4, crcVal, true);
    dv.setUint32(8, size, true); // compressed size
    dv.setUint32(12, size, true); // uncompressed size
    await this.write(new Uint8Array(dd));

    this.centralEntries.push({
      pathBytes,
      crc: crcVal,
      size,
      offset: this.offset,
    });
    this.offset += localHeader.byteLength + size + 16;
  }

  /**
   * Finalize the ZIP. Returns a Blob in blob mode, or null in stream mode.
   */
  async finish(): Promise<Blob | null> {
    // Compute total central directory size and write as single buffer
    let centralDirSize = 0;
    for (const e of this.centralEntries) {
      centralDirSize += 46 + e.pathBytes.length;
    }

    const centralBuf = new Uint8Array(centralDirSize);
    let pos = 0;
    for (const e of this.centralEntries) {
      const header = this.buildCentralHeader(e);
      centralBuf.set(header, pos);
      pos += header.byteLength;
    }
    await this.write(centralBuf);

    const eocd = new ArrayBuffer(22);
    const ev = new DataView(eocd);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, this.centralEntries.length, true);
    ev.setUint16(10, this.centralEntries.length, true);
    ev.setUint32(12, centralDirSize, true);
    ev.setUint32(16, this.offset, true);
    ev.setUint16(20, 0, true);
    await this.write(new Uint8Array(eocd));

    if (this.writable) {
      await this.writable.close();
      return null;
    }

    if (!this.blobParts) throw new Error("ZipWriter not initialized");
    return new Blob(this.blobParts, { type: "application/zip" });
  }

  private buildLocalHeader(
    pathBytes: Uint8Array,
    crcVal: number,
    size: number,
    useDataDescriptor = false,
  ): Uint8Array {
    const buf = new ArrayBuffer(30 + pathBytes.length);
    const v = new DataView(buf);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, this.utf8Flag | (useDataDescriptor ? 0x0008 : 0), true);
    v.setUint16(8, 0, true); // STORE
    v.setUint16(10, 0, true);
    v.setUint16(12, 0, true);
    v.setUint32(14, crcVal, true);
    v.setUint32(18, size, true);
    v.setUint32(22, size, true);
    v.setUint16(26, pathBytes.length, true);
    v.setUint16(28, 0, true);
    new Uint8Array(buf).set(pathBytes, 30);
    return new Uint8Array(buf);
  }

  private buildCentralHeader(e: CentralEntry): Uint8Array {
    const buf = new ArrayBuffer(46 + e.pathBytes.length);
    const v = new DataView(buf);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 20, true);
    v.setUint16(8, this.utf8Flag, true);
    v.setUint16(10, 0, true); // STORE
    v.setUint16(12, 0, true);
    v.setUint16(14, 0, true);
    v.setUint32(16, e.crc, true);
    v.setUint32(20, e.size, true);
    v.setUint32(24, e.size, true);
    v.setUint16(28, e.pathBytes.length, true);
    v.setUint16(30, 0, true);
    v.setUint16(32, 0, true);
    v.setUint16(34, 0, true);
    v.setUint16(36, 0, true);
    v.setUint32(38, 0, true);
    v.setUint32(42, e.offset, true);
    new Uint8Array(buf).set(e.pathBytes, 46);
    return new Uint8Array(buf);
  }

  private async write(data: Uint8Array): Promise<void> {
    if (this.writable) {
      await this.writable.write(data);
    } else {
      this.blobParts?.push(data);
    }
  }
}
