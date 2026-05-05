import { DRIVE_API_BASE } from "@/types";
import { DriveAPIError, isRetryableStatus } from "@/utils/errors";
import {
  acquireRateLimitTokens,
  getAuthHeaders,
  withSupportsAllDrives,
} from "./api";

export interface BatchSubRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

interface BatchSubResponse {
  status: number;
  body: string;
}

const BATCH_MAX = 50;
const BATCH_MAX_RETRIES = 3;

/** Status codes where the sub-request should be retried */
function isRetryableBatchStatus(status: number): boolean {
  return isRetryableStatus(status) || status === 403;
}

/**
 * Execute a batch operation with automatic retry for transient failures.
 * On each iteration, only the sub-requests that failed with retryable status
 * codes are re-sent. Non-retryable failures and ignored statuses are accumulated.
 */
async function batchWithRetry(
  requests: BatchSubRequest[],
  /** Status codes to treat as non-errors (e.g. 404 for already-deleted) */
  ignoreStatuses: number[],
  errorMessage: string,
  onChunkDone?: (completedSoFar: number) => void,
): Promise<void> {
  const chunks = chunkArray(requests, BATCH_MAX);
  let completedSoFar = 0;
  for (const chunk of chunks) {
    let pending = chunk;
    for (let attempt = 0; attempt <= BATCH_MAX_RETRIES; attempt++) {
      const responses = await batchRequest(pending);

      // Separate retryable and non-retryable failures
      const retryable: BatchSubRequest[] = [];
      const failures: BatchSubResponse[] = [];
      for (let i = 0; i < responses.length; i++) {
        const r = responses[i]!;
        if (r.status < 400 || ignoreStatuses.includes(r.status)) continue;
        if (isRetryableBatchStatus(r.status) && attempt < BATCH_MAX_RETRIES) {
          retryable.push(pending[i]!);
        } else {
          failures.push(r);
        }
      }

      if (failures.length > 0) {
        throw new DriveAPIError(
          `${failures.length}${errorMessage}`,
          failures[0]!.status,
        );
      }

      if (retryable.length === 0) break;

      // Exponential backoff before retrying
      const delay = 1000 * 2 ** attempt + Math.random() * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      pending = retryable;
    }
    completedSoFar += chunk.length;
    onChunkDone?.(completedSoFar);
  }
}

/**
 * Send up to 100 sub-requests in a single HTTP call using Drive batch API.
 * Returns an array of responses in the same order as the requests.
 */
export async function batchRequest(
  requests: BatchSubRequest[],
): Promise<BatchSubResponse[]> {
  if (requests.length === 0) return [];
  if (requests.length > BATCH_MAX) {
    throw new Error(
      `Batch supports up to ${BATCH_MAX} requests, got ${requests.length}`,
    );
  }

  const boundary = `batch_${crypto.randomUUID()}`;
  // Acquire rate-limit tokens: each sub-request counts toward the per-user quota
  await acquireRateLimitTokens(requests.length);
  const authHeaders = await getAuthHeaders();

  const parts = requests.map((req, i) => {
    const path = withSupportsAllDrives(req.path);
    let sub = `${req.method} ${path} HTTP/1.1\r\n`;
    sub += "Content-Type: application/json\r\n";
    if (req.body !== undefined) {
      sub += `\r\n${JSON.stringify(req.body)}`;
    } else {
      sub += "\r\n";
    }
    return `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${i}>\r\n\r\n${sub}`;
  });
  const payload = `${parts.join("\r\n")}\r\n--${boundary}--`;

  const response = await fetch(`${DRIVE_API_BASE}/batch/drive/v3`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": `multipart/mixed; boundary=${boundary}`,
    },
    body: payload,
  });

  if (!response.ok) {
    throw new DriveAPIError(
      `Batch request failed: ${response.status} ${response.statusText}`,
      response.status,
    );
  }

  const responseText = await response.text();
  return parseBatchResponse(
    responseText,
    response.headers.get("content-type") || "",
  );
}

