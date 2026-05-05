import {
  MULTIPART_BOUNDARY_PREFIX,
  RESUMABLE_CHUNK_SIZE,
  RESUMABLE_UPLOAD_THRESHOLD_BYTES,
} from "@/config/app";
import { DRIVE_API_BASE } from "@/types";
import type { DriveFile, DriveFileList, DrivePermission } from "@/types";
import { DriveAPIError, isRetryableStatus, withRetry } from "@/utils/errors";
import { TokenBucket } from "@/utils/rateLimiter";

type TokenProvider = () => Promise<string>;

let _getToken: TokenProvider | null = null;
let _onInsufficientScope: (() => void) | null = null;

/**
 * Global rate limiter for Drive API requests.
 * Google Drive quota: ~1,000 requests / 100 seconds / user.
 * Burst of 10 allows short spikes; refill of 10/s sustains throughput.
 */
const apiRateLimiter = new TokenBucket(10, 10);

const MAX_RESUMABLE_SESSION_RESTARTS = 2;

type DriveErrorDetails = {
  message: string | null;
  reason: string | null;
};

type ResumableUploadStartMethod = "POST" | "PATCH";

type ResumableUploadResult =
  | { kind: "continue"; nextOffset: number }
  | { kind: "complete"; file: DriveFile }
  | { kind: "restart"; errorMessage?: string; status?: number };

export function setTokenProvider(provider: TokenProvider): void {
  _getToken = provider;
}

export function setOnInsufficientScope(callback: (() => void) | null): void {
  _onInsufficientScope = callback;
}

export async function getAuthHeaders(): Promise<HeadersInit> {
  if (!_getToken) throw new DriveAPIError("認証されていません", 401);
  const token = await _getToken();
  return { Authorization: `Bearer ${token}` };
}

function getRetryDelay(attempt: number): number {
  return 1000 * 2 ** attempt + Math.random() * 1000;
}

function getUploadContentType(content: Blob): string {
  return content.type || "application/octet-stream";
}

export function withSupportsAllDrives(path: string): string {
  const [rawBasePath, query = ""] = path.split("?");
  const basePath = rawBasePath || path;
  const params = new URLSearchParams(query);
  params.set("supportsAllDrives", "true");
  const nextQuery = params.toString();
  return nextQuery ? `${basePath}?${nextQuery}` : basePath;
}

function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("Retry-After");
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}

function parseResumableRange(rangeHeader: string | null): number | null {
  if (!rangeHeader) return null;
  const match = /bytes=0-(\d+)/i.exec(rangeHeader.trim());
  if (!match) return null;

  const lastByte = Number(match[1]);
  if (!Number.isFinite(lastByte) || lastByte < 0) {
    return null;
  }

  return lastByte + 1;
}

function isRetryableResumable403(reason: string | null): boolean {
  return (
    reason === null ||
    [
      "dailyLimitExceeded",
      "rateLimitExceeded",
      "sharingRateLimitExceeded",
      "userRateLimitExceeded",
    ].includes(reason)
  );
}

async function parseDriveErrorDetails(
  response: Response,
): Promise<DriveErrorDetails> {
  try {
    const text = await response.text();
    if (!text) {
      return { message: null, reason: null };
    }

    try {
      const parsed = JSON.parse(text) as {
        error?: {
          message?: string;
          errors?: Array<{ reason?: string; message?: string }>;
        };
      };
      const firstError = parsed.error?.errors?.[0];
      return {
        message: parsed.error?.message || firstError?.message || null,
        reason: firstError?.reason || null,
      };
    } catch {
      return {
        message: text.trim() || null,
        reason: null,
      };
    }
  } catch {
    return { message: null, reason: null };
  }
}

function buildDriveErrorMessage(
  context: string,
  response: Response,
  details: DriveErrorDetails,
): string {
  const parts = [
    details.message || response.statusText || `HTTP ${response.status}`,
  ];
  if (details.reason) {
    parts.push(`reason=${details.reason}`);
  }
  return `${context}: ${parts.join(" ")}`;
}

