import { ZipWriter, buildZip } from "@/utils/zip";
import { describe, expect, it } from "vitest";

describe("buildZip", () => {
  it("marks filenames as UTF-8 in both ZIP headers", async () => {
    const path = "共有/日本語ファイル.txt";
    const data = new Uint8Array([1, 2, 3, 4]);
    const pathBytes = new TextEncoder().encode(path);
    const blob = buildZip([{ path, data }]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);

    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);

    const centralOffset = 30 + pathBytes.length + data.byteLength;
    expect(view.getUint16(centralOffset + 8, true) & 0x0800).toBe(0x0800);
  });

  it("sanitizes directory traversal paths", async () => {
    const entries = [
      { path: "../../../etc/passwd", data: new Uint8Array([1]) },
      { path: "safe/./file.txt", data: new Uint8Array([2]) },
      { path: "a/../b/file.txt", data: new Uint8Array([3]) },
      { path: "normal/path/file.txt", data: new Uint8Array([4]) },
    ];
    const blob = buildZip(entries);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder().decode(bytes);

    // Traversal components should be stripped
    expect(text).not.toContain("..");
    expect(text).toContain("etc/passwd");
    expect(text).toContain("safe/file.txt");
    expect(text).toContain("b/file.txt");
    expect(text).toContain("normal/path/file.txt");
  });

  it("skips entries with empty paths after sanitization", async () => {
    const entries = [
      { path: "..", data: new Uint8Array([1]) },
      { path: ".", data: new Uint8Array([2]) },
      { path: "valid.txt", data: new Uint8Array([3]) },
    ];
    const blob = buildZip(entries);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder().decode(bytes);

    expect(text).toContain("valid.txt");
    // ".." and "." should produce empty paths and be skipped
    expect(text).not.toContain("..");
  });
});

describe("ZipWriter", () => {
  it("produces valid ZIP via addEntry (blob mode)", async () => {
    const writer = ZipWriter.forBlob();
    await writer.addEntry("hello.txt", new TextEncoder().encode("Hello"));
    await writer.addEntry("sub/world.txt", new TextEncoder().encode("World"));
    const blob = await writer.finish();
    expect(blob).not.toBeNull();
    const bytes = new Uint8Array(await blob!.arrayBuffer());

    // Should contain both filenames
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("hello.txt");
    expect(text).toContain("sub/world.txt");

    // Local header signature at offset 0
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
  });

  it("produces valid ZIP via addEntryStreaming (blob mode)", async () => {
    const writer = ZipWriter.forBlob();
    const chunks = (async function* () {
      yield new TextEncoder().encode("chunk1");
      yield new TextEncoder().encode("chunk2");
    })();
    await writer.addEntryStreaming("streamed.txt", chunks);
    const blob = await writer.finish();
    expect(blob).not.toBeNull();
    const bytes = new Uint8Array(await blob!.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("streamed.txt");
    // Data should be present
    expect(text).toContain("chunk1");
    expect(text).toContain("chunk2");

    // Data descriptor flag (bit 3) should be set in local header general purpose flags
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(6, true) & 0x0008).toBe(0x0008);
  });

  it("produces valid ZIP via stream mode", async () => {
    const written: Uint8Array[] = [];
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(chunk);
      },
    });
    const streamWriter = stream.getWriter();
    const zipWriter = ZipWriter.forStream(streamWriter);
    await zipWriter.addEntry("a.bin", new Uint8Array([10, 20, 30]));
    await zipWriter.finish();

    // Concatenate all written chunks
    const totalLen = written.reduce((a, b) => a + b.byteLength, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of written) {
      result.set(c, offset);
      offset += c.byteLength;
    }

    // Should start with local header signature
    const view = new DataView(result.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // Should end with EOCD signature
    expect(view.getUint32(result.byteLength - 22, true)).toBe(0x06054b50);
  });

  it("matches buildZip output for identical input", async () => {
    const data1 = new TextEncoder().encode("test data one");
    const data2 = new TextEncoder().encode("test data two");

    const legacyBlob = buildZip([
      { path: "file1.txt", data: data1 },
      { path: "dir/file2.txt", data: data2 },
    ]);

    const writer = ZipWriter.forBlob();
    await writer.addEntry("file1.txt", data1);
    await writer.addEntry("dir/file2.txt", data2);
    const writerBlob = await writer.finish();

    const legacyBytes = new Uint8Array(await legacyBlob.arrayBuffer());
    const writerBytes = new Uint8Array(await writerBlob!.arrayBuffer());

    // Both should produce identical bytes (same STORE method, same flags)
    expect(writerBytes).toEqual(legacyBytes);
  });
});