function parseBatchResponse(
  body: string,
  contentType: string,
): BatchSubResponse[] {
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) return [];
  const boundary = boundaryMatch[1]?.trim();

  const parts = body
    .split(`--${boundary}`)
    .filter((p) => p.trim() && p.trim() !== "--");
  const results: BatchSubResponse[] = [];

  for (const part of parts) {
    const httpStart = part.indexOf("HTTP/");
    if (httpStart === -1) continue;
    const httpPart = part.slice(httpStart);
    const statusLine = httpPart.split("\r\n")[0] || "";
    const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
    const status = statusMatch ? Number.parseInt(statusMatch[1]!, 10) : 500;

    const bodyStart = httpPart.indexOf("\r\n\r\n");
    const responseBody =
      bodyStart !== -1 ? httpPart.slice(bodyStart + 4).trim() : "";

    results.push({ status, body: responseBody });
  }

  return results;
}

/**
 * Trash multiple files in a single batch request.
 * Falls back to individual requests if batch exceeds limit.
 */
export async function trashFiles(
  fileIds: string[],
  onChunkDone?: (completedSoFar: number) => void,
): Promise<void> {
  await batchWithRetry(
    fileIds.map((id) => ({
      method: "PATCH" as const,
      path: `/drive/v3/files/${encodeURIComponent(id)}`,
      body: { trashed: true },
    })),
    [404],
    "件のファイルのゴミ箱移動に失敗しました",
    onChunkDone,
  );
}

/**
 * Trash multiple files/folders, ignoring 403 (for drive.file scope folder issues).
 */
export async function trashFilesSafe(
  fileIds: string[],
  onChunkDone?: (completedSoFar: number) => void,
): Promise<void> {
  await batchWithRetry(
    fileIds.map((id) => ({
      method: "PATCH" as const,
      path: `/drive/v3/files/${encodeURIComponent(id)}`,
      body: { trashed: true },
    })),
    [403, 404],
    "件のフォルダのゴミ箱移動に失敗しました",
    onChunkDone,
  );
}

/**
 * Untrash multiple files in a single batch request.
 */
export async function untrashFiles(fileIds: string[]): Promise<void> {
  await batchWithRetry(
    fileIds.map((id) => ({
      method: "PATCH" as const,
      path: `/drive/v3/files/${encodeURIComponent(id)}`,
      body: { trashed: false },
    })),
    [],
    "件のファイルの復元に失敗しました",
  );
}

/**
 * Permanently delete multiple files in a single batch request.
 */
export async function deleteFiles(
  fileIds: string[],
  onChunkDone?: (completedSoFar: number) => void,
): Promise<void> {
  await batchWithRetry(
    fileIds.map((id) => ({
      method: "DELETE" as const,
      path: `/drive/v3/files/${encodeURIComponent(id)}`,
    })),
    [404],
    "件のファイルの削除に失敗しました",
    onChunkDone,
  );
}

/**
 * Permanently delete multiple files/folders, ignoring 403 (for drive.file scope folder issues).
 */
export async function deleteFilesSafe(
  fileIds: string[],
  onChunkDone?: (completedSoFar: number) => void,
): Promise<void> {
  await batchWithRetry(
    fileIds.map((id) => ({
      method: "DELETE" as const,
      path: `/drive/v3/files/${encodeURIComponent(id)}`,
    })),
    [403, 404],
    "件のフォルダの削除に失敗しました",
    onChunkDone,
  );
}

/**
 * Move multiple files to a new parent in a single batch request.
 */
export async function moveFiles(
  moves: { fileId: string; oldParentId: string; newParentId: string }[],
): Promise<void> {
  await batchWithRetry(
    moves.map((m) => ({
      method: "PATCH" as const,
      path: `/drive/v3/files/${encodeURIComponent(m.fileId)}?addParents=${encodeURIComponent(m.newParentId)}&removeParents=${encodeURIComponent(m.oldParentId)}`,
    })),
    [],
    "件のファイルの移動に失敗しました",
  );
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