async function startResumableSession(
  metadata: Partial<DriveFile>,
  content: Blob,
): Promise<string> {
  return startResumableSessionRequest(
    withSupportsAllDrives("/drive/v3/files?uploadType=resumable"),
    "POST",
    metadata,
    getUploadContentType(content),
    content.size,
  );
}

async function startResumableSessionRequest(
  path: string,
  method: ResumableUploadStartMethod,
  metadata: Partial<DriveFile> | undefined,
  contentType: string,
  contentLength: number,
): Promise<string> {
  await apiRateLimiter.acquire();
  const authHeaders = await getAuthHeaders();
  const hasMetadata = metadata !== undefined;
  const resp = await fetch(`${DRIVE_API_BASE}/upload${path}`, {
    method,
    headers: {
      ...authHeaders,
      ...(hasMetadata
        ? { "Content-Type": "application/json; charset=UTF-8" }
        : {}),
      "X-Upload-Content-Type": contentType,
      "X-Upload-Content-Length": String(contentLength),
    },
    ...(hasMetadata ? { body: JSON.stringify(metadata) } : {}),
  });

  if (!resp.ok) {
    const details = await parseDriveErrorDetails(resp);
    throw new DriveAPIError(
      buildDriveErrorMessage("Resumable upload init failed", resp, details),
      resp.status,
    );
  }

  const uri = resp.headers.get("Location");
  if (!uri) throw new DriveAPIError("No session URI returned", 500);

  // セキュリティ: URI のオリジンが Google であることを検証
  try {
    assertValidResumableUri(uri);
  } catch (e) {
    if (e instanceof DriveAPIError) throw e;
    throw new DriveAPIError("Invalid resumable session URI", 400);
  }

  return uri;
}

function assertValidResumableUri(uri: string): void {
  const parsed = new URL(uri);
  const ALLOWED_HOSTS = /^([-\w]+\.)?googleapis\.com$/;
  if (!ALLOWED_HOSTS.test(parsed.hostname)) {
    throw new DriveAPIError("Invalid resumable session URI origin", 403);
  }
  if (parsed.protocol !== "https:") {
    throw new DriveAPIError("Invalid resumable session URI protocol", 403);
  }
}

async function queryResumableUploadStatus(
  sessionUri: string,
  total: number,
): Promise<ResumableUploadResult> {
  assertValidResumableUri(sessionUri);
  const authHeaders = await getAuthHeaders();
  const resp = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      ...authHeaders,
      "Content-Range": `bytes */${total}`,
    },
  });

  if (resp.status === 308) {
    return {
      kind: "continue",
      nextOffset: parseResumableRange(resp.headers.get("Range")) ?? 0,
    };
  }

  if (resp.ok) {
    return {
      kind: "complete",
      file: (await resp.json()) as DriveFile,
    };
  }

  if ([401, 403, 404, 410].includes(resp.status)) {
    const details = await parseDriveErrorDetails(resp);
    return {
      kind: "restart",
      errorMessage: buildDriveErrorMessage(
        "Resumable upload status query failed",
        resp,
        details,
      ),
      status: resp.status,
    };
  }

  const details = await parseDriveErrorDetails(resp);
  throw new DriveAPIError(
    buildDriveErrorMessage(
      "Resumable upload status query failed",
      resp,
      details,
    ),
    resp.status,
  );
}

/**
 * Acquire multiple rate-limit tokens (one per sub-request in a batch).
 * Each sub-request in a Drive batch counts toward the per-user quota.
 */
export async function acquireRateLimitTokens(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await apiRateLimiter.acquire();
  }
}

