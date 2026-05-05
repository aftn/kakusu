import { loadPreviewCacheMode } from "@/cache/settings";

/** In-memory preview blob cache keyed by driveId */
const cache = new Map<string, { blobUrl: string; mimeType: string }>();

const MAX_CACHE_SIZE = 30;

function isPreviewCacheEnabled(): boolean {
  return loadPreviewCacheMode() === "memory";
}

export function getCachedPreview(
  driveId: string,
): { blobUrl: string; mimeType: string } | null {
  if (!isPreviewCacheEnabled()) return null;
  return cache.get(driveId) ?? null;
}

export function setCachedPreview(
  driveId: string,
  blobUrl: string,
  mimeType: string,
): void {
  if (!isPreviewCacheEnabled()) {
    URL.revokeObjectURL(blobUrl);
    return;
  }
  // Evict oldest entry if at capacity
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value as string;
    const old = cache.get(firstKey);
    if (old) URL.revokeObjectURL(old.blobUrl);
    cache.delete(firstKey);
  }
  cache.set(driveId, { blobUrl, mimeType });
}

export function hasCachedPreview(driveId: string): boolean {
  if (!isPreviewCacheEnabled()) return false;
  return cache.has(driveId);
}

export function clearPreviewCache(): void {
  for (const entry of cache.values()) {
    URL.revokeObjectURL(entry.blobUrl);
  }
  cache.clear();
}

export function getCachedIds(): Set<string> {
  if (!isPreviewCacheEnabled()) return new Set();
  return new Set(cache.keys());
}
