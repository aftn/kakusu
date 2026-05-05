import { RESUMABLE_UPLOAD_THRESHOLD_BYTES } from "@/config/app";
import {
  createFileMultipart,
  createFileResumableFromStream,
  getFileContentWithProgress,
  setTokenProvider,
} from "@/drive/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Drive resumable uploads", () => {
  beforeEach(() => {
    setTokenProvider(async () => "test-token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries resumable chunk uploads on 403 rate limit errors", async () => {
    vi.useFakeTimers();

    const sessionUri =
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-1";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { Location: sessionUri },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: "Rate Limit Exceeded",
              errors: [{ reason: "rateLimitExceeded" }],
            },
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 308,
          headers: { Range: "bytes=0-8388607" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "file-1",
            name: "large.enc",
            mimeType: "application/octet-stream",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    const uploadPromise = createFileMultipart(
      {
        name: "large.enc",
        mimeType: "application/octet-stream",
      },
      new Blob([new Uint8Array(9 * 1024 * 1024)]),
    );

    await vi.runAllTimersAsync();
    const created = await uploadPromise;

    expect(created.id).toBe("file-1");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const initHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    const firstChunkHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    const retryChunkHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<
      string,
      string
    >;
    const finalChunkHeaders = fetchMock.mock.calls[3]?.[1]?.headers as Record<
      string,
      string
    >;

    expect(initHeaders.Authorization).toBe("Bearer test-token");
    expect(firstChunkHeaders.Authorization).toBe("Bearer test-token");
    expect(retryChunkHeaders.Authorization).toBe("Bearer test-token");
    expect(finalChunkHeaders.Authorization).toBe("Bearer test-token");
    expect(firstChunkHeaders["Content-Type"]).toBe("application/octet-stream");
    expect(firstChunkHeaders["Content-Range"]).toBe("bytes 0-8388607/9437184");
    expect(retryChunkHeaders["Content-Range"]).toBe("bytes 0-8388607/9437184");
    expect(finalChunkHeaders["Content-Range"]).toBe(
      "bytes 8388608-9437183/9437184",
    );
  });

  it("restarts the resumable session when Google invalidates it", async () => {
    const firstSessionUri =
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-1";
    const secondSessionUri =
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-2";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { Location: firstSessionUri },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 404,
              message: "Upload session expired",
            },
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { Location: secondSessionUri },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "file-2",
            name: "retry.enc",
            mimeType: "application/octet-stream",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    const created = await createFileMultipart(
      {
        name: "retry.enc",
        mimeType: "application/octet-stream",
      },
      new Blob([new Uint8Array(RESUMABLE_UPLOAD_THRESHOLD_BYTES + 1024)]),
    );

    expect(created.id).toBe("file-2");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(firstSessionUri);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(firstSessionUri);
    expect(fetchMock.mock.calls[3]?.[0]).toContain("uploadType=resumable");
    expect(fetchMock.mock.calls[4]?.[0]).toBe(secondSessionUri);

    const statusHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(statusHeaders.Authorization).toBe("Bearer test-token");
    expect(statusHeaders["Content-Range"]).toBe(
      `bytes */${RESUMABLE_UPLOAD_THRESHOLD_BYTES + 1024}`,
    );
  });

  it("recreates the source stream when a streaming resumable session must restart", async () => {
    const placeholderId = "placeholder-1";
    const firstSessionUri =
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=stream-session-1";
    const secondSessionUri =
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=stream-session-2";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: placeholderId,
            name: "stream-retry.enc",
            mimeType: "application/octet-stream",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { Location: firstSessionUri },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: "Forbidden",
              errors: [{ reason: "insufficientFilePermissions" }],
            },
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { Location: secondSessionUri },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "file-stream-1",
            name: "stream-retry.enc",
            mimeType: "application/octet-stream",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    const createSource = vi.fn(async function* () {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5]);
    });

    const created = await createFileResumableFromStream(
      {
        name: "stream-retry.enc",
        mimeType: "application/octet-stream",
      },
      5,
      createSource,
    );

    expect(created.id).toBe("file-stream-1");
    expect(createSource).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      `/drive/v3/files/${placeholderId}?uploadType=resumable&supportsAllDrives=true`,
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(firstSessionUri);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(firstSessionUri);
    expect(fetchMock.mock.calls[4]?.[0]).toContain(
      `/drive/v3/files/${placeholderId}?uploadType=resumable&supportsAllDrives=true`,
    );
    expect(fetchMock.mock.calls[5]?.[0]).toBe(secondSessionUri);

    const retryHeaders = fetchMock.mock.calls[5]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(retryHeaders.Authorization).toBe("Bearer test-token");
    expect(retryHeaders["Content-Range"]).toBe("bytes 0-4/5");
  });

  it("uses the expected size when content-length is unavailable during downloads", async () => {
    const progress = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const buffer = await getFileContentWithProgress("file-1", progress, 4);

    expect(Array.from(new Uint8Array(buffer))).toEqual([1, 2, 3, 4]);
    expect(progress).toHaveBeenNthCalledWith(1, 2, 4);
    expect(progress).toHaveBeenNthCalledWith(2, 4, 4);
  });
});