async function driveRequest<T>(
  path: string,
  options: RequestInit = {},
  isUpload = false,
): Promise<T> {
  await apiRateLimiter.acquire();
  const base = isUpload ? `${DRIVE_API_BASE}/upload` : DRIVE_API_BASE;
  const url = `${base}${path}`;
  const authHeaders = await getAuthHeaders();

  const response = await fetch(url, {
    ...options,
    headers: {
      ...authHeaders,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const details = await parseDriveErrorDetails(response);
    const error = new DriveAPIError(
      buildDriveErrorMessage("Drive API request failed", response, details),
      response.status,
      parseRetryAfterMs(response),
      details.reason ?? undefined,
    );
    // スコープ不足を検出した場合、再認証コールバックを呼ぶ
    if (
      response.status === 403 &&
      details.reason === "insufficientPermissions" &&
      _onInsufficientScope
    ) {
      _onInsufficientScope();
    }
    throw error;
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as T;
  }
  return (await response.arrayBuffer()) as T;
}

// ── File Operations ──

export async function listFiles(
  query: string,
  fields = "files(id,name,mimeType,size,modifiedTime,parents,appProperties)",
  pageToken?: string,
): Promise<DriveFileList> {
  const params = new URLSearchParams({
    q: query,
    fields: pageToken ? `nextPageToken,${fields}` : fields,
    spaces: "drive",
    pageSize: "1000",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (pageToken) params.set("pageToken", pageToken);

  return withRetry(() =>
    driveRequest<DriveFileList>(`/drive/v3/files?${params.toString()}`),
  );
}

export async function listAllFiles(
  query: string,
  fields?: string,
): Promise<DriveFile[]> {
  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const result = await listFiles(query, fields, pageToken);
    allFiles.push(...result.files);
    pageToken = result.nextPageToken;
  } while (pageToken);

  return allFiles;
}

export async function getFileMetadata(
  fileId: string,
  fields = "id,name,mimeType,size,modifiedTime,description,appProperties",
): Promise<DriveFile> {
  return withRetry(() =>
    driveRequest<DriveFile>(
      `/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}`,
    ),
  );
}

export async function getFileContent(fileId: string): Promise<ArrayBuffer> {
  return withRetry(async () => {
    const url = `${DRIVE_API_BASE}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const response = await fetch(url, { headers: await getAuthHeaders() });
    if (!response.ok) {
      const details = await parseDriveErrorDetails(response);
      throw new DriveAPIError(
        buildDriveErrorMessage("Drive API request failed", response, details),
        response.status,
        parseRetryAfterMs(response),
      );
    }
    return response.arrayBuffer();
  });
}

export async function getFileContentWithProgress(
  fileId: string,
  onProgress: (loaded: number, total: number) => void,
  expectedTotal?: number,
): Promise<ArrayBuffer> {
  const url = `${DRIVE_API_BASE}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const response = await withRetry(async () => {
    const headers = await getAuthHeaders();
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new DriveAPIError(
        `Drive API error: ${resp.status}`,
        resp.status,
        parseRetryAfterMs(resp),
      );
    }
    return resp;
  });
  const headerTotal = Number(
    response.headers.get("content-length") ||
      response.headers.get("x-goog-stored-content-length") ||
      0,
  );
  const total = headerTotal > 0 ? headerTotal : (expectedTotal ?? 0);
  if (!response.body) {
    return response.arrayBuffer();
  }
  const reader = response.body.getReader();

  // When total size is known, write directly into a pre-allocated buffer
  // to avoid holding both the chunk array and the consolidated copy.
  if (total > 0) {
    const result = new Uint8Array(total);
    let offset = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // If the response is larger than expected, we need to re-allocate
      if (offset + value.length > result.length) {
        const bigger = new Uint8Array(offset + value.length);
        bigger.set(result.subarray(0, offset));
        bigger.set(value, offset);
        offset += value.length;
        onProgress(offset, Math.max(offset, total));
        // Fall through to chunk-based accumulation for remaining data
        const chunks: Uint8Array[] = [bigger];
        let loaded = offset;
        for (;;) {
          const { done: d2, value: v2 } = await reader.read();
          if (d2) break;
          chunks.push(v2);
          loaded += v2.length;
          onProgress(loaded, Math.max(loaded, total));
        }
        const final = new Uint8Array(loaded);
        let pos = 0;
        for (const c of chunks) {
          final.set(c, pos);
          pos += c.length;
        }
        return final.buffer;
      }
      result.set(value, offset);
      offset += value.length;
      onProgress(Math.min(offset, total), total);
    }
    if (offset < total) onProgress(total, total);
    // If the actual data was smaller than expected (rare), return a view
    return offset === result.length
      ? result.buffer
      : result.slice(0, offset).buffer;
  }

  // Unknown total: accumulate chunks
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
  }
  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

/**
 * Download a file as a ReadableStream for memory-efficient processing.
 * Returns the stream and the total size (0 if unknown).
 */
export async function getFileContentAsStream(
  fileId: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ stream: ReadableStream<Uint8Array>; total: number }> {
  const url = `${DRIVE_API_BASE}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const response = await withRetry(async () => {
    const headers = await getAuthHeaders();
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new DriveAPIError(
        `Drive API error: ${resp.status}`,
        resp.status,
        parseRetryAfterMs(resp),
      );
    }
    return resp;
  });
  const total = Number(
    response.headers.get("content-length") ||
      response.headers.get("x-goog-stored-content-length") ||
      0,
  );
  if (!response.body) {
    // Fallback: wrap arrayBuffer in a stream
    const buf = await response.arrayBuffer();
    return {
      stream: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new Uint8Array(buf));
          ctrl.close();
        },
      }),
      total: buf.byteLength,
    };
  }
  if (!onProgress) {
    return { stream: response.body, total };
  }
  // Wrap with progress reporting
  let loaded = 0;
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      loaded += value.length;
      onProgress(loaded, total);
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel();
    },
  });
  return { stream, total };
}

export async function createFileMultipart(
  metadata: Partial<DriveFile>,
  content?: Blob | Uint8Array,
  onProgress?: (loaded: number, total: number) => void,
): Promise<DriveFile> {
  if (!content) {
    // Metadata only (folder creation)
    return withRetry(() =>
      driveRequest<DriveFile>(withSupportsAllDrives("/drive/v3/files"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
      }),
    );
  }

  const contentBlob = content instanceof Blob ? content : new Blob([content]);

  // Use resumable upload for files > 4MB (multipart has a 5MB limit)
  if (contentBlob.size > RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
    return createFileResumable(metadata, contentBlob, onProgress);
  }

  const boundary = `${MULTIPART_BOUNDARY_PREFIX}${crypto.randomUUID()}`;

  const metadataStr = JSON.stringify(metadata);
  const metadataPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataStr}\r\n`;
  const endPart = `\r\n--${boundary}--`;

  const body = new Blob([
    metadataPart,
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    contentBlob,
    endPart,
  ]);

  const result = await withRetry(() =>
    driveRequest<DriveFile>(
      withSupportsAllDrives("/drive/v3/files?uploadType=multipart"),
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
      true,
    ),
  );
  onProgress?.(contentBlob.size, contentBlob.size);
  return result;
}

/**
 * Resumable upload for large files.
 * 1) Initiate a resumable session (with retry)
 * 2) Upload the content in chunks with Content-Range (with per-chunk retry)
 */
async function uploadChunkWithRetry(
  sessionUri: string,
  chunk: Blob,
  offset: number,
  total: number,
  contentType: string,
  maxRetries = 3,
): Promise<ResumableUploadResult> {
  assertValidResumableUri(sessionUri);
  const end = offset + chunk.size;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const authHeaders = await getAuthHeaders();
      const resp = await fetch(sessionUri, {
        method: "PUT",
        headers: {
          ...authHeaders,
          "Content-Type": contentType,
          "Content-Range": `bytes ${offset}-${end - 1}/${total}`,
        },
        body: chunk,
      });

      if (resp.ok) {
        return {
          kind: "complete",
          file: (await resp.json()) as DriveFile,
        };
      }

      if (resp.status === 308) {
        return {
          kind: "continue",
          nextOffset: parseResumableRange(resp.headers.get("Range")) ?? end,
        };
      }

      const details = await parseDriveErrorDetails(resp);

      if (
        resp.status === 403 &&
        isRetryableResumable403(details.reason) &&
        attempt < maxRetries
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, getRetryDelay(attempt)),
        );
        continue;
      }

      if (
        attempt < maxRetries &&
        ([401, 403, 404, 410].includes(resp.status) ||
          isRetryableStatus(resp.status) ||
          resp.status >= 500)
      ) {
        const statusResult = await queryResumableUploadStatus(
          sessionUri,
          total,
        );
        if (statusResult.kind === "restart" && !statusResult.errorMessage) {
          return {
            kind: "restart",
            errorMessage: buildDriveErrorMessage(
              "Resumable upload chunk failed",
              resp,
              details,
            ),
            status: resp.status,
          };
        }
        return statusResult;
      }

      throw new DriveAPIError(
        buildDriveErrorMessage("Resumable upload chunk failed", resp, details),
        resp.status,
      );
    } catch (e) {
      if (e instanceof DriveAPIError) throw e;

      if (attempt >= maxRetries) {
        throw e;
      }

      const status = await queryResumableUploadStatus(sessionUri, total).catch(
        () => null,
      );
      if (status) {
        return status;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, getRetryDelay(attempt)),
      );
    }
  }

  return { kind: "restart" };
}

async function createFileResumable(
  metadata: Partial<DriveFile>,
  content: Blob,
  onProgress?: (loaded: number, total: number) => void,
): Promise<DriveFile> {
  let sessionUri = await withRetry(() =>
    startResumableSession(metadata, content),
  );
  const contentType = getUploadContentType(content);
  const total = content.size;
  let offset = 0;
  let restartCount = 0;
  let lastRestartError: string | null = null;
  let lastRestartStatus = 500;

  while (offset < total) {
    const end = Math.min(offset + RESUMABLE_CHUNK_SIZE, total);
    const chunk = content.slice(offset, end);

    const result = await uploadChunkWithRetry(
      sessionUri,
      chunk,
      offset,
      total,
      contentType,
    );

    if (result.kind === "complete") {
      onProgress?.(total, total);
      return result.file;
    }

    if (result.kind === "restart") {
      if (result.errorMessage) {
        lastRestartError = result.errorMessage;
      }
      if (result.status) {
        lastRestartStatus = result.status;
      }
      restartCount += 1;
      if (restartCount > MAX_RESUMABLE_SESSION_RESTARTS) {
        throw new DriveAPIError(
          lastRestartError || "Resumable upload session could not be recovered",
          lastRestartStatus,
        );
      }

      sessionUri = await withRetry(() =>
        startResumableSession(metadata, content),
      );
      offset = 0;
      onProgress?.(0, total);
      continue;
    }

    offset = result.nextOffset;
    onProgress?.(offset, total);
  }

  throw new DriveAPIError(
    lastRestartError || "Resumable upload: unexpected end",
    lastRestartStatus,
  );
}

/**
 * Streaming resumable upload from an async iterable of Uint8Array chunks.
 * Buffers encrypted data internally and uploads in RESUMABLE_CHUNK_SIZE-aligned
 * pieces so the entire file never needs to be held in memory at once.
 */
export async function createFileResumableFromStream(
  metadata: Partial<DriveFile>,
  totalSize: number,
  createSource: () => AsyncIterable<Uint8Array>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<DriveFile> {
  const placeholder = await createFileMultipart(metadata, new Uint8Array(0));

  try {
    return await updateFileResumableFromStream(
      placeholder.id,
      totalSize,
      createSource,
      onProgress,
    );
  } catch (error) {
    await deleteFile(placeholder.id).catch((e) =>
      console.warn("Cleanup: failed to delete placeholder", e),
    );
    throw error;
  }
}

async function updateFileResumableFromStream(
  fileId: string,
  totalSize: number,
  createSource: () => AsyncIterable<Uint8Array>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<DriveFile> {
  const contentType = "application/octet-stream";
  let restartCount = 0;
  let lastRestartError: string | null = null;
  let lastRestartStatus = 500;
  const uploadPath = withSupportsAllDrives(
    `/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=resumable`,
  );

  while (restartCount <= MAX_RESUMABLE_SESSION_RESTARTS) {
    const sessionUri = await withRetry(() =>
      startResumableSessionRequest(
        uploadPath,
        "PATCH",
        undefined,
        contentType,
        totalSize,
      ),
    );

    let buffer: Uint8Array[] = [];
    let bufferedBytes = 0;
    let uploadOffset = 0;

    const flush = async (
      isFinal: boolean,
    ): Promise<ResumableUploadResult | null> => {
      if (bufferedBytes === 0) return null;

      const sendSize = isFinal
        ? bufferedBytes
        : Math.floor(bufferedBytes / RESUMABLE_CHUNK_SIZE) *
          RESUMABLE_CHUNK_SIZE;
      if (sendSize === 0) {
        return null;
      }

      const fullBlob = new Blob(buffer as BlobPart[]);
      const sendBlob =
        sendSize === bufferedBytes ? fullBlob : fullBlob.slice(0, sendSize);

      const result = await uploadChunkWithRetry(
        sessionUri,
        sendBlob,
        uploadOffset,
        totalSize,
        contentType,
      );

      if (result.kind === "restart") {
        return result;
      }

      if (result.kind === "complete") {
        onProgress?.(totalSize, totalSize);
        return result;
      }

      const consumed = result.nextOffset - uploadOffset;
      if (consumed < 0 || consumed > bufferedBytes) {
        return { kind: "restart" };
      }

      uploadOffset = result.nextOffset;
      onProgress?.(uploadOffset, totalSize);

      if (consumed >= bufferedBytes) {
        buffer = [];
        bufferedBytes = 0;
      } else {
        // Concatenate remaining data into a single Uint8Array to avoid
        // keeping references to already-uploaded chunks in memory.
        const fullBuf = new Uint8Array(bufferedBytes);
        let pos = 0;
        for (const b of buffer) {
          fullBuf.set(b, pos);
          pos += b.length;
        }
        buffer = [fullBuf.slice(consumed)];
        bufferedBytes = fullBuf.length - consumed;
      }

      return result;
    };

    let shouldRestart = false;

    for await (const chunk of createSource()) {
      buffer.push(chunk);
      bufferedBytes += chunk.length;

      if (bufferedBytes >= RESUMABLE_CHUNK_SIZE) {
        const result = await flush(false);
        if (result?.kind === "complete") {
          return result.file;
        }
        if (result?.kind === "restart") {
          if (result.errorMessage) {
            lastRestartError = result.errorMessage;
          }
          if (result.status) {
            lastRestartStatus = result.status;
          }
          shouldRestart = true;
          break;
        }
      }
    }

    if (!shouldRestart) {
      while (bufferedBytes > 0) {
        const result = await flush(true);
        if (!result) {
          break;
        }
        if (result.kind === "complete") {
          return result.file;
        }
        if (result.kind === "restart") {
          if (result.errorMessage) {
            lastRestartError = result.errorMessage;
          }
          if (result.status) {
            lastRestartStatus = result.status;
          }
          shouldRestart = true;
          break;
        }
      }
    }

    if (!shouldRestart) {
      throw new DriveAPIError(
        "Streaming resumable upload: unexpected end",
        500,
      );
    }

    restartCount += 1;
    if (restartCount > MAX_RESUMABLE_SESSION_RESTARTS) {
      throw new DriveAPIError(
        lastRestartError || "Resumable upload session could not be recovered",
        lastRestartStatus,
      );
    }

    onProgress?.(0, totalSize);
  }

  throw new DriveAPIError(
    lastRestartError || "Resumable upload session could not be recovered",
    lastRestartStatus,
  );
}

export async function updateFileMetadata(
  fileId: string,
  metadata: Omit<Partial<DriveFile>, "appProperties"> & {
    appProperties?: Record<string, string | null>;
  },
): Promise<DriveFile> {
  return withRetry(() =>
    driveRequest<DriveFile>(
      withSupportsAllDrives(`/drive/v3/files/${encodeURIComponent(fileId)}`),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
      },
    ),
  );
}

export async function updateFileWithContent(
  fileId: string,
  metadata: Partial<DriveFile>,
  content: Blob | Uint8Array,
): Promise<DriveFile> {
  const boundary = `${MULTIPART_BOUNDARY_PREFIX}${crypto.randomUUID()}`;

  const metadataStr = JSON.stringify(metadata);
  const metadataPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataStr}\r\n`;
  const endPart = `\r\n--${boundary}--`;

  const contentBlob = content instanceof Blob ? content : new Blob([content]);

  const body = new Blob([
    metadataPart,
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    contentBlob,
    endPart,
  ]);

  return withRetry(() =>
    driveRequest<DriveFile>(
      withSupportsAllDrives(
        `/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart`,
      ),
      {
        method: "PATCH",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
      true,
    ),
  );
}

export async function trashFile(fileId: string): Promise<void> {
  await withRetry(() =>
    driveRequest<DriveFile>(
      withSupportsAllDrives(`/drive/v3/files/${encodeURIComponent(fileId)}`),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      },
    ),
  );
}

export async function untrashFile(fileId: string): Promise<void> {
  await withRetry(() =>
    driveRequest<DriveFile>(
      withSupportsAllDrives(`/drive/v3/files/${encodeURIComponent(fileId)}`),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: false }),
      },
    ),
  );
}

export async function moveFile(
  fileId: string,
  addParents: string,
  removeParents: string,
): Promise<DriveFile> {
  const params = new URLSearchParams({
    addParents,
    removeParents,
    supportsAllDrives: "true",
  });
  return withRetry(() =>
    driveRequest<DriveFile>(
      `/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    ),
  );
}

/**
 * Google Drive files.copy API でファイルを複製する。
 * フォルダは Drive API では直接コピーできないため、呼び出し側で再帰処理する。
 */
export async function copyFile(
  fileId: string,
  destParentId: string,
  name?: string,
  appProperties?: Record<string, string>,
): Promise<DriveFile> {
  const params = new URLSearchParams({
    supportsAllDrives: "true",
    fields: "id,name,mimeType,parents,size,modifiedTime,appProperties",
  });
  const body: Record<string, unknown> = { parents: [destParentId] };
  if (name !== undefined) body.name = name;
  if (appProperties) body.appProperties = appProperties;
  return withRetry(() =>
    driveRequest<DriveFile>(
      `/drive/v3/files/${encodeURIComponent(fileId)}/copy?${params.toString()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

export async function deleteFile(fileId: string): Promise<void> {
  await withRetry(() =>
    driveRequest<void>(
      withSupportsAllDrives(`/drive/v3/files/${encodeURIComponent(fileId)}`),
      {
        method: "DELETE",
      },
    ),
  );
}

// ── Permissions ──

export async function createPermission(
  fileId: string,
  permission: Partial<DrivePermission>,
): Promise<DrivePermission> {
  const params = new URLSearchParams({
    supportsAllDrives: "true",
    sendNotificationEmail: "false",
  });
  return withRetry(() =>
    driveRequest<DrivePermission>(
      `/drive/v3/files/${encodeURIComponent(fileId)}/permissions?${params.toString()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(permission),
      },
    ),
  );
}

export async function deletePermission(
  fileId: string,
  permissionId: string,
): Promise<void> {
  await withRetry(() =>
    driveRequest<void>(
      withSupportsAllDrives(
        `/drive/v3/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
      ),
      { method: "DELETE" },
    ),
  );
}

export async function listPermissions(
  fileId: string,
): Promise<DrivePermission[]> {
  const result = await withRetry(() =>
    driveRequest<{ permissions: DrivePermission[] }>(
      withSupportsAllDrives(
        `/drive/v3/files/${encodeURIComponent(fileId)}/permissions?fields=permissions(id,type,role,emailAddress,expirationTime)`,
      ),
    ),
  );
  return result.permissions;
}

// ── Batch API (re-exported from batch.ts) ──
export {
  batchRequest,
  trashFiles,
  untrashFiles,
  deleteFiles,
  moveFiles,
} from "./batch";
export type { BatchSubRequest } from "./batch";
